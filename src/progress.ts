// The current task list, rebuilt from Claude's own todo and task tool calls
// as `tool.call` saw them: TodoWrite replaces the whole list, TaskCreate adds
// an item, TaskUpdate changes or deletes one, TaskList re-reads them all.
// Each item keeps when it was first seen running and first seen done, from
// the calls' own times, so the list can say how long is left at its own pace.
// Pure; the adapter hands each finished call in as plain data.

import { clip } from './format'
import { maskSecrets } from './mask'
import { median, MINUTE } from './metrics'

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = {
  id: string
  title: string
  /** What the spinner says while it runs ("Writing tests"). */
  active?: string
  status: TaskStatus
  /** When a call first showed it in progress. */
  startedAt?: number
  /** When a call first showed it completed; gone again if it reopens. */
  doneAt?: number
  /** How long it waited on the person while it ran, which its length leaves out; set as it finishes. */
  heldMs?: number
}

export type TaskList = {
  source: 'todo' | 'task'
  items: Task[]
  /** The turn number that last changed it. */
  turn: number
  updatedAt: number
}

const MAX_TASKS = 100
const MAX_TITLE = 200

/** A title or spinner text as kept: masked, then cut. */
const kept = (text: string): string => clip(maskSecrets(text), MAX_TITLE)

const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed']

function asStatus(x: unknown): TaskStatus | undefined {
  return typeof x === 'string' && (STATUSES as readonly string[]).includes(x) ? (x as TaskStatus) : undefined
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x.trim() !== '' ? x : undefined
}

function obj(x: unknown): Record<string, unknown> | undefined {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined
}

/** An item as a call at `at` shows it, its times carried over from what it was before. */
function timed(item: Task, before: Task | undefined, at: number): Task {
  const { startedAt: _s, doneAt: _d, heldMs: _h, ...rest } = item
  const startedAt = before?.startedAt ?? (item.status === 'in_progress' ? at : undefined)
  const doneAt = item.status !== 'completed' ? undefined : before?.status === 'completed' ? before.doneAt : at
  // A task still done keeps the time it waited; one that reopens measures it again when it finishes.
  const heldMs = doneAt !== undefined && before?.status === 'completed' ? before.heldMs : undefined
  return { ...rest, ...(startedAt !== undefined ? { startedAt } : {}), ...(doneAt !== undefined ? { doneAt } : {}), ...(heldMs !== undefined ? { heldMs } : {}) }
}

/** A finished todo or task tool call, as the adapter hands it over. */
export type TaskCall = {
  tool: string
  input: Record<string, unknown>
  /** The tool's record (`result` from `next(e)`), when it answered without error. */
  result?: unknown
  isError: boolean
}

export const TASK_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'])

