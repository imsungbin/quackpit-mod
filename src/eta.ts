// How long the work in hand will take, from measured lengths alone: the task
// list at its own pace (or, before two of its tasks have finished, at the
// pace of your recent tasks, this session's and the last week's), each of
// Claude's subagents at the usual length of its type, and each background job
// at its command's usual length; with the AI ETA on, its answer for the rest
// of the turn joins them. Things that run at once end at the latest of them,
// so the whole is the last expected end, never a sum. Everything is counted
// in working time: a wait on the person moves the ends on. Every estimate is
// shown with a `~`. Pure.

import type { CheckKind } from './checks'
import { isJobRunning, jobPace, OPEN_HOLD_MS, type CheckLength, type CommandLengths } from './jobs'
import { median, MINUTE } from './metrics'
import type { AgentRun, Cockpit } from './model'
import { isListLive, progressOf, type TaskList } from './progress'
import { activeMs } from './waits'

/**
 * Finished lengths, in milliseconds: tasks (first seen running to first seen
 * done), subagents by type, and the main turns themselves (as their end
 * reported them; an interrupted turn is no sample).
 */
export type Durations = { tasks: number[]; agents: Record<string, number[]>; turns: number[] }

/**
 * Agents whose work is Claude's own and so part of the estimate: those the
 * main loop started (or a workflow it ran), not a plugin's or another agent's.
 */
export function isCounted(a: Pick<AgentRun, 'by'>): boolean {
  return a.by === undefined || a.by === 'main' || a.by === 'workflow'
}

/** Working now: running in the foreground or the background (a teammate between turns is not). */
export function isAgentOpen(a: Pick<AgentRun, 'status'>): boolean {
  return a.status === 'running' || a.status === 'background'
}

export const KEEP_TASK_LENGTHS = 40
export const KEEP_AGENT_LENGTHS = 12
export const KEEP_AGENT_TYPES = 12
export const KEEP_TURN_LENGTHS = 60
/** Lengths from other sessions kept for the estimate: the most recent first. */
export const KEEP_PRIOR_TASKS = 120
export const KEEP_PRIOR_AGENTS = 30
export const KEEP_PRIOR_TURNS = 500

/** This list's finished tasks needed before its own pace is used. */
export const MIN_LIST_SAMPLES = 2
/** Recent tasks (earlier lists, other sessions) needed before they stand in for the list's own pace. */
export const MIN_RECENT_SAMPLES = 3
/** Finished runs of a subagent type needed before its usual length is used. */
export const MIN_AGENT_SAMPLES = 2
/**
 * A task or subagent past its usual length is given a little more, half its
 * usual length and a minute at most: when it ends is not known, and a fixed
 * minute would push a list of 20-second tasks back each time one starts.
 */
export const AT_LEAST_MS = MINUTE
export const graceOf = (usualMs: number) => Math.min(AT_LEAST_MS, usualMs / 2)
/** Past this the estimate would be no help: it is not shown. */
export const MAX_ESTIMATE_MS = 12 * 60 * MINUTE
/** Shorter than this a length is a replay or a blip, not work (a rebuilt transcript gives every call one time). */
const MIN_LENGTH_MS = 5000

export function emptyDurations(): Durations {
  return { tasks: [], agents: {}, turns: [] }
}

const isLength = (ms: number) => Number.isFinite(ms) && ms >= MIN_LENGTH_MS && ms <= MAX_ESTIMATE_MS
/** A turn's length: a quick answer is a turn too, so from a second; a day at most. */
export const isTurnLength = (ms: unknown): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms >= 1000 && ms <= 24 * 60 * MINUTE
const lastN = <T>(xs: readonly T[], n: number): T[] => xs.slice(Math.max(0, xs.length - n))

/** The turn lengths with one more finished turn, the oldest past the limit dropped. */
export function noteTurn(turns: readonly number[], ms: number): number[] {
  return isTurnLength(ms) ? lastN([...turns, ms], KEEP_TURN_LENGTHS) : [...turns]
}

/** A task's length once it is done, when both its times are known: its waits on the person left out. */
function taskLength(t: TaskList['items'][number]): number | undefined {
  return t.status === 'completed' && t.startedAt !== undefined && t.doneAt !== undefined ? Math.max(0, t.doneAt - t.startedAt - (t.heldMs ?? 0)) : undefined
}

