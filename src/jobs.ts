// Background work Claude comes back to: a shell it started with
// run_in_background (or one a timeout or ctrl+b sent there), a monitor, a
// workflow. Each is a job from the moment its call answered with a task id
// until the task's notification says it ended (or a turn's end no longer
// lists it). A turn's end lists the session's background tasks with a type
// and a status: an agent-like task (a subagent, a teammate, a cloud session)
// is the agents' list's, never a job; Claude Code's own housekeeping is
// nobody's work; a task another loop started (a teammate's shell) is that
// loop's; and the status listed is honoured. How long a shell usually takes
// comes from the runs of the same command in the same project, kept in a
// small store record; a check with no such runs takes its kind's usual
// length; with neither, the job is shown running with no expected end, since
// a dev server never ends. Pure.

import { checkKinds, exitIsPipe, judgeCheck, masksExit, shownCommand, type CheckKind, type CheckStatus } from './checks'
import { clip } from './format'
import { maskSecrets } from './mask'
import { median, MINUTE } from './metrics'

export type JobKind = 'shell' | 'monitor' | 'workflow' | 'other'
/** `waiting`: listed, alive and not at work (queued): it is not running. */
export type JobStatus = 'running' | 'waiting' | 'done' | 'failed' | 'killed'

export type Job = {
  /** The background task's id, as its notification and a turn's end name it. */
  id: string
  kind: JobKind
  /** The call that started it. */
  toolUseId?: string
  /** A shell's command, masked and cut. */
  command?: string
  /** What it is, in Claude's words (a shell's description, a workflow's name), masked and cut. */
  description?: string
  /** A shell that runs checks: their kinds. */
  checks?: CheckKind[]
  startedAt: number
  endedAt?: number
  status: JobStatus
  exitCode?: number
  /** First seen after it started (a turn's end listed it): when it began is not known. */
  isLate?: true
  /** It ended unseen: a turn's end no longer listed it and no notification said how. */
  isGone?: true
}

export const MAX_JOBS = 12

export const isJobRunning = (j: Job) => j.status === 'running'

/**
 * How long a background job holds the work in hand by itself. A job with no
 * expected end (a dev server, a watcher, a command never run before) holds
 * the progress's headline and the duck's crossing for its first 30 minutes,
 * then gives them back and runs on as a quiet line: the longest finite runs
 * people send to the background (a full suite, a build) end well inside
 * that, and a monitor expires by then. A job of a known length holds the
 * headline as long as it runs.
 */
export const OPEN_HOLD_MS = 30 * 60_000

/** Alive, at work or waiting: a turn's end still lists it. */
export const isJobOpen = (j: Job) => j.status === 'running' || j.status === 'waiting'

/** The longest command shown as a job's name. */
const COMMAND_NAME_MAX = 40

/**
 * A job's name for the words: a shell's command where it reads as one
 * (`make test-all`, as the person would type it; a leading `cd dir &&` and a
 * trailing `2>&1` are left out), else Claude's description of it, else its
 * command, else its kind.
 */