/** The list after one call; the same list when the call changes nothing. */
export function applyTaskCall(list: TaskList | undefined, call: TaskCall, turn: number, at: number): TaskList | undefined {
  if (call.isError || !TASK_TOOLS.has(call.tool)) return list
  switch (call.tool) {
    case 'TodoWrite': {
      const todos = Array.isArray(call.input.todos) ? call.input.todos : undefined
      if (!todos) return list
      // A rewrite of the list: each item finds what it was by its words, its times kept.
      const was = new Map<string, Task[]>()
      for (const item of list?.source === 'todo' ? list.items : []) was.set(item.title, [...(was.get(item.title) ?? []), item])
      const items: Task[] = []
      todos.slice(0, MAX_TASKS).forEach((raw, i) => {
        const t = obj(raw)
        const title = str(t?.content)
        const status = asStatus(t?.status)
        if (!title || !status) return
        const active = str(t?.activeForm)
        const item: Task = { id: `todo-${i}`, title: kept(title), status, ...(active ? { active: kept(active) } : {}) }
        items.push(timed(item, was.get(item.title)?.shift(), at))
      })
      return { source: 'todo', items, turn, updatedAt: at }
    }
    case 'TaskCreate': {
      const task = obj(obj(call.result)?.task)
      const id = str(task?.id)
      const title = str(call.input.subject) ?? str(task?.subject)
      if (!id || !title) return list
      const active = str(call.input.activeForm)
      const base = list?.source === 'task' ? list.items : []
      const created: Task = { id, title: kept(title), status: 'pending', ...(active ? { active: kept(active) } : {}) }
      const items = [...base.filter(item => item.id !== id), created]
      return { source: 'task', items: items.slice(-MAX_TASKS), turn, updatedAt: at }
    }
    case 'TaskUpdate': {
      const result = obj(call.result)
      if (result?.success === false) return list
      const id = str(call.input.taskId) ?? str(result?.taskId)
      if (!id) return list
      const status = call.input.status
      const base = list?.source === 'task' ? list.items : []
      if (status === 'deleted') {
        if (!base.some(item => item.id === id)) return list
        return { source: 'task', items: base.filter(item => item.id !== id), turn, updatedAt: at }
      }
      const known = base.find(item => item.id === id)
      const subject = str(call.input.subject)
      const active = str(call.input.activeForm)
      const next = timed(
        {
          id,
          title: kept(subject ?? known?.title ?? `#${id}`),
          status: asStatus(status) ?? known?.status ?? 'pending',
          ...(active ? { active: kept(active) } : known?.active ? { active: known.active } : {}),
        },
        known,
        at,
      )
      const items = known ? base.map(item => (item.id === id ? next : item)) : [...base, next]
      return { source: 'task', items: items.slice(-MAX_TASKS), turn, updatedAt: at }
    }
    case 'TaskList': {
      const tasks = obj(call.result)?.tasks
      if (!Array.isArray(tasks)) return list
      const before = new Map((list?.source === 'task' ? list.items : []).map(item => [item.id, item]))
      const items: Task[] = []
      for (const raw of tasks.slice(0, MAX_TASKS)) {
        const t = obj(raw)
        const id = str(t?.id)
        const title = str(t?.subject)
        const status = asStatus(t?.status)
        if (!id || !title || !status) continue
        const active = before.get(id)?.active
        items.push(timed({ id, title: kept(title), status, ...(active ? { active } : {}) }, before.get(id), at))
      }
      return { source: 'task', items, turn, updatedAt: at }
    }
  }
  return list
}

export type Progress = {
  done: number
  total: number
  /** The item in progress, else the next pending one. */
  current?: Task
  isCurrentRunning: boolean
  isComplete: boolean
}

export function progressOf(list: TaskList | undefined): Progress | undefined {
  if (!list || list.items.length === 0) return undefined
  const done = list.items.filter(item => item.status === 'completed').length
  const running = list.items.find(item => item.status === 'in_progress')
  const pending = list.items.find(item => item.status === 'pending')
  const current = running ?? pending
  return {
    done,
    total: list.items.length,
    ...(current ? { current } : {}),
    isCurrentRunning: running !== undefined,
    isComplete: done === list.items.length,
  }
}

/**
 * Whether the list is still worth showing: an open list always is; a
 * finished one until a later turn starts.
 */
export function isListLive(list: TaskList | undefined, turnNumber: number): boolean {
  const p = progressOf(list)
  if (!list || !p) return false
  return !p.isComplete || turnNumber <= list.turn
}

/** Completed tasks with a known length needed before the list says how long is left. */
export const MIN_DONE_FOR_ESTIMATE = 2
/** Past this the estimate would be no help: it is not shown. */
const MAX_ESTIMATE_MS = 12 * 60 * MINUTE

/**
 * How long the open tasks will take at this list's own pace: the median
 * length of its completed tasks (each from first seen running to first seen
 * done), times the tasks still open, less what the running one has had.
 * Undefined until 2 tasks have a known length, and wherever the result would
 * be nonsense: nothing open, already overrun, or over 12 hours.
 */
export function timeLeft(list: TaskList | undefined, now: number): number | undefined {
  if (!list) return undefined
  const lengths: number[] = []
  for (const t of list.items) {
    if (t.status === 'completed' && t.startedAt !== undefined && t.doneAt !== undefined && t.doneAt >= t.startedAt) lengths.push(t.doneAt - t.startedAt)
  }
  if (lengths.length < MIN_DONE_FOR_ESTIMATE) return undefined
  const typical = median(lengths)
  const open = list.items.filter(t => t.status !== 'completed').length
  if (typical === undefined || typical <= 0 || open === 0) return undefined
  const running = list.items.find(t => t.status === 'in_progress')
  const spent = running?.startedAt !== undefined ? Math.max(0, now - running.startedAt) : 0
  const left = typical * open - spent
  return left > 0 && left <= MAX_ESTIMATE_MS ? left : undefined
}