/** A subagent's length once it is done: its own report, else its launch to its end; its waits on the person left out. */
function agentLength(a: AgentRun): number | undefined {
  if (a.status !== 'done' || a.replayed || a.seenLate) return undefined
  const whole = a.durationMs ?? (a.endedAt !== undefined ? a.endedAt - a.startedAt : undefined)
  return whole === undefined ? undefined : Math.max(0, whole - (a.heldMs ?? 0))
}

/**
 * The lengths a change finished: tasks that became done and subagents that
 * ended well, added to what the session had. A task list rewritten by a
 * later TodoWrite keeps what it measured before.
 */
export function noteLengths(before: Cockpit, after: Cockpit): Durations {
  let { tasks, agents } = after.durations
  const wasDone = new Set((before.tasks?.items ?? []).filter(t => t.status === 'completed').map(t => t.id))
  const fresh = (after.tasks?.items ?? []).filter(t => !wasDone.has(t.id)).map(taskLength).filter((ms): ms is number => ms !== undefined && isLength(ms))
  if (fresh.length > 0) tasks = lastN([...tasks, ...fresh], KEEP_TASK_LENGTHS)
  const ended = new Set(before.agents.filter(a => a.status === 'done').map(a => a.id))
  for (const a of after.agents) {
    if (ended.has(a.id)) continue
    const ms = agentLength(a)
    if (ms === undefined || !isLength(ms)) continue
    // The type just used goes last, so past the limit the longest unused goes first.
    const { [a.type]: had, ...rest } = agents
    const entries: [string, number[]][] = [...Object.entries(rest), [a.type, lastN([...(had ?? []), ms], KEEP_AGENT_LENGTHS)]]
    agents = Object.fromEntries(entries.slice(Math.max(0, entries.length - KEEP_AGENT_TYPES)))
  }
  return tasks === after.durations.tasks && agents === after.durations.agents ? after.durations : { ...after.durations, tasks, agents }
}

const lengths = (x: unknown): number[] => (Array.isArray(x) ? x.filter((n): n is number => typeof n === 'number' && isLength(n)) : [])

/**
 * Stored lengths read back defensively: anything else is none. A record from
 * before turns were kept (cockpit version 7) has no `turns`: `history` stands in for them,
 * its turns' own lengths, the interrupted ones left out.
 */
export function asDurations(x: unknown, history?: unknown): Durations | undefined {
  if (typeof x !== 'object' || x === null) return undefined
  const d = x as { tasks?: unknown; agents?: unknown; turns?: unknown }
  if (!Array.isArray(d.tasks) || typeof d.agents !== 'object' || d.agents === null || Array.isArray(d.agents)) return undefined
  const agents = Object.fromEntries(Object.entries(d.agents as Record<string, unknown>).map(([type, xs]) => [type, lengths(xs)]))
  return { tasks: lengths(d.tasks), agents, turns: Array.isArray(d.turns) ? d.turns.filter(isTurnLength) : turnsOfHistory(history) }
}

/** The lengths of a history's finished turns, oldest first: the interrupted ones are no sample. */
export function turnsOfHistory(history: unknown): number[] {
  if (!Array.isArray(history)) return []
  const out: number[] = []
  for (const h of history) {
    const turn = h as { durationMs?: unknown; aborted?: unknown } | null
    if (turn && turn.aborted !== true && isTurnLength(turn.durationMs)) out.push(turn.durationMs)
  }
  return lastN(out, KEEP_TURN_LENGTHS)
}

/** Lengths from other sessions, newest session first, as the estimate's stand-in until this one has its own. */
export function priorsOf(sessions: readonly Durations[]): Durations {
  const tasks: number[] = []
  const agents: Record<string, number[]> = {}
  const turns: number[] = []
  for (const d of sessions) {
    tasks.push(...[...d.tasks].reverse())
    turns.push(...[...d.turns].reverse())
    for (const [type, lengths] of Object.entries(d.agents)) (agents[type] ??= []).push(...[...lengths].reverse())
  }
  return {
    tasks: tasks.filter(isLength).slice(0, KEEP_PRIOR_TASKS),
    agents: Object.fromEntries(Object.entries(agents).map(([type, lengths]) => [type, lengths.filter(isLength).slice(0, KEEP_PRIOR_AGENTS)])),
    turns: turns.filter(isTurnLength).slice(0, KEEP_PRIOR_TURNS),
  }
}