export function jobName(j: Job): string {
  const command = j.command
    ?.trim()
    .replace(/^cd\s+\S+\s*&&\s*/, '')
    .replace(/\s*2>&1\s*$/, '')
  if (command && command.length <= COMMAND_NAME_MAX && !/[;&|<>`\n]|\$\(/.test(command)) return command
  return j.description ?? j.command ?? j.kind
}

// ------------------------------------------------------------------ notifications

/** What a task's notification says: which task, which call started it, how it ended. */
export type TaskNotice = {
  taskId?: string
  toolUseId?: string
  /** `completed`, `failed`, `killed`, `stopped`, or another word its producer wrote. */
  status?: string
  /** A shell's exit code, from its summary (`completed (exit code 0)`). */
  exitCode?: number
  /** What the summary says it was: a background command, an agent, a monitor, a workflow. */
  of?: 'shell' | 'agent' | 'monitor' | 'workflow'
  /** One of a monitor's events (`<event>`): news from a task still running, which ends nothing. */
  isEvent?: true
}

const unescape = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)
  const value = m?.[1]?.trim()
  return value ? unescape(value) : undefined
}

/**
 * The notices a turn's text carries: every `<task-notification>` block, with
 * its task id, the call that started the task, how it ended and, for a shell,
 * its exit code. None for any other text.
 */
export function parseNotices(text: string): TaskNotice[] {
  const out: TaskNotice[] = []
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const block = m[1] ?? ''
    const summary = tag(block, 'summary') ?? ''
    const code = /\bexit code (-?\d+)/.exec(summary)?.[1]
    const of = /^Background command\b/.test(summary) ? 'shell' : /^Agent\b/.test(summary) ? 'agent' : /^Monitor\b/.test(summary) ? 'monitor' : /workflow\b/i.test(summary) ? 'workflow' : undefined
    const notice: TaskNotice = {}
    const taskId = tag(block, 'task-id')
    const toolUseId = tag(block, 'tool-use-id')
    const status = tag(block, 'status')
    if (taskId) notice.taskId = taskId
    if (toolUseId) notice.toolUseId = toolUseId
    if (status) notice.status = status.toLowerCase()
    if (code !== undefined) notice.exitCode = Number(code)
    if (of) notice.of = of
    if (status === undefined && (/<event>/.test(block) || /^Monitor event\b/.test(summary))) notice.isEvent = true
    if (notice.taskId || notice.toolUseId) out.push(notice)
  }
  return out
}

/** How a notice's status word ends a job. */
export function endStatus(status: string | undefined, exitCode?: number): JobStatus {
  if (status === 'failed' || status === 'blocked' || status === 'error') return 'failed'
  if (status === 'killed' || status === 'stopped' || status === 'cancelled' || status === 'canceled') return 'killed'
  return exitCode !== undefined && exitCode !== 0 ? 'failed' : 'done'
}

/**
 * A background check's verdict from its exit code alone, judged as a
 * foreground run is but with no output to read (it went to the task's own
 * file, which quackpit does not read): a failing exit fails it; a clean one
 * passes it where nothing in the line can hide the exit, and a test run behind
 * a pipe or `;` has no verdict; a stopped one was interrupted.
 */
export function jobVerdict(command: string, status: JobStatus, exitCode: number | undefined): CheckStatus {
  if (status === 'killed') return 'interrupted'
  const isError = status === 'failed' || (exitCode !== undefined && exitCode !== 0)
  // A shell's notice always names its exit; without one there is nothing to judge.
  if (!isError && exitCode === undefined) return 'hidden'
  return judgeCheck({ isError, text: '', exitMasked: masksExit(command), exitIsPipe: exitIsPipe(command), kinds: checkKinds(command) }).status
}

// ------------------------------------------------------------------ jobs from calls and turn ends

/** A main-loop Bash call that answered with a task id: the shell runs on in the background from its call's start. */
export function shellJob(input: { id: string; toolUseId: string; command: string; description?: string; startedAt: number }): Job {
  const kinds = checkKinds(input.command)
  return {
    id: input.id,
    kind: 'shell',
    toolUseId: input.toolUseId,
    command: shownCommand(input.command, 160),
    ...(input.description && input.description.trim() !== '' ? { description: clip(maskSecrets(input.description), 60) } : {}),
    ...(kinds.length > 0 ? { checks: kinds } : {}),
    startedAt: input.startedAt,
    status: 'running',
  }
}

/**
 * A main-loop call that started a task of another kind: the Monitor tool (its
 * command a stream of events) or the Workflow tool (its agents run on their
 * own), each answering with the task's id. A job from the call's start.
 */
export function taskJob(input: { id: string; kind: 'monitor' | 'workflow'; toolUseId: string; command?: string; description?: string; startedAt: number }): Job {
  return {
    id: input.id,
    kind: input.kind,
    toolUseId: input.toolUseId,
    ...(input.command ? { command: shownCommand(input.command, 160) } : {}),
    ...(input.description && input.description.trim() !== '' ? { description: clip(maskSecrets(input.description), 60) } : {}),
    startedAt: input.startedAt,
    status: 'running',
  }
}

/** One in-flight task as a turn's end lists it (`classic.Stop`'s `background_tasks`). */
export type ListedTask = { id: string; type: string; status?: string; description?: string; command?: string; agent_type?: string; name?: string }

/**
 * What a listed task is, by its type: Claude Code labels its task types
 * (`shell`, `subagent`, `teammate`, `monitor`, `MCP task`, `workflow`,
 * `cloud session`, and its own `dream`, `auto-mode scan`, `memory import`)
 * and falls back to the raw word for a type it has no label for (`local_bash`,
 * `in_process_teammate`). An agent-like one is `agent` (the agents' own list
 * keeps those, and knows when a teammate is idle); housekeeping is `skip`.
 * The Monitor tool's command runs as a shell task, listed `shell`.
 */
export function listedKind(type: string): JobKind | 'agent' | 'skip' {
  const t = type.toLowerCase().trim()
  if (t === 'shell' || t === 'bash' || t === 'local_bash') return 'shell'
  if (['subagent', 'agent', 'local_agent', 'teammate', 'in_process_teammate', 'remote_agent', 'cloud session'].includes(t)) return 'agent'
  if (['dream', 'auto-mode scan', 'auto_mode_scan', 'memory import', 'local_memory_import'].includes(t)) return 'skip'
  if (t.includes('monitor') || t.includes('mcp')) return 'monitor'
  if (t.includes('workflow')) return 'workflow'
  // A type Claude Code may add later: an agent's by its word, else work of some other kind.
  if (t.includes('agent') || t.includes('teammate')) return 'agent'
  return 'other'
}

/** The words that say a task ended, and how. */
const ENDED_STATUSES = new Set(['completed', 'done', 'failed', 'error', 'blocked', 'killed', 'stopped', 'cancelled', 'canceled'])

/**
 * A listed task's status as a job's: `running` runs; `pending`, `waiting`
 * and `idle` are alive and not running; an ended word ends it with that
 * outcome; no word at all, as before, runs.
 */
export function listedStatus(status: string | undefined): JobStatus {
  const s = (status ?? 'running').toLowerCase().trim()
  if (s === 'running' || s === '') return 'running'
  if (ENDED_STATUSES.has(s)) return endStatus(s)
  if (s === 'pending' || s === 'waiting' || s === 'idle' || s === 'queued' || s === 'paused') return 'waiting'
  return 'running'
}

/**
 * The jobs as a turn's end lists the work still in flight. A listed task that
 * is an agent's (a subagent, a teammate) or Claude Code's own housekeeping,
 * or that another loop started (`foreign`: a teammate's or a subagent's own
 * shell), is no job of Claude's: a job by its id is dropped, since it never
 * was one (a teammate's task was kept as a running job by an older build, and stayed so
 * for hours: this is what clears it). A job listed takes the status listed;
 * one not known yet joins (first seen now, so when it began is not known);
 * one open that the list no longer holds ended unseen.
 */
export function reconcileJobs(jobs: readonly Job[], listed: readonly ListedTask[], at: number, foreign: readonly string[] = []): Job[] {
  const others = new Set(foreign)
  const notJobs = new Set(listed.filter(task => others.has(task.id) || listedKind(task.type) === 'agent' || listedKind(task.type) === 'skip').map(task => task.id))
  const tasks = listed.filter(task => !notJobs.has(task.id))
  const byId = new Map(tasks.map(task => [task.id, task]))
  let next: Job[] = []
  for (const j of jobs) {
    if (notJobs.has(j.id) || others.has(j.id)) continue
    if (!isJobOpen(j)) {
      next.push(j)
      continue
    }
    const task = byId.get(j.id)
    if (!task) {
      next.push(at - j.startedAt > 2000 ? { ...j, status: 'done' as const, endedAt: at, isGone: true as const } : j)
      continue
    }
    const status = listedStatus(task.status)
    if (status === j.status) next.push(j)
    else if (status === 'running' || status === 'waiting') next.push({ ...j, status })
    else next.push({ ...j, status, endedAt: at })
  }
  for (const task of tasks) {
    if (next.some(j => j.id === task.id)) continue
    const status = listedStatus(task.status)
    // A task that ended before it was ever seen running is nothing to show.
    if (status !== 'running' && status !== 'waiting') continue
    const kind = listedKind(task.type) as JobKind
    const command = task.command ? shownCommand(task.command, 160) : undefined
    const description = task.description ?? task.name
    const kinds = command ? checkKinds(command) : []
    next = [
      ...next,
      {
        id: task.id,
        kind,
        ...(command ? { command } : {}),
        ...(description && description.trim() !== '' ? { description: clip(maskSecrets(description), 60) } : {}),
        ...(kinds.length > 0 ? { checks: kinds } : {}),
        startedAt: at,
        status,
        isLate: true,
      },
    ]
  }
  return trimJobs(next)
}

/** The jobs kept: every open one, and the latest ended ones up to the limit. */
export function trimJobs(jobs: readonly Job[]): Job[] {
  const ended = jobs.filter(j => !isJobOpen(j))
  const drop = new Set(ended.slice(0, Math.max(0, jobs.length - MAX_JOBS)))
  return jobs.filter(j => !drop.has(j))
}

/** A job's length once it ended, where both ends were seen. */
export function jobLength(j: Job): number | undefined {
  if (isJobOpen(j) || j.isLate || j.isGone || j.endedAt === undefined) return undefined
  return Math.max(0, j.endedAt - j.startedAt)
}

// ------------------------------------------------------------------ how long a command usually takes

/** Runs kept for one command, and commands kept in all (the most recently used). */
export const KEEP_RUNS = 5
export const KEEP_COMMANDS = 60
/** Shorter than this a run is no help to estimate anything. */
export const MIN_RUN_MS = 5000

/** One command's last runs in one project, newest last. */
export type CommandRuns = { p: string; c: string; ms: number[]; at: number }
export type CommandLengths = { v: 1; runs: CommandRuns[] }

export function emptyLengths(): CommandLengths {
  return { v: 1, runs: [] }
}

/** A command as runs of it are matched: masked, its spaces collapsed, cut. */
export function commandKey(command: string): string {
  return shownCommand(command, 160).replace(/\s+/g, ' ').trim()
}

/** The record with one more run of a command in a project. */
export function addRun(lengths: CommandLengths | undefined, project: string, command: string, ms: number, at: number): CommandLengths {
  const base = lengths ?? emptyLengths()
  if (!(ms >= MIN_RUN_MS) || !Number.isFinite(ms)) return base
  const c = commandKey(command)
  const had = base.runs.find(r => r.p === project && r.c === c)
  const entry: CommandRuns = { p: project, c, ms: [...(had?.ms ?? []), Math.round(ms)].slice(-KEEP_RUNS), at }
  const runs = [...base.runs.filter(r => r !== had), entry].sort((a, b) => a.at - b.at).slice(-KEEP_COMMANDS)
  return { v: 1, runs }
}

/** A stored record read back: anything not in its shape is none. */
export function asLengths(x: unknown): CommandLengths | undefined {
  if (typeof x !== 'object' || x === null) return undefined
  const r = x as { v?: unknown; runs?: unknown }
  if (r.v !== 1 || !Array.isArray(r.runs)) return undefined
  const runs = r.runs.filter((run): run is CommandRuns => {
    if (typeof run !== 'object' || run === null) return false
    const e = run as Record<string, unknown>
    return typeof e.p === 'string' && typeof e.c === 'string' && typeof e.at === 'number' && Array.isArray(e.ms) && e.ms.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
  })
  return { v: 1, runs: runs.slice(-KEEP_COMMANDS) }
}

/** Where a job's expected length comes from: runs of its command, or its kind of check. */
export type JobPace = { ms: number; basis: 'command' | 'kind'; samples: number; kind?: CheckKind }

/** Check runs of this session with a measured length: their kind and how long they took. */
export type CheckLength = { kind: CheckKind; ms: number }

/**
 * How long a job is expected to take: the median of the last runs of the same
 * command in the same project (one is enough: it is the same command); else,
 * for a check, the median of that kind of check's runs, this session's and
 * the project's recorded ones (two at least); else nothing.
 */
export function jobPace(j: Job, project: string, lengths: CommandLengths | undefined, checks: readonly CheckLength[] = []): JobPace | undefined {
  if (j.kind !== 'shell' || !j.command) return undefined
  const c = commandKey(j.command)
  const own = lengths?.runs.find(r => r.p === project && r.c === c)
  if (own && own.ms.length > 0) return { ms: median(own.ms) ?? 0, basis: 'command', samples: own.ms.length }
  const kind = j.checks?.at(-1)
  if (!kind) return undefined
  const recorded = (lengths?.runs ?? []).filter(r => r.p === project && checkKinds(r.c).at(-1) === kind).flatMap(r => r.ms)
  const session = checks.filter(ch => ch.kind === kind && ch.ms >= MIN_RUN_MS).map(ch => ch.ms)
  const all = [...session, ...recorded]
  if (all.length < 2) return undefined
  return { ms: median(all) ?? 0, basis: 'kind', samples: all.length, kind }
}

/** A run's length worth keeping for its command: long enough to matter, short enough to be one run. */
export function isRunLength(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_RUN_MS && ms <= 12 * 60 * MINUTE
}