/** Where a task's pace comes from: this list's own finished tasks, or your recent ones. */
export type PaceBasis = 'list' | 'recent'
export type TaskPace = { ms: number; basis: PaceBasis; samples: number }

/** The length a task of this list is expected to take, and from what. */
export function taskPace(c: Cockpit, priors?: Durations): TaskPace | undefined {
  const own = (c.tasks?.items ?? []).map(taskLength).filter((ms): ms is number => ms !== undefined && isLength(ms))
  if (own.length >= MIN_LIST_SAMPLES) return { ms: median(own) ?? 0, basis: 'list', samples: own.length }
  const recent = [...c.durations.tasks, ...(priors?.tasks ?? [])]
  if (recent.length >= MIN_RECENT_SAMPLES) return { ms: median(recent) ?? 0, basis: 'recent', samples: recent.length }
  return undefined
}

/** A subagent type's usual length, from this session's finished runs of it and the last week's. */
export function agentPace(type: string, c: Cockpit, priors?: Durations): { ms: number; samples: number } | undefined {
  const lengths = [...(c.durations.agents[type] ?? []), ...(priors?.agents[type] ?? [])]
  if (lengths.length < MIN_AGENT_SAMPLES) return undefined
  return { ms: median(lengths) ?? 0, samples: lengths.length }
}

/** Every subagent run's length, of any type, this session's and the last week's: for a type never seen finish. */
export function anyAgentPace(c: Cockpit, priors?: Durations): { ms: number; samples: number } | undefined {
  const lengths = [...Object.values(c.durations.agents).flat(), ...Object.values(priors?.agents ?? {}).flat()]
  if (lengths.length < MIN_AGENT_SAMPLES) return undefined
  return { ms: median(lengths) ?? 0, samples: lengths.length }
}

/** When an open task, agent or job is expected to run: from its start (or the one before it) to its expected end. */
export type Stretch = { id: string; from: number; to: number }
/** An agent's expected end: from its type's usual length, or, for a type never seen finish, from every type's. */
export type AgentEta = Stretch & { typicalMs: number; basis: 'type' | 'any'; samples: number }
/** A background job's expected end: from its command's last runs, or its kind of check's. */
export type JobEta = Stretch & { typicalMs: number; basis: 'command' | 'kind'; samples: number; kind?: CheckKind }

/**
 * The AI ETA's latest answer, as one part of the whole: the end it implies
 * for the rest of the turn (its answer in the turn's working time from when
 * it was asked, so a wait on the person since moves it on), the whole turn's
 * length that implies, whether the turn has run past it, and the first answer
 * where this one revises it.
 */
export type AiPart = { n: number; askedAt: number; leftMs: number; to: number; wholeMs: number; isOver: boolean; saidAt: number; first?: { leftMs: number } }

/** Work running with no expected end (no length known for it): shown, adding nothing to the time. */
export type OpenItem = { kind: 'agent' | 'job'; id: string; from: number }

export type Eta = {
  /** When the work began: the crossing's start, or the first task's or the first open part's. */
  startedAt: number
  /** When it is expected to be done: the latest expected end. */
  endsAt: number
  leftMs: number
  /** How far across: the work done over the whole, in the main loop's working time, 0 to 1. */
  fraction: number
  /** The list is done and nothing it waits on runs. */
  isDone: boolean
  tasks?: { pace: TaskPace; open: number; stretches: Stretch[] }
  agents: AgentEta[]
  jobs: JobEta[]
  ai?: AiPart
  /** The part whose end is the latest, which the words name. */
  last?: 'tasks' | 'agent' | 'job' | 'ai'
}

/** What the estimate reads besides the cockpit. */
export type EtaContext = {
  /** Other sessions' finished tasks, subagents and turns. */
  priors?: Durations
  /** The last runs of each command, by project. */
  lengths?: CommandLengths
  /** The AI ETA's setting: its answer is a part only while it is on. */
  aiOn?: boolean
}

/** Past what the AI said, the turn is given a little more, as a measured task is: never an end in the past. */
const AI_GRACE_MIN_MS = 10_000

/** The AI ETA's latest answer this turn, as a part of the whole; undefined until it answered with a number. */
export function aiPart(c: Cockpit, now: number): AiPart | undefined {
  const turn = c.turn
  const asks = turn?.asks ?? []
  const last = asks.findLast(a => a.state === 'answered' && a.leftMs !== undefined)
  if (!turn || !last || last.leftMs === undefined) return undefined
  const worked = activeMs(c.waits, last.askedAt, now)
  const left = last.leftMs - worked
  const isOver = left < 0
  const first = last.n > 1 ? asks.find(a => a.n === 1 && a.state === 'answered' && a.leftMs !== undefined) : undefined
  return {
    n: last.n,
    askedAt: last.askedAt,
    leftMs: last.leftMs,
    to: now + (isOver ? Math.max(AI_GRACE_MIN_MS, graceOf(last.leftMs)) : left),
    wholeMs: last.elapsedMs + last.leftMs,
    isOver,
    // The clock time its answer said, moved on by the waits on the person since.
    saidAt: last.askedAt + last.leftMs + (now - last.askedAt - worked),
    ...(first?.leftMs !== undefined ? { first: { leftMs: first.leftMs } } : {}),
  }
}

/** This session's checks with a measured length, for a background check's kind to go by. */
function checkLengths(c: Cockpit): CheckLength[] {
  return c.checks.flatMap(ch => (ch.durationMs !== undefined && (ch.status === 'pass' || ch.status === 'fail') ? [{ kind: ch.kind, ms: ch.durationMs }] : []))
}

/**
 * The work in hand, part by part: the live task list's open tasks one after
 * another at its pace (each in the main loop's working time, so its waits on
 * the person move the ends on), each of Claude's open agents to its type's
 * usual length (or every type's, for a type never seen finish), each running
 * background job to its command's usual length (or its kind of check's), and
 * the AI's answer for the rest of the turn. The whole ends at the latest of
 * them, never a sum. Parts with no length known run on with no expected end
 * (`openItems`). Undefined while nothing has an end, and past 12 hours.
 */
export function estimate(c: Cockpit, now: number, ctx: EtaContext = {}): Eta | undefined {
  const { priors, lengths } = ctx
  const list = c.tasks && isListLive(c.tasks, c.turn?.n ?? c.turnCount) ? c.tasks : undefined
  const progress = progressOf(list)
  const starts: number[] = []
  if (c.crossing && c.crossing.closedAt === undefined) starts.push(c.crossing.from)
  for (const t of list?.items ?? []) if (t.startedAt !== undefined) starts.push(t.startedAt)

  const agents: AgentEta[] = []
  for (const a of c.agents.filter(a => isCounted(a) && isAgentOpen(a))) {
    starts.push(a.startedAt)
    const own = agentPace(a.type, c, priors)
    const any = own ? undefined : anyAgentPace(c, priors)
    const pace = own ?? any
    if (!pace) continue
    const worked = a.agentId ? activeMs(c.waits, a.startedAt, now, { agentId: a.agentId }) : now - a.startedAt
    agents.push({ id: a.id, from: a.startedAt, to: now + Math.max(pace.ms - worked, graceOf(pace.ms)), typicalMs: pace.ms, basis: own ? 'type' : 'any', samples: pace.samples })
  }

  const jobs: JobEta[] = []
  const project = c.meta.root ?? ''
  const checks = checkLengths(c)
  for (const j of c.jobs.filter(isJobRunning)) {
    const pace = jobPace(j, project, lengths, checks)
    // A job with no expected end past its first 30 minutes runs aside: it no longer sets where the work began.
    if (pace || now - j.startedAt < OPEN_HOLD_MS) starts.push(j.startedAt)
    if (!pace) continue
    jobs.push({ id: j.id, from: j.startedAt, to: now + Math.max(pace.ms - (now - j.startedAt), graceOf(pace.ms)), typicalMs: pace.ms, basis: pace.basis, samples: pace.samples, ...(pace.kind ? { kind: pace.kind } : {}) })
  }

  let tasks: Eta['tasks']
  if (list && progress && !progress.isComplete) {
    const pace = taskPace(c, priors)
    if (pace) {
      const stretches: Stretch[] = []
      let cursor = now
      const running = list.items.find(t => t.status === 'in_progress')
      if (running) {
        const from = running.startedAt ?? now
        const worked = activeMs(c.waits, from, now)
        cursor = now + Math.max(pace.ms - worked, graceOf(pace.ms))
        stretches.push({ id: running.id, from, to: cursor })
      }
      for (const t of list.items) {
        if (t.status !== 'pending') continue
        stretches.push({ id: t.id, from: cursor, to: cursor + pace.ms })
        cursor += pace.ms
      }
      tasks = { pace, open: progress.total - progress.done, stretches }
    }
  }

  const ai = ctx.aiOn ? aiPart(c, now) : undefined
  if (c.turn) starts.push(c.turn.startedAt)
  const ends: { part: NonNullable<Eta['last']>; to: number }[] = [
    ...(tasks?.stretches.length ? [{ part: 'tasks' as const, to: Math.max(...tasks.stretches.map(s => s.to)) }] : []),
    ...agents.map(a => ({ part: 'agent' as const, to: a.to })),
    ...jobs.map(j => ({ part: 'job' as const, to: j.to })),
    ...(ai ? [{ part: 'ai' as const, to: ai.to }] : []),
  ]
  const startedAt = starts.length > 0 ? Math.min(...starts, now) : now
  if (ends.length === 0) {
    // A finished list with nothing still running is a crossing made.
    const isOpen = c.agents.some(a => isCounted(a) && isAgentOpen(a)) || c.jobs.some(j => isJobRunning(j) && now - j.startedAt < OPEN_HOLD_MS)
    if (list && progress?.isComplete && !isOpen) {
      const lastDone = Math.max(startedAt, ...list.items.map(t => t.doneAt ?? startedAt))
      return { startedAt, endsAt: lastDone, leftMs: 0, fraction: 1, isDone: true, agents: [], jobs: [] }
    }
    return undefined
  }
  const latest = ends.reduce((a, b) => (b.to > a.to ? b : a))
  const endsAt = latest.to
  const leftMs = Math.max(0, endsAt - now)
  if (leftMs > MAX_ESTIMATE_MS) return undefined
  // Across in the main loop's working time: while it waits on the person, the duck holds still.
  const done = activeMs(c.waits, startedAt, now)
  const fraction = done + leftMs > 0 ? Math.max(0, Math.min(1, done / (done + leftMs))) : 0
  return { startedAt, endsAt, leftMs, fraction, isDone: false, ...(tasks ? { tasks } : {}), agents, jobs, ...(ai ? { ai } : {}), last: latest.part }
}

/** Claude's work running with no expected end: its open agents and running jobs that no length is known for. */
export function openItems(c: Cockpit, eta: Eta | undefined): OpenItem[] {
  const timed = new Set([...(eta?.agents ?? []).map(a => a.id), ...(eta?.jobs ?? []).map(j => j.id)])
  return [
    ...c.agents.filter(a => isCounted(a) && isAgentOpen(a) && !timed.has(a.id)).map((a): OpenItem => ({ kind: 'agent', id: a.id, from: a.startedAt })),
    ...c.jobs.filter(j => isJobRunning(j) && !timed.has(j.id)).map((j): OpenItem => ({ kind: 'job', id: j.id, from: j.startedAt })),
  ]
}

/**
 * Whether something measured already says how long the turn's own work has
 * left: the task list at its pace, or a foreground agent of a known length
 * the main loop waits on. The AI ETA defers to it, and is asked when it goes.
 */
export function isTurnCovered(c: Cockpit, now: number, ctx: EtaContext = {}): boolean {
  const eta = estimate(c, now, { ...ctx, aiOn: false })
  if (eta?.tasks) return true
  return (eta?.agents ?? []).some(e => c.agents.some(a => a.id === e.id && a.status === 'running' && !a.isBackground))
}
