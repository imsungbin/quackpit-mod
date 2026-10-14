// The cockpit: everything quackpit knows about the session, as plain JSON,
// and the pure reducers that fold each observed event into it. The adapter
// (hooks/register.tsx) turns host events into the plain inputs below and keeps
// the result in the host's session state; nothing here knows the host.
//
// Main agent only: every reducer that takes a tool or turn event ignores one
// that carries an `agentId` (a subagent's loop). The one exception is the
// work's lifecycle: when another loop's agent starts, waits on the
// person or ends, the estimate of the work in hand may know it; its tokens and
// tools never reach a gauge.

import {
  checkKinds,
  exitIsPipe,
  failingLines,
  failureTail,
  judgeCheck,
  masksExit,
  shownCommand,
  type CheckKind,
  type CheckResult,
} from './checks'
import { addWords, baseName, clip, squeeze } from './format'
import { asContextSplit, type ContextSplit } from './context'
import { endStatus, isJobOpen, isJobRunning, jobVerdict, listedKind, OPEN_HOLD_MS, reconcileJobs, shellJob, taskJob, trimJobs, type Job, type ListedTask, type TaskNotice } from './jobs'
import { maskSecrets } from './mask'
import { addRecent, cacheParts, isEditTool, isNum, isRunaway, median, newTokens, RUNAWAY_MIN_TURNS, type CacheParts, type TokenUsage } from './metrics'
import { emptyDurations, isAgentOpen, isCounted, noteLengths, noteTurn, turnsOfHistory, type Durations } from './eta'

export { isAgentOpen, isCounted }
import { applyTaskCall, TASK_TOOLS, type TaskList } from './progress'
import { activeMs, asWaits, endWaits, heldMs, startWait, type Wait, type WaitKind } from './waits'

export const MODEL_VERSION = 10
export const HISTORY_TURNS = 20
const MAX_MEDIAN = 50
const MAX_CHECKS = 30
const MAX_COMMANDS = 40
const MAX_FILES = 200
const MAX_AGENTS = 20
const MAX_EDITS = 60
const MAX_SAMPLES = 120
/** Five-hour readings kept for its forecast: the last 90 minutes. */
const SAMPLE_WINDOW_MS = 90 * 60_000

export type Phase =
  | { kind: 'idle'; since: number }
  | { kind: 'thinking'; since: number }
  | { kind: 'tool'; tool: string; subject?: string; since: number }

export type InFlight = { id: string; tool: string; subject?: string; at: number; seq: number }

export type LiveTurn = {
  id: string
  /** 1-based, among this session's main turns. */
  n: number
  startedAt: number
  costAtStart?: number
  tools: number
  edits: number
  /** New tokens of foreground subagents this turn ran, from the Agent tool's record. */
  subTokens: number
  /** New tokens of the main loop's responses so far this turn, counted as each one ended (`turn.step`). */
  stepTokens: number
  /** The turn's first tool call: its transcript row is where the pane scrolls to for it. */
  firstTool?: string
  /** When the turn's latest main response ended. */
  lastStepAt?: number
  /** The person's prompt, short, for the turns table; absent when they did not type what started the turn. */
  prompt?: string
  /** What started the turn when no person typed it: a subagent's report, a background task's notice, a command. */
  source?: TurnSource
  /** The text the turn began with, masked and cut to its head and tail: what the AI ETA reads. */
  text?: string
  /** Claude's own words so far this turn (its stated plan, then what it says as it goes), masked and held short. */
  words?: string
  /** Claude's latest words this turn, masked and cut: what an AI re-ask is told it said last. */
  lastWords?: string
  /** The AI ETA's calls this turn, oldest first: the first answer, then its revisions (4 at most). */
  asks?: AiAsk[]
  /** Why the AI ETA is due to be asked again, once its spacing allows: noted when it happened. */
  aiDue?: { why: AiWhy; at: number }
  /** The work's shape when the AI ETA last looked (agents and jobs running, a list, a measured estimate): a change re-asks it. */
  shape?: string
  /** What happened this turn, the latest few: what an AI re-ask is told happened since its last answer. */
  log?: TurnNote[]
  inFlight: InFlight[]
}

/** Where a turn no person typed came from, as its first words say. */
export type TurnSourceKind = 'report' | 'task' | 'teammate' | 'peer' | 'event' | 'command' | 'compaction' | 'plugin' | 'system'
export type TurnSource = { kind: TurnSourceKind; name?: string }

/**
 * Why the AI ETA was asked: first, once the turn had run a minute with
 * nothing measured; then again when the turn ran past its answer, when a wait
 * on the person ended, when the work changed shape (an agent or a background
 * job started or ended, a task list appeared), or when the measured estimate
 * it deferred to went away.
 */
export type AiWhy = 'first' | 'overrun' | 'answered' | 'shape' | 'deferred'

/**
 * One of the AI ETA's calls for a turn. `leftMs` is what it answered, in the
 * turn's own working time from `askedAt` (a later wait on the person moves
 * its end on); `historyMs` what the history-only estimate said at the same
 * moment, kept so each answer can be scored against the turn's real end.
 */
export type AiAsk = {
  /** 1 for the first answer, 2 to 4 for its revisions. */
  n: number
  askedAt: number
  /** How long the turn had worked when it was asked (its waits on the person left out). */
  elapsedMs: number
  why: AiWhy
  /** `stale`: answered for a state that had changed by the time it came, and dropped. */
  state: 'asking' | 'answered' | 'failed' | 'cancelled' | 'stale'
  leftMs?: number
  historyMs?: number
}

/** One thing that happened in a turn, in a few words, for the AI ETA's re-ask. */
export type TurnNote = { at: number; kind: 'tool' | 'answered' | 'agent' | 'agentEnd' | 'job' | 'jobEnd' | 'list'; text: string }

const MAX_NOTES = 30

export type TurnRecord = {
  n: number
  startedAt: number
  endedAt: number
  /** New tokens (uncached input, output, cache writes), its foreground subagents' included. */
  tokens: number
  costUsd?: number
  /** The ledger when the turn started, until the next reading settles its cost. */
  costStart?: number
  /** Its cost decides whether it ran away, and waits for the next reading. */
  pending?: true
  /** As the turn's end reported it: what Claude Code's own `TurnDuration` line prints. */
  durationMs?: number
  /** Its first tool call's id, the transcript row the pane scrolls to. */
  firstTool?: string
  tools: number
  edits: number
  prompt?: string
  /** What started it when no person typed it (LiveTurn's `source`). */
  source?: TurnSource
  /** The context's size as the turn ended: its last main prompt (uncached, cache-read and cache-written together). */
  ctx?: number
  runaway?: true
  /** A runaway's cost over the median of the turns before it. */
  factor?: number
  aborted?: true
}

/** The main loop's latest response: when its request started and ended, and its prompt's parts. */
export type StepRecord = CacheParts & { at: number; startedAt: number; output: number; model?: string }

export type Window = { pct: number; resetsAt?: number }

/** One `$.session.usage()` reading, as the adapter flattened it. */
export type Reading = {
  at: number
  contextPct?: number
  contextTokens?: number
  contextWindow?: number
  fiveHour?: Window
  sevenDay?: Window
  costUsd?: number
  /** When the session began, as Claude Code counts it; only a direct read carries it. */
  sessionStartedAt?: number
  /** Claude Code pushed it (`session.measure`) right after a response, rather than quackpit asking. */
  pushed?: true
}

export type CommandRun = {
  command: string
  at: number
  /** true: exit 0; false: failed; null: interrupted or sent to the background. */
  ok: boolean | null
  check?: CheckKind
  /** Rebuilt from a resumed transcript: `at` is the resume, not when it ran. */
  replayed?: true
}

/** `replayed`: last touched in a resumed transcript, so `lastAt` is the resume, not the edit. */
export type FileTouch = { path: string; edits: number; lastAt: number; created?: true; replayed?: true }

/** One edit, in the order the session's calls started (`seq`): what tells it from a check before or after it. */
export type EditMark = { path: string; at: number; seq: number }

export type AgentRun = {
  /** The main loop's Agent call's id; `agent:<id>` for one quackpit saw start otherwise (a workflow's, a plugin's, the list's). */
  id: string
  description: string
  type: string
  startedAt: number
  endedAt?: number
  /**
   * `running` in the foreground, `background` on its own; `idle`, a teammate
   * between turns, waiting for a message (alive, not working); `waiting`,
   * alive and not at work as the agents' list says (on its own background
   * work, a plan's approval, an agent it started; or still queued); `remote`,
   * launched as a cloud session, which this session cannot follow; `stopped`,
   * stopped by the person or by Claude.
   */
  status: 'running' | 'background' | 'idle' | 'waiting' | 'remote' | 'done' | 'failed' | 'stopped'
  agentId?: string
  /** Launched to run in the background: its tokens never reach the main loop. */
  isBackground?: true
  tokens?: number
  /** From its Agent result: how long it ran, its tool calls, and the lines it added and removed. */
  durationMs?: number
  toolUses?: number
  added?: number
  removed?: number
  /** Rebuilt from a resumed transcript: its times are the resume's. */
  replayed?: true
  /**
   * Who started it: Claude's main loop (its Agent call, or one the list shows
   * with no parent and no plugin: a skill's fork, a teammate, one left from an
   * earlier turn), a workflow Claude ran, a plugin, or another agent. Absent on
   * a run a version-9 cockpit kept, which was the main loop's.
   */
  by?: 'main' | 'workflow' | 'plugin' | 'agent'
  /** The plugin that started it, or the type of the agent that did. */
  byName?: string
  /** Its own waits on the person (a permission dialog it raised), left out of its length; set as it ends. */
  heldMs?: number
  /** First seen in the agents' list, not as it started: its start is when quackpit first saw it. */
  seenLate?: true
  /** A teammate: a named agent of the session's team, idle between its turns. */
  teammate?: true
  /** The agents' list has shown it: gone from the list later, it has ended. */
  listed?: true
}



/** The last passing run of one kind of check. */
export type Passing = { kind: CheckKind; command: string; at: number; replayed?: true }

/** The latest failing run of one kind of check, while no later run of that kind passed. */
export type Failure = { kind: CheckKind; command: string; at: number; output: string; replayed?: true }

export type ShiftNotice = { state: 'armed' } | { state: 'showing'; untilTurn: number } | { state: 'done' }

/** A stretch of the person's prompts: its first and its latest. */
export type Stretch = { from: number; last: number }

/** No prompt for this long is a pause: the next prompt starts a new stretch. */
export const PAUSE_MS = 30 * 60_000

export type Meta = { model?: string; effort?: string; mode?: string; repo?: string; root?: string }

/** The auto-compact point as the context breakdown gave it: `threshold` tokens, absent when it is off. */
export type AutoCompact = { at: number; turn: number; isOn: boolean; threshold?: number }

export type Cockpit = {
  v: typeof MODEL_VERSION
  /** The session id this was built for; another one means a /clear or a resume. */
  sid: string
  /** When quackpit started watching this session. */
  startedAt: number
  /** When the session itself began, as Claude Code counts it (`$.session.usage().startedAt`). */
  sessionStartedAt?: number
  /** quackpit started watching a session already under way (a reload, an install mid-session, a resume). */
  joinedLate?: true
  lastAt: number
  goal?: string
  /** The person's first prompt is gone from the transcript (compacted): the mission is unknown. */
  goalLost?: true
  /** The person's prompts after the first, masked and cut, oldest first; the latest also whole in `lastPrompt`. */
  prompts: string[]
  /** The person's latest prompt, whole (masked). */
  lastPrompt?: string
  /** The question Claude's latest answer ended on, if it ended on one (masked). */
  question?: string
  /** The last command of each kind of check that passed: how to run it. */
  passing: Passing[]
  /** What finished tasks and subagents took, for the estimate of what is left (and, kept, the next sessions'). */
  durations: Durations
  tasks?: TaskList
  phase: Phase
  turn?: LiveTurn
  /** Main turns completed. */
  turnCount: number
  history: TurnRecord[]
  turnTokens: number[]
  turnUsd: number[]
  /** `[at, new tokens]` of the last 60 minutes, one entry a minute, for pace: each main response as it ended. */
  recent: [number, number][]
  /** New tokens of the completed turns. */
  tokens: number
  activeMs: number
  /** Every main prompt's parts this session: what the cache served, what was written to it, what it missed. */
  cache: CacheParts
  lastStep?: StepRecord
  /** `[at, five_hour %]` of the last 90 minutes of this window, for its forecast. */
  fiveSamples: [number, number][]
  reading?: Reading
  /**
   * When Claude Code last pushed a reading (`session.measure`, right after a
   * response): with the main loop's last response, how fresh the plan windows
   * are, which arrive only with this session's own responses.
   */
  measuredAt?: number
  compactions: number
  /** The last compaction: the context's fill is unknown from then until the next response. */
  compactedAt?: number
  /** When the last few compactions came, oldest first: the context detail marks them. */
  compactTimes?: number[]
  /**
   * The person's stretch of work: from their first prompt after a pause of
   * 30 minutes or more to their latest prompt. Health's breaks and night parts read it.
   */
  stretch?: Stretch
  /** Where Claude Code compacts the context by itself, read at most once a turn. */
  autoCompact?: AutoCompact
  checks: CheckResult[]
  /** Main tool calls started so far: each call's `seq`. */
  seq: number
  /** The latest edits, for what no passing check has seen since. */
  edits: EditMark[]
  /** One per kind of check whose latest finished run failed, oldest first. */
  failures: Failure[]
  commands: CommandRun[]
  files: FileTouch[]
  agents: AgentRun[]
  meta: Meta
  /** Caution keys the person acknowledged (the duck was pressed) and keys already announced. */
  ack: string[]
  seen: string[]
  shift: ShiftNotice
  handoverAt?: number
  /** Waits on the person, open and the latest closed: what lengths leave out and ends move on by. */
  waits: Wait[]
  /** Background work Claude comes back to: shells, monitors, workflows, running and the latest ended. */
  jobs: Job[]
  /**
   * The stretch of work the duck crosses: from the turn that began it while
   * anything runs (a turn, Claude's agents, its background jobs), carried
   * into the turn a job's or an agent's notice starts. `closedAt` once
   * nothing runs.
   */
  crossing?: { from: number; closedAt?: number }
  /**
   * What fills the context, measured at most once a turn: /context's rows and
   * its Messages row split by source. Dropped by a compaction, which replaces
   * what it described.
   */
  ctx?: ContextSplit
  /**
   * Background tasks another loop started (a teammate's or a subagent's own
   * shell), the latest few: a turn's end lists them with the session's, and
   * they are that loop's work, never Claude's jobs.
   */
  foreign?: string[]
}

export function newCockpit(at: number, sid = ''): Cockpit {
  return {
    v: MODEL_VERSION,
    sid,
    startedAt: at,
    lastAt: at,
    phase: { kind: 'idle', since: at },
    turnCount: 0,
    history: [],
    turnTokens: [],
    turnUsd: [],
    recent: [],
    tokens: 0,
    activeMs: 0,
    cache: { read: 0, write: 0, input: 0 },
    fiveSamples: [],
    compactions: 0,
    checks: [],
    seq: 0,
    edits: [],
    prompts: [],
    passing: [],
    durations: emptyDurations(),
    failures: [],
    commands: [],
    files: [],
    agents: [],
    meta: {},
    ack: [],
    seen: [],
    shift: { state: 'armed' },
    waits: [],
    jobs: [],
  }
}

/** Reads a stored cockpit defensively: another version, or garbage, is a fresh one. */
export function asCockpit(x: unknown): Cockpit | undefined {
  if (typeof x !== 'object' || x === null) return undefined
  const c = x as Partial<Cockpit>
  // A version-6 cockpit had all of version 7's but the lengths: it carries on with none yet.
  if ((c.v as number) === 6) return asCockpit({ ...c, v: 7, durations: { tasks: [], agents: {} } })
  // Version 7 kept no turn lengths: its history's turns stand in for them.
  if ((c.v as number) === 7) {
    const kept = typeof c.durations === 'object' && c.durations !== null ? c.durations : emptyDurations()
    return asCockpit({ ...c, v: 8, durations: { ...kept, turns: turnsOfHistory(c.history) } })
  }
  // Version 8 had all of version 9's but what is new and optional: the person's stretch, each turn's
  // context, the compactions' times, a chain's kinds and a failure's lines. Its last
  // compaction is the one time it knew.
  if ((c.v as number) === 8) return asCockpit({ ...c, v: 9, ...(isNum(c.compactedAt) && c.compactTimes === undefined ? { compactTimes: [c.compactedAt] } : {}) })
  // Version 9 had no waits and no jobs yet, and its live turn kept one AI call (`ai`): it is the first answer.
  if ((c.v as number) === 9) {
    const live = c.turn as (LiveTurn & { ai?: Omit<AiAsk, 'n' | 'why'> }) | undefined
    const { ai, ...turn } = live ?? {}
    const asks: AiAsk[] | undefined = ai && typeof ai === 'object' ? [{ ...ai, n: 1, why: 'first' }] : undefined
    return asCockpit({ ...c, v: MODEL_VERSION, waits: [], jobs: [], ...(live ? { turn: { ...(turn as LiveTurn), ...(asks ? { asks } : {}) } } : {}) })
  }
  if (c.v !== MODEL_VERSION || typeof c.sid !== 'string' || !isNum(c.startedAt)) return undefined
  if (!Array.isArray(c.waits) || !Array.isArray(c.jobs)) return undefined
  if (typeof c.durations !== 'object' || c.durations === null || !Array.isArray(c.durations.tasks) || typeof c.durations.agents !== 'object' || !Array.isArray(c.durations.turns)) return undefined
  if (!Array.isArray(c.history) || !Array.isArray(c.checks) || !Array.isArray(c.recent) || !Array.isArray(c.failures)) return undefined
  if (typeof c.cache !== 'object' || c.cache === null || !Array.isArray(c.edits) || !isNum(c.seq) || !Array.isArray(c.prompts) || !Array.isArray(c.passing)) return undefined
  // The context's split and the foreign ids are optional: an older version-10 cockpit has neither, and one that does not read is dropped alone.
  const { ctx, foreign, ...rest } = x as Cockpit
  const split = ctx !== undefined ? asContextSplit(ctx) : undefined
  const others = Array.isArray(foreign) ? foreign.filter((id): id is string => typeof id === 'string') : undefined
  return { ...rest, waits: asWaits(c.waits), ...(split ? { ctx: split } : {}), ...(others && others.length > 0 ? { foreign: others } : {}) }
}

const lastN = <T>(xs: readonly T[], n: number): T[] => xs.slice(Math.max(0, xs.length - n))

// ---------------------------------------------------------------- prompts

/** Later prompts kept, and how much of each: the handover lists them, the latest whole. */
const MAX_PROMPTS = 8
const PROMPT_CHARS = 300
const LAST_PROMPT_CHARS = 4000

/**
 * A prompt that entered. The person's first becomes the mission's goal,
 * unless that one is known to be gone; each one after it joins their words.
 * Credentials are masked as it comes in; the latest is also kept whole.
 */
export function onPrompt(c: Cockpit, e: { at: number; text: string; isPersonal: boolean; isReplay?: boolean }): Cockpit {
  if (!e.isPersonal || !isTypedPrompt(e.text)) return { ...c, lastAt: e.at }
  // A paste is the person's words: its markup goes, its text stays.
  const masked = maskSecrets(unwrapPasted(e.text))
  // The person wrote again: whatever Claude asked last is answered.
  const { question: _answered, ...rest } = c
  // A rebuilt transcript has no times: the prompts it gives back are no stretch of work.
  const stretch = e.isReplay ? {} : { stretch: extendStretch(c.stretch, e.at) }
  if (c.goal === undefined && !c.goalLost) return { ...rest, ...stretch, goal: clip(masked, 600), lastAt: e.at }
  return {
    ...rest,
    ...stretch,
    prompts: lastN([...c.prompts, clip(masked, PROMPT_CHARS)], MAX_PROMPTS),
    lastPrompt: masked.length > LAST_PROMPT_CHARS ? `${masked.slice(0, LAST_PROMPT_CHARS - 1)}…` : masked,
    lastAt: e.at,
  }
}

/**
 * Two stretches of the person's prompts as one: the later one carries on
 * the earlier when it began within 30 minutes of the earlier's last prompt
 * (a /clear between them is no pause), else the later alone stands.
 */
export function joinStretch(earlier: Stretch | undefined, later: Stretch | undefined): Stretch | undefined {
  if (!earlier || !later) return later ?? earlier
  if (later.from - earlier.last >= PAUSE_MS || later.last < earlier.from) return later
  return { from: Math.min(earlier.from, later.from), last: Math.max(earlier.last, later.last) }
}

/** The person's stretch with a prompt at `at`: the same stretch within 30 minutes of the last prompt, else a new one. */
export function extendStretch(stretch: Stretch | undefined, at: number): Stretch {
  if (!stretch || at - stretch.last >= PAUSE_MS || at < stretch.from) return { from: at, last: at }
  return { from: stretch.from, last: Math.max(stretch.last, at) }
}

/**
 * A pasted prompt's text: Claude Code hands a paste on wrapped in
 * `<pasted_content id="…">` and its closing tag; the wrapping goes, the
 * person's words inside and around it stay.
 */
export function unwrapPasted(text: string): string {
  return text.replace(PASTE_TAG_RE, '').trim()
}

/** The markup around a paste: its opening tag (with its id) and its closing one. */
const PASTE_TAG_RE = /<\/?pasted_content\b[^>]*>/g

/**
 * The question an answer ended on: its last paragraph, when that ends with a
 * question mark, from the sentence that asks it. Undefined for an answer that
 * ends on anything else.
 */
export function endingQuestion(answer: string): string | undefined {
  const paragraphs = answer.trim().split(/\n\s*\n/)
  const last = (paragraphs.at(-1) ?? '').trim()
  if (!/[?？]\s*$/.test(last)) return undefined
  // From the sentence that asks it: a list item, or what follows the last full stop before it.
  const lines = last.split('\n')
  const asking = (lines.at(-1) ?? last).replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
  const sentences = asking.split(/(?<=[.!。])\s+/)
  return clip(maskSecrets(sentences.at(-1) ?? asking), 400)
}

// ---------------------------------------------------------------- turns

/** How much of the text a turn began with the AI ETA reads: its head and tail. */
export const TURN_TEXT_CHARS = 1500

export function onTurnStart(c: Cockpit, e: { at: number; turnId: string; text: string; costUsd?: number }): Cockpit {
  // A turn a background task's notice or a subagent's report started is labelled, never shown as typed.
  const source = e.text.trim() !== '' ? turnSource(e.text) : undefined
  // A pasted prompt is the person's words: its markup goes.
  const text = source ? e.text.trim() : unwrapPasted(e.text)
  const turn: LiveTurn = {
    id: e.turnId,
    n: c.turnCount + 1,
    startedAt: e.at,
    tools: 0,
    edits: 0,
    subTokens: 0,
    stepTokens: 0,
    inFlight: [],
    ...(e.costUsd !== undefined ? { costAtStart: e.costUsd } : {}),
    ...(text !== '' && !source ? { prompt: clip(maskSecrets(text), 80) } : {}),
    ...(source ? { source } : {}),
    ...(text !== '' ? { text: squeeze(maskSecrets(text), TURN_TEXT_CHARS) } : {}),
  }
  // A crossing nothing holds any more (open-ended work past its hold) closes before the turn picks one.
  return { ...c, turn, phase: { kind: 'thinking', since: e.at }, lastAt: e.at, crossing: crossingFor(settleCrossing(c, e.at), e.at, source) }
}

/** A crossing that closed this recently can still be carried on by the notice its own work sends. */
const CARRY_MS = 30 * 60_000

/**
 * The crossing a turn starting at `at` belongs to: the one under way, or the
 * one just closed when a job's or an agent's notice started the turn (its
 * work came back), else a new one from now.
 */
function crossingFor(c: Cockpit, at: number, source: TurnSource | undefined): Cockpit['crossing'] {
  const open = c.crossing
  if (open && open.closedAt === undefined) return open
  const isNotice = source?.kind === 'task' || source?.kind === 'report'
  if (open && isNotice && open.closedAt !== undefined && at - open.closedAt <= CARRY_MS) return { from: open.from }
  return { from: at }
}

/** Whether a running job still holds the crossing at `at`: younger than the hold (a job of a known length keeps the headline by its estimate). */
export function isJobHolding(j: Job, at: number | undefined): boolean {
  return isJobRunning(j) && (at === undefined || at - j.startedAt < OPEN_HOLD_MS)
}

/**
 * Whether any work is in hand: a turn running, Claude's own agents at work,
 * or background jobs Claude will come back to (at `at`, those still within
 * their hold).
 */
export function isWorking(c: Cockpit, at?: number): boolean {
  return c.turn !== undefined || c.agents.some(a => isCounted(a) && isAgentOpen(a)) || c.jobs.some(j => isJobHolding(j, at))
}

/** The crossing closed once nothing runs; the rest unchanged. */
export function settleCrossing(c: Cockpit, at: number): Cockpit {
  const open = c.crossing
  if (!open || open.closedAt !== undefined || isWorking(c, at)) return c
  return { ...c, crossing: { ...open, closedAt: at } }
}

/** A note of what happened this turn, the latest kept. */
function note(c: Cockpit, at: number, kind: TurnNote['kind'], text: string): Cockpit {
  const turn = c.turn
  if (!turn) return c
  return { ...c, turn: { ...turn, log: lastN([...(turn.log ?? []), { at, kind, text: clip(text, 80) }], MAX_NOTES) } }
}

export type TurnEnd = {
  at: number
  turnId: string
  agentId?: string
  /** Claude's final words for the turn ('' when it gave none). */
  answer?: string
  /** New tokens of the turn's own requests, as its end summed them (`newTokens` of its usage). */
  tokens: number
  durationMs: number
  isAborted: boolean
}

/** An aborted turn, or one with no usage, is no sample of a normal turn: the medians leave it out. */
const isSampleTurn = (t: Pick<TurnRecord, 'aborted' | 'tokens'>) => !t.aborted && t.tokens > 0

export function onTurnEnd(c: Cockpit, e: TurnEnd): Cockpit {
  if (e.agentId !== undefined) return c
  const live = c.turn?.id === e.turnId ? c.turn : undefined
  const startedAt = live?.startedAt ?? e.at - Math.max(0, e.durationMs)
  // The responses counted as each ended; the end's own sum covers any none counted (no hook saw them).
  const counted = live?.stepTokens ?? 0
  const own = Math.max(Math.max(0, e.tokens), counted)
  const tokens = own + (live?.subTokens ?? 0)
  const n = live?.n ?? c.turnCount + 1
  // The context as the turn left it: what its context detail draws, turn by turn.
  const ctx = contextNow(c).tokens
  const record: TurnRecord = {
    n,
    startedAt,
    endedAt: e.at,
    tokens,
    durationMs: Math.max(0, e.durationMs),
    ...(live?.firstTool ? { firstTool: live.firstTool } : {}),
    tools: live?.tools ?? 0,
    edits: live?.edits ?? 0,
    ...(live?.costAtStart !== undefined ? { costStart: live.costAtStart } : {}),
    ...(live?.prompt ? { prompt: live.prompt } : {}),
    ...(live?.source ? { source: live.source } : {}),
    ...(ctx !== undefined && ctx > 0 ? { ctx } : {}),
    ...(e.isAborted ? { aborted: true as const } : {}),
  }
  // Judged in USD once the ledger priced 5 earlier turns, else in tokens (as token-detox does). The
  // cost comes with the next reading, so a turn judged in USD waits for it.
  if (record.costStart !== undefined && c.turnUsd.length >= RUNAWAY_MIN_TURNS) record.pending = true
  else if (isRunaway(c.turnTokens, tokens)) {
    const mid = median(c.turnTokens)
    record.runaway = true
    if (mid !== undefined && mid > 0) record.factor = tokens / mid
  }
  const turnCount = Math.max(c.turnCount, n)
  let shift = c.shift
  if (shift.state === 'showing' && turnCount >= shift.untilTurn) shift = { state: 'done' }
  // Calls still in flight when the turn ended were cut off with it.
  const agents = c.agents.map(a => (a.status === 'running' && live?.inFlight.some(f => f.id === a.id) ? { ...a, status: 'failed' as const, endedAt: e.at } : a))
  const checks = c.checks.map(ch => (ch.status === 'running' && ch.turn === n ? { ...ch, status: 'interrupted' as const, endedAt: e.at } : ch))
  // An answer that ends on a question leaves it waiting on the person; any other answer settles it.
  const question = e.answer !== undefined && e.answer.trim() !== '' ? endingQuestion(e.answer) : c.question
  const { question: _was, ...rest } = c
  const ended: Cockpit = {
    ...rest,
    ...(question !== undefined ? { question } : {}),
    turn: undefined,
    turnCount,
    phase: { kind: 'idle', since: e.at },
    history: lastN([...c.history, record], HISTORY_TURNS),
    turnTokens: isSampleTurn(record) ? lastN([...c.turnTokens, tokens], MAX_MEDIAN) : c.turnTokens,
    recent: addRecent(c.recent, e.at, own - counted),
    tokens: c.tokens + tokens,
    // Working time leaves the turn's waits on the person out, as its reported length does.
    activeMs: c.activeMs + turnWorkMs(c, startedAt, e.at, e.durationMs),
    // Its length, as its end reported it, joins your turns' (an interrupted one is no sample).
    durations: e.isAborted ? c.durations : { ...c.durations, turns: noteTurn(c.durations.turns, e.durationMs) },
    shift,
    agents,
    checks,
    // The main loop's own waits end with its turn.
    waits: endWaits(c.waits, { agentId: undefined }, e.at),
    lastAt: e.at,
  }
  // A reading taken after the turn's last response holds its whole cost already.
  const r = c.reading
  const settled = r?.costUsd !== undefined && live?.lastStepAt !== undefined && r.at >= live.lastStepAt ? settleCost(ended, r.costUsd) : ended
  return settleCrossing(settled, e.at)
}

/**
 * A turn's working time: its length as Claude Code reported it, which already
 * leaves out the time its dialogs waited on the person (a live run measured
 * it: 41 s from start to end, 8 s reported, 33 s of them a question waiting);
 * where none was reported, its time less the waits quackpit saw.
 */
export function turnWorkMs(c: Pick<Cockpit, 'waits'>, startedAt: number, endedAt: number, durationMs: number | undefined): number {
  if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0) return Math.min(durationMs, Math.max(0, endedAt - startedAt))
  return activeMs(c.waits, startedAt, endedAt)
}

/** A finished turn's length as the person saw it worked on: its reported length, else its time. */
export function turnLength(h: Pick<TurnRecord, 'durationMs' | 'startedAt' | 'endedAt'>): number {
  return h.durationMs !== undefined && h.durationMs > 0 ? h.durationMs : Math.max(0, h.endedAt - h.startedAt)
}

/** How long the turn running has worked: its time so far less its waits on the person. */
export function turnWorkSoFar(c: Cockpit, now: number): number {
  return c.turn ? activeMs(c.waits, c.turn.startedAt, now) : 0
}

/**
 * The last turn's cost, from the first ledger reading after its last
 * response: the ledger's growth since the turn started. A turn waiting on it
 * is judged against the median of the turns priced before it.
 */
export function settleCost(c: Cockpit, ledger: number): Cockpit {
  const last = c.history.at(-1)
  if (!last || last.costUsd !== undefined || last.costStart === undefined) return c
  const { costStart, pending, ...rest } = last
  if (ledger < costStart) return { ...c, history: [...c.history.slice(0, -1), rest] }
  const usd = ledger - costStart
  const record: TurnRecord = { ...rest, costUsd: usd }
  if (pending && isRunaway(c.turnUsd, usd)) {
    const mid = median(c.turnUsd)
    record.runaway = true
    if (mid !== undefined && mid > 0) record.factor = usd / mid
  }
  return {
    ...c,
    history: [...c.history.slice(0, -1), record],
    turnUsd: isSampleTurn(record) && usd > 0 ? lastN([...c.turnUsd, usd], MAX_MEDIAN) : c.turnUsd,
  }
}

export type StepEnd = {
  at: number
  /** When its request went out: the prompt cache's lifetime counts from there. */
  startedAt: number
  turnId: string
  agentId?: string
  model?: string
  usage?: TokenUsage | null
  /** The response's visible text ('' when it only called tools). */
  answer?: string
}

/** How much of Claude's latest words an AI re-ask is told. */
const LAST_WORDS_CHARS = 400

/**
 * A loop's next model request going out (`turn.step` starting): whatever
 * dialog held that loop is over, since the loop has moved on. The safety net
 * behind a wait's own end (its call's first progress, or its answer).
 */
export function onStepStart(c: Cockpit, e: { at: number; agentId?: string }): Cockpit {
  const waits = endWaits(c.waits, { agentId: e.agentId }, e.at)
  return waits.some((w, i) => w !== c.waits[i]) ? withWaitNotes(c, { ...c, waits }, e.at) : c
}

/**
 * One main-loop response, as it ended (`turn.step`): its new tokens count
 * toward pace at once, and its prompt's parts toward the cache's share; its
 * words join the turn's, masked, for the AI ETA to read.
 * A subagent's are not the main loop's (its Agent result counts for it).
 */
export function onStep(c: Cockpit, e: StepEnd): Cockpit {
  if (e.agentId !== undefined || !e.usage) return c
  const tokens = newTokens(e.usage)
  const parts = cacheParts(e.usage)
  const output = isNum(e.usage.output_tokens) && e.usage.output_tokens > 0 ? e.usage.output_tokens : 0
  const said = e.answer !== undefined && e.answer.trim() !== '' ? maskSecrets(e.answer) : undefined
  // Outside a turn quackpit saw start (it joined during one), the turn's end counts it instead.
  const turn =
    c.turn && c.turn.id === e.turnId
      ? { ...c.turn, stepTokens: c.turn.stepTokens + tokens, lastStepAt: e.at, ...(said ? { words: addWords(c.turn.words, said), lastWords: clip(said, LAST_WORDS_CHARS) } : {}) }
      : undefined
  return noteShift({
    ...c,
    ...(turn ? { turn, recent: addRecent(c.recent, e.at, tokens) } : {}),
    cache: { read: c.cache.read + parts.read, write: c.cache.write + parts.write, input: c.cache.input + parts.input },
    lastStep: { ...parts, at: e.at, startedAt: e.startedAt, output, ...(e.model ? { model: e.model } : {}) },
    lastAt: Math.max(c.lastAt, e.at),
  })
}

// ---------------------------------------------------------------- waits on the person

/** The main loop's own calls that put something to the person: a question, a plan to approve. */
const PUTS_TO_PERSON: Readonly<Record<string, WaitKind>> = { AskUserQuestion: 'question', ExitPlanMode: 'plan' }

/** The kind of wait a tool's call is, when it puts something to the person itself. */
export function waitKindOf(tool: string): WaitKind | undefined {
  return PUTS_TO_PERSON[tool]
}

/**
 * A wait on the person begins: the main loop's question or plan, or a
 * permission dialog that really showed (one no hook and no auto-mode
 * classifier settled). It holds the loop that raised it, and the main loop
 * too when that is a subagent the main loop waits on in the foreground.
 */
export function onWaitStart(c: Cockpit, e: { at: number; kind: WaitKind; tool?: string; toolUseId?: string; agentId?: string; agentType?: string }): Cockpit {
  const isForeground = (id: string) => c.agents.some(a => a.agentId === id && a.status === 'running' && !a.isBackground)
  const main = e.agentId === undefined || isForeground(e.agentId)
  const wait: Wait = {
    from: e.at,
    kind: e.kind,
    main,
    ...(e.tool ? { tool: e.tool } : {}),
    ...(e.toolUseId ? { toolUseId: e.toolUseId } : {}),
    ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
    ...(e.agentType ? { agentType: e.agentType } : {}),
  }
  return { ...c, waits: startWait(c.waits, wait), lastAt: Math.max(c.lastAt, e.at) }
}

/** A call's wait ends: its first progress showed (the person approved it), or it answered. */
export function onWaitEnd(c: Cockpit, e: { at: number; toolUseId: string }): Cockpit {
  const waits = endWaits(c.waits, { toolUseId: e.toolUseId }, e.at)
  return waits.some((w, i) => w !== c.waits[i]) ? withWaitNotes(c, { ...c, waits }, e.at) : c
}

/** How long a permission wait has stood before a band drawn can end it: a draw under way as the dialog opened says nothing. */
export const DIALOG_SETTLE_MS = 500

/**
 * Claude Code draws the band again: it draws none while a dialog shows (a
 * probe asked for a redraw every second through two dialogs and got none),
 * so every permission dialog asked for before is answered. For a subagent's
 * call this is the one sign of the answer: its progress row is never drawn,
 * and its end comes only after it ran.
 */
export function onDialogsClosed(c: Cockpit, at: number): Cockpit {
  const isAnswered = (w: Wait) => w.to === undefined && w.kind === 'permission' && w.from + DIALOG_SETTLE_MS <= at
  if (!c.waits.some(isAnswered)) return c
  return withWaitNotes(c, { ...c, waits: c.waits.map(w => (isAnswered(w) ? { ...w, to: at } : w)) }, at)
}

/** In the AI ETA's words (English: the model reads them), a wait on the person that just ended. */
function waitNote(w: Wait, at: number): string {
  const long = formatShortSpan(Math.max(0, (w.to ?? at) - w.from))
  const who = w.agentId !== undefined ? `a ${w.agentType ?? 'subagent'} subagent's` : "Claude's"
  if (w.kind === 'question') return `the person answered ${who} question after ${long}`
  if (w.kind === 'plan') return `the person answered ${who} plan after ${long}`
  return `the person answered ${who} permission dialog${w.tool ? ` for ${w.tool}` : ''} after ${long}`
}

const formatShortSpan = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}`)

/**
 * The turn's notes with the waits holding the main loop that closed between
 * two cockpits; and once the AI ETA has answered this turn, a wait that ended
 * is a reason to ask it again.
 */
function withWaitNotes(before: Cockpit, after: Cockpit, at: number): Cockpit {
  const closed = after.waits.filter((w, i) => w.main && w.to !== undefined && before.waits[i]?.to === undefined && before.waits[i]?.from === w.from)
  const noted = closed.reduce((c, w) => note(c, at, 'answered', waitNote(w, at)), after)
  const turn = noted.turn
  if (closed.length === 0 || !turn || (turn.asks ?? []).length === 0 || turn.aiDue) return noted
  return { ...noted, turn: { ...turn, aiDue: { why: 'answered', at } } }
}

// ---------------------------------------------------------------- tools

export type ToolStart = { at: number; id: string; tool: string; input: Record<string, unknown>; agentId?: string }

export type ToolEnd = ToolStart & {
  /**
   * `ok` answered; `error` the tool ran and reported an error; `interrupted`
   * the person stopped it (Esc) while or before it ran; `denied` refused before
   * it ran (the permission dialog, a rule, a hook).
   */
  outcome: 'ok' | 'error' | 'interrupted' | 'denied'
  /** The result as the model read it. */
  text: string
  /** The tool's record, when it answered. */
  result?: unknown
  /** Rebuilt from the transcript: no timings were observed. */
  isReplay?: boolean
  /** It waited on a permission decision (a dialog, the mode's decider): the time around it was the wait's too. */
  wasAsked?: boolean
}

const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() !== '' ? x : undefined)

/** What a call is about, in a few words: a file name, a command, a pattern. */
export function toolSubject(tool: string, input: Record<string, unknown>): string | undefined {
  switch (tool) {
    case 'Bash':
      return str(input.description) ? clip(String(input.description), 48) : str(input.command) ? shownCommand(String(input.command), 48) : undefined
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return str(input.file_path) ? baseName(String(input.file_path)) : undefined
    case 'NotebookEdit':
      return str(input.notebook_path) ? baseName(String(input.notebook_path)) : undefined
    case 'Grep':
    case 'Glob':
      return str(input.pattern) ? clip(String(input.pattern), 40) : undefined
    case 'Agent':
      return str(input.description) ? clip(String(input.description), 40) : undefined
    case 'WebFetch': {
      const url = str(input.url)
      if (!url) return undefined
      const m = url.match(/^[a-z]+:\/\/([^/?#]+)/i)
      return m?.[1] ?? clip(url, 40)
    }
    case 'WebSearch':
      return str(input.query) ? clip(String(input.query), 40) : undefined
    case 'Skill':
      return str(input.skill) ? clip(String(input.skill), 40) : undefined
    case 'AskUserQuestion': {
      // The first question it asks, in Claude's words.
      const first = Array.isArray(input.questions) ? obj(input.questions[0]) : undefined
      return str(first?.question) ? clip(maskSecrets(String(first?.question)), 60) : undefined
    }
    default:
      if (tool.startsWith('mcp__')) {
        const [, server, name] = tool.split('__')
        return server && name ? `${server} · ${name}` : undefined
      }
      return undefined
  }
}

export function onToolStart(c: Cockpit, e: ToolStart): Cockpit {
  if (e.agentId !== undefined) return c
  const subject = toolSubject(e.tool, e.input)
  const seq = c.seq + 1
  const flight: InFlight = { id: e.id, tool: e.tool, at: e.at, seq, ...(subject ? { subject } : {}) }
  const turn = c.turn
    ? { ...c.turn, tools: c.turn.tools + 1, inFlight: [...c.turn.inFlight.filter(f => f.id !== e.id), flight].slice(-8), ...(c.turn.firstTool ? {} : { firstTool: e.id }) }
    : undefined
  let next: Cockpit = note({ ...c, seq, ...(turn ? { turn } : {}), phase: { kind: 'tool', tool: e.tool, since: e.at, ...(subject ? { subject } : {}) }, lastAt: e.at }, e.at, 'tool', subject ? `${e.tool} (${subject})` : e.tool)
  // A question or a plan put to the person: the main loop waits on them until it is answered.
  const kind = waitKindOf(e.tool)
  if (kind) next = onWaitStart(next, { at: e.at, kind, tool: e.tool, toolUseId: e.id })
  if (e.tool === 'Bash' && typeof e.input.command === 'string') {
    const kinds = checkKinds(e.input.command)
    const kind = kinds.at(-1)
    if (kind) {
      const check: CheckResult = {
        id: e.id,
        kind,
        ...(kinds.length > 1 ? { kinds } : {}),
        command: shownCommand(e.input.command),
        status: e.input.run_in_background === true ? 'background' : 'running',
        startedAt: e.at,
        turn: turn?.n ?? c.turnCount + 1,
        seq,
      }
      next = { ...next, checks: lastN([...c.checks.filter(ch => ch.id !== e.id), check], MAX_CHECKS) }
    }
  }
  if (e.tool === 'Agent') {
    const isBackground = e.input.run_in_background === true || e.input.run_in_background === 'true'
    const run: AgentRun = {
      id: e.id,
      description: str(e.input.description) ? clip(maskSecrets(String(e.input.description)), 60) : 'subagent',
      type: str(e.input.subagent_type) ?? 'general-purpose',
      startedAt: e.at,
      status: 'running',
      by: 'main',
      ...(isBackground ? { isBackground: true as const } : {}),
    }
    next = { ...next, agents: keepAgents([...next.agents.filter(a => a.id !== e.id), run]) }
  }
  return next
}

/** Alive: at work, idle between its turns, or waiting. */
export function isAgentLive(a: Pick<AgentRun, 'status'>): boolean {
  return isAgentOpen(a) || a.status === 'idle' || a.status === 'waiting'
}

/** The agents kept: every one alive, and the latest ended ones up to the limit. */
function keepAgents(agents: readonly AgentRun[]): AgentRun[] {
  const ended = agents.filter(a => !isAgentLive(a))
  const drop = new Set(ended.slice(0, Math.max(0, agents.length - MAX_AGENTS)))
  return agents.filter(a => !drop.has(a))
}

function obj(x: unknown): Record<string, unknown> | undefined {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined
}

export function onToolEnd(c: Cockpit, e: ToolEnd): Cockpit {
  // Another loop's call: only the wait it may have held ends with it.
  if (e.agentId !== undefined) return onWaitEnd(c, { at: e.at, toolUseId: e.id })
  // Its answer ends any wait it held: the question answered, the dialog's call gone on and done.
  let next: Cockpit = { ...onWaitEnd(c, { at: e.at, toolUseId: e.id }), lastAt: e.at }
  // Where the call started among the session's calls: a check started before an edit has not seen it.
  const seq = c.turn?.inFlight.find(f => f.id === e.id)?.seq ?? c.seq
  const turnNumber = c.turn?.n ?? c.turnCount + 1
  if (next.turn) {
    const inFlight = next.turn.inFlight.filter(f => f.id !== e.id)
    const latest = inFlight.at(-1)
    next.turn = { ...next.turn, inFlight }
    next.phase = latest
      ? { kind: 'tool', tool: latest.tool, since: latest.at, ...(latest.subject ? { subject: latest.subject } : {}) }
      : { kind: 'thinking', since: e.at }
  }
  const isError = e.outcome !== 'ok'

  if (TASK_TOOLS.has(e.tool)) {
    const tasks = applyTaskCall(c.tasks, { tool: e.tool, input: e.input, result: e.result, isError }, turnNumber, e.at)
    if (tasks !== c.tasks) {
      // A task that just finished keeps how long it waited on the person, which its length leaves out.
      const held = tasks ? { ...tasks, items: tasks.items.map(t => (t.status === 'completed' && t.doneAt !== undefined && t.startedAt !== undefined && t.heldMs === undefined ? { ...t, heldMs: heldMs(next.waits, t.startedAt, t.doneAt) } : t)) } : undefined
      const hadList = c.tasks?.items.some(t => t.status !== 'completed') === true
      next = { ...next, ...(held ? { tasks: held } : {}) }
      if (!hadList && held?.items.some(t => t.status !== 'completed')) next = note(next, e.at, 'list', `a task list of ${held.items.length} appeared`)
    }
  }

  if (isEditTool(e.tool) && e.outcome === 'ok') {
    const path = str(e.input.file_path) ?? str(e.input.notebook_path)
    if (path) {
      const created = e.tool === 'Write' && obj(e.result)?.type === 'create'
      const known = next.files.find(f => f.path === path)
      const replayed = e.isReplay ? { replayed: true as const } : {}
      const touch: FileTouch = known
        ? { path, edits: known.edits + 1, lastAt: e.at, ...(known.created ? { created: true as const } : {}), ...replayed }
        : { path, edits: 1, lastAt: e.at, ...(created ? { created: true as const } : {}), ...replayed }
      next = { ...next, files: lastN([...next.files.filter(f => f.path !== path), touch], MAX_FILES), edits: lastN([...next.edits, { path, at: e.at, seq }], MAX_EDITS) }
      if (next.turn) next.turn = { ...next.turn, edits: next.turn.edits + 1 }
    }
  }

  if (e.tool === 'Bash' && e.outcome === 'denied') {
    // Refused before it ran: a check it opened never happened.
    next = { ...next, checks: next.checks.filter(ch => ch.id !== e.id) }
  }

  if (e.tool === 'Bash' && typeof e.input.command === 'string' && e.outcome !== 'denied') {
    const result = obj(e.result)
    const background = typeof result?.backgroundTaskId === 'string' && result.backgroundTaskId !== ''
    const interrupted = e.outcome === 'interrupted' || result?.interrupted === true
    const kinds = checkKinds(e.input.command)
    const output = [str(result?.stdout), str(result?.stderr)].filter(Boolean).join('\n') || e.text
    const ok: boolean | null = background || interrupted ? null : !isError
    const replayed = e.isReplay ? { replayed: true as const } : {}
    if (kinds.length > 0) {
      const verdict = judgeCheck({ isError, interrupted, background, text: output, exitMasked: masksExit(e.input.command), exitIsPipe: exitIsPipe(e.input.command), kinds })
      const started = next.checks.find(ch => ch.id === e.id)
      const startedAt = started?.startedAt ?? e.at
      // A chain is one run of each check in it: it passed them all, or failed those its output names (else all).
      const judged = verdict.status === 'fail' ? (verdict.judged ?? kinds) : kinds
      const kind = (verdict.status === 'fail' ? judged[0] : undefined) ?? kinds.at(-1) ?? 'test'
      const check: CheckResult = {
        id: e.id,
        kind,
        ...(kinds.length > 1 ? { kinds } : {}),
        ...(verdict.judged ? { judged: verdict.judged } : {}),
        command: shownCommand(e.input.command),
        status: verdict.status,
        startedAt,
        endedAt: e.at,
        ...(e.isReplay || e.wasAsked ? {} : { durationMs: Math.max(0, e.at - startedAt) }),
        turn: turnNumber,
        seq: started?.seq ?? seq,
        ...(verdict.status === 'fail' ? { tail: failingLines(output) } : {}),
        ...replayed,
        ...verdict.counts,
      }
      next = { ...next, checks: lastN([...next.checks.filter(ch => ch.id !== e.id), check], MAX_CHECKS) }
      // One failure kept per kind: a later pass of that kind clears it, a pass of another kind does not.
      if (verdict.status === 'fail') {
        const failed = { command: check.command, at: e.at, output: failureTail(output), ...replayed }
        next.failures = [...next.failures.filter(f => !judged.includes(f.kind)), ...judged.map(k => ({ kind: k, ...failed }))]
      } else if (verdict.status === 'pass') {
        next.failures = next.failures.filter(f => !kinds.includes(f.kind))
        next.passing = [...next.passing.filter(p => !kinds.includes(p.kind)), ...kinds.map(k => ({ kind: k, command: check.command, at: e.at, ...replayed }))]
      }
      next.commands = lastN([...next.commands, { command: shownCommand(e.input.command, 160), at: e.at, ok: verdict.status === 'fail' ? false : verdict.status === 'hidden' ? null : ok, check: kind, ...replayed }], MAX_COMMANDS)
    } else {
      next.commands = lastN([...next.commands, { command: shownCommand(e.input.command, 160), at: e.at, ok, ...replayed }], MAX_COMMANDS)
    }
    // Sent to the background (asked to, or by a timeout or ctrl+b): a job from the call's start until its notice.
    const taskId = str(result?.backgroundTaskId)
    if (taskId && !e.isReplay && !next.jobs.some(j => j.id === taskId)) {
      const startedAt = c.turn?.inFlight.find(f => f.id === e.id)?.at ?? next.checks.find(ch => ch.id === e.id)?.startedAt ?? e.at
      const job = shellJob({ id: taskId, toolUseId: e.id, command: e.input.command, ...(str(e.input.description) ? { description: String(e.input.description) } : {}), startedAt })
      next = note({ ...next, jobs: trimJobs([...next.jobs, job]) }, e.at, 'job', `background command started: ${job.description ?? job.command ?? taskId}`)
    }
  }

  // The Monitor tool and the Workflow tool answer with a task id: background work from the call's start, as a shell's.
  if ((e.tool === 'Monitor' || e.tool === 'Workflow') && e.outcome === 'ok' && !e.isReplay) {
    const result = obj(e.result)
    const taskId = str(result?.taskId) ?? str(result?.task_id)
    if (taskId && !next.jobs.some(j => j.id === taskId)) {
      const kind = e.tool === 'Monitor' ? ('monitor' as const) : ('workflow' as const)
      const startedAt = c.turn?.inFlight.find(f => f.id === e.id)?.at ?? e.at
      const description = str(e.input.description) ?? str(result?.summary) ?? str(result?.workflowName)
      const job = taskJob({ id: taskId, kind, toolUseId: e.id, ...(kind === 'monitor' && str(e.input.command) ? { command: String(e.input.command) } : {}), ...(description ? { description } : {}), startedAt })
      next = note({ ...next, jobs: trimJobs([...next.jobs, job]) }, e.at, 'job', `${kind} started: ${job.description ?? job.command ?? taskId}`)
    }
  }

  if (e.tool === 'Agent') {
    const result = obj(e.result)
    const status = result?.status
    next.agents = next.agents.map(a => {
      if (a.id !== e.id) return a
      if (e.isReplay) a = { ...a, replayed: true }
      if (isError) return { ...a, status: 'failed' as const, endedAt: e.at }
      const agentId = str(result?.agentId) ?? str(result?.agent_id) ?? a.agentId
      // A cloud session answers with a task id, not an agent this session can list: launched is all it knows.
      if (status === 'remote_launched') return { ...a, status: 'remote' as const, endedAt: e.at }
      if (status === 'async_launched') {
        return agentId ? { ...a, status: 'background' as const, agentId, isBackground: true as const } : { ...a, status: 'done' as const, endedAt: e.at, isBackground: true as const }
      }
      // A teammate: a named agent of the team, at work now and idle between its turns.
      if (status === 'teammate_spawned') {
        return agentId ? { ...a, status: 'background' as const, agentId, isBackground: true as const, teammate: true as const } : { ...a, status: 'done' as const, endedAt: e.at, teammate: true as const }
      }
      const tokens = subagentTokens(e.input, result)
      const stats = obj(result?.toolStats)
      const held = agentId ? heldMs(next.waits, a.startedAt, e.at, { agentId }) : 0
      return {
        ...a,
        status: 'done' as const,
        endedAt: e.at,
        ...(held > 0 ? { heldMs: held } : {}),
        ...(agentId ? { agentId } : {}),
        ...(tokens > 0 ? { tokens } : {}),
        ...(isNum(result?.totalDurationMs) ? { durationMs: result.totalDurationMs } : {}),
        ...(isNum(result?.totalToolUseCount) ? { toolUses: result.totalToolUseCount } : {}),
        ...(isNum(stats?.linesAdded) && stats.linesAdded > 0 ? { added: stats.linesAdded } : {}),
        ...(isNum(stats?.linesRemoved) && stats.linesRemoved > 0 ? { removed: stats.linesRemoved } : {}),
      }
    })
    // A foreground run's new tokens join the turn's, and pace at once.
    const tokens = status === 'completed' ? subagentTokens(e.input, result) : 0
    if (tokens > 0 && next.turn) next = { ...next, turn: { ...next.turn, subTokens: next.turn.subTokens + tokens }, recent: addRecent(next.recent, e.at, tokens) }
    const run = next.agents.find(a => a.id === e.id)
    if (run && !e.isReplay) next = note(next, e.at, isAgentOpen(run) ? 'agent' : 'agentEnd', `${run.type} subagent ${isAgentOpen(run) ? 'started in the background' : run.status === 'done' ? 'finished' : run.status}: ${run.description}`)
  }
  return settleCrossing(withLengths(c, next), e.at)
}

/** A change's cockpit with what it finished measured: the lengths the estimate of what is left reads. */
function withLengths(before: Cockpit, after: Cockpit): Cockpit {
  const durations = noteLengths(before, after)
  return durations === after.durations ? after : { ...after, durations }
}

/**
 * A finished foreground subagent's new tokens, from its Agent result. Its
 * `usage` is its last response's alone (so it is in this build's code), and
 * `totalTokens` that response's whole prompt and answer: every part of the
 * run's context was written to the cache once on the way, so that is what the
 * run wrote and generated, its cache re-reads left out. A fork's prompt opens
 * with the main thread's own transcript, counted already: a fork counts its
 * last response's own new tokens alone.
 */
export function subagentTokens(input: Record<string, unknown>, result: Record<string, unknown> | undefined): number {
  if (!result) return 0
  if (input.subagent_type === 'fork') return newTokens(obj(result.usage) as TokenUsage | undefined)
  return isNum(result.totalTokens) && result.totalTokens > 0 ? result.totalTokens : 0
}

// ---------------------------------------------------------------- readings

/**
 * A usage reading (`session.measure`, or a read at start-up and at a turn's
 * start): context fill, plan windows, the cost ledger. Between turns the
 * ledger also settles the cost of the turn that just ended.
 */
export function onReading(c: Cockpit, reading: Reading): Cockpit {
  // A reading that arrives late (taken before the one kept) is no news.
  if (c.reading && reading.at < c.reading.at) return c
  const r = withKnown(reading, c.reading)
  let fiveSamples = c.fiveSamples
  // The forecast samples what readings said, not what was carried over.
  const five = reading.fiveHour
  if (five) {
    const last = fiveSamples.at(-1)
    const was = c.reading?.fiveHour?.resetsAt
    // A new window (another reset time, or the % fell) starts the samples over.
    const isNew = (last && five.pct < last[1]) || (was !== undefined && five.resetsAt !== undefined && five.resetsAt !== was)
    const base = isNew ? [] : fiveSamples
    fiveSamples = lastN([...base.filter(([t]) => t > r.at - SAMPLE_WINDOW_MS && t < r.at), [r.at, five.pct] as [number, number]], MAX_SAMPLES)
  }
  const began = r.sessionStartedAt !== undefined ? { sessionStartedAt: r.sessionStartedAt } : {}
  const measured = reading.pushed ? { measuredAt: reading.at } : {}
  return settleWith(noteShift({ ...c, ...began, ...measured, reading: r, fiveSamples, lastAt: Math.max(c.lastAt, r.at) }), r)
}

/**
 * When the plan windows were last known as they are. Claude Code has them only
 * from this session's own responses, and pushes a reading whenever one moves a
 * whole point, so what quackpit holds is within a point of them as of the main
 * loop's last response, or of the last pushed reading where that came later (a
 * subagent's response moving a window). A reading quackpit asked for itself (at
 * a turn's start) is no fresher than that. Before any response or push: when it
 * was read. Undefined before anything was read.
 */
export function limitsAt(c: Cockpit): number | undefined {
  if (!c.reading) return undefined
  const known = Math.max(c.lastStep?.at ?? 0, c.measuredAt ?? 0)
  return known > 0 ? known : c.reading.at
}

/** Between turns, a ledger reading taken after the last turn ended settles that turn's cost. */
export function settleWith(c: Cockpit, r: Reading): Cockpit {
  const last = c.history.at(-1)
  return !c.turn && r.costUsd !== undefined && last && r.at >= last.endedAt ? settleCost(c, r.costUsd) : c
}

export type Fill = {
  tokens?: number
  /** Of the window. */
  pct?: number
  window?: number
  /** Where Claude Code compacts it by itself; absent when auto-compact is off or not known. */
  autoCompact?: number
}

/**
 * A reading with what it did not carry and the last one did: a plan window
 * until its reset (a read made as the session opens can come before Claude
 * Code has its windows), and the ledger. The context's fill is never carried:
 * one a reading lacks is unknown (after a compaction, before a response).
 */
function withKnown(r: Reading, last: Reading | undefined): Reading {
  if (!last) return r
  const lasts = (w: Window | undefined) => w !== undefined && (w.resetsAt === undefined || w.resetsAt > r.at)
  return {
    ...r,
    ...(r.fiveHour === undefined && lasts(last.fiveHour) ? { fiveHour: last.fiveHour } : {}),
    ...(r.sevenDay === undefined && lasts(last.sevenDay) ? { sevenDay: last.sevenDay } : {}),
    ...(r.costUsd === undefined && last.costUsd !== undefined ? { costUsd: last.costUsd } : {}),
  }
}

/** The context's fill now: from whichever is newer, the last reading or the main loop's last response. */
export function contextNow(c: Cockpit): Fill {
  const r = c.reading
  const window = r?.contextWindow !== undefined && r.contextWindow > 0 ? r.contextWindow : undefined
  const autoCompact = c.autoCompact?.isOn && c.autoCompact.threshold !== undefined && c.autoCompact.threshold > 0 ? c.autoCompact.threshold : undefined
  const extra = { ...(window ? { window } : {}), ...(autoCompact ? { autoCompact } : {}) }
  const step = c.lastStep
  // A compaction leaves the fill unknown until the next response says it.
  const isFresh = (at: number) => c.compactedAt === undefined || at > c.compactedAt
  if (step && isFresh(step.at) && (!r || step.at > r.at)) {
    const tokens = step.read + step.write + step.input
    return { tokens, ...(window ? { pct: (100 * tokens) / window } : {}), ...extra }
  }
  if (!r || !isFresh(r.at)) return extra
  return {
    ...(r.contextTokens !== undefined ? { tokens: r.contextTokens } : {}),
    ...(r.contextPct !== undefined ? { pct: r.contextPct } : {}),
    ...extra,
  }
}

/**
 * How far the context has come toward being compacted, in percent: of the
 * auto-compact point while auto-compact is on, else of the window. What the
 * ring's colour and the duck's context caution read.
 */
export function contextShare(fill: Fill): number | undefined {
  if (fill.autoCompact !== undefined && fill.tokens !== undefined) return (100 * fill.tokens) / fill.autoCompact
  return fill.pct
}

/** Past this many tokens a session is long enough to hand over, however large its window: quality slips first. */
export const SHIFT_TOKENS = 200_000
/** In a window over 200k (a 1M one) the hint waits longer: at 200k it would show in most sessions. */
export const SHIFT_TOKENS_LARGE = 400_000

/** The context size past which "shift change soon" shows, for a window of `window` tokens. */
export function shiftTokens(window: number | undefined): number {
  return window !== undefined && window > SHIFT_TOKENS ? SHIFT_TOKENS_LARGE : SHIFT_TOKENS
}

/**
 * "Shift change soon" shows once a session, from the moment the context
 * passes the smaller of 200k tokens (400k in a window over 200k) and 80% of
 * the auto-compact point (or of the window while auto-compact is off).
 */
function noteShift(c: Cockpit): Cockpit {
  if (c.shift.state !== 'armed') return c
  const fill = contextNow(c)
  const room = fill.autoCompact ?? fill.window
  const isPast =
    fill.tokens !== undefined && room !== undefined ? fill.tokens >= Math.min(shiftTokens(fill.window), 0.8 * room) : (fill.pct ?? 0) >= 80
  return isPast ? { ...c, shift: { state: 'showing', untilTurn: c.turnCount + (c.turn ? 2 : 1) } } : c
}

/**
 * A fresh cockpit for a session, with what events that came before the
 * session was known left in a placeholder (no session id): the session's
 * first measurement can arrive while quackpit is still starting, and after
 * /clear the first prompt can be taken in while the session is being synced.
 */
export function adoptEarly(fresh: Cockpit, early: Cockpit | undefined): Cockpit {
  if (!early || early.sid !== '') return fresh
  let next = fresh
  if (early.reading) next = onReading(next, early.reading)
  if (early.autoCompact && !next.autoCompact) next = { ...next, autoCompact: early.autoCompact }
  // The person's prompt taken in early belongs to their stretch.
  const stretch = joinStretch(next.stretch, early.stretch)
  if (stretch) next = { ...next, stretch }
  // The person's words, where the transcript gave none: the prompt starting this session is its mission.
  if (next.goal === undefined && !next.goalLost && early.goal !== undefined) {
    next = {
      ...next,
      goal: early.goal,
      prompts: [...next.prompts, ...early.prompts],
      ...(early.lastPrompt !== undefined ? { lastPrompt: early.lastPrompt } : {}),
    }
  }
  return next
}

/** The auto-compact point as the breakdown gave it (at most once a turn). */
export function onCompactPoint(c: Cockpit, e: { at: number; isOn: boolean; threshold?: number }): Cockpit {
  const point: AutoCompact = { at: e.at, turn: c.turnCount, isOn: e.isOn, ...(e.threshold !== undefined ? { threshold: e.threshold } : {}) }
  return noteShift({ ...c, autoCompact: point })
}

/** Whether the auto-compact point is due to be read again: once a turn, and once at the start. */
export function isCompactPointDue(c: Cockpit): boolean {
  return !c.turn && (c.autoCompact === undefined || c.autoCompact.turn < c.turnCount)
}

export function onCompact(c: Cockpit, e: { at: number; agentId?: string; isSkipped: boolean; isPrecompute: boolean }): Cockpit {
  if (e.agentId !== undefined || e.isSkipped || e.isPrecompute) return c
  // What filled the context before is gone: its split with it, until the window is measured again.
  const { ctx: _was, ...rest } = c
  return { ...rest, compactions: c.compactions + 1, compactedAt: e.at, compactTimes: lastN([...(c.compactTimes ?? []), e.at], 10), lastAt: e.at }
}

/** What fills the context, as measured: the latest split replaces the one before. */
export function onContextSplit(c: Cockpit, split: ContextSplit): Cockpit {
  return { ...c, ctx: split }
}

/** Background tasks another loop started are kept apart, the latest 20: a turn's end lists them, and they are never Claude's jobs. */
const MAX_FOREIGN = 20

/** A background task another loop started (a teammate's shell, a subagent's monitor): never one of Claude's jobs. */
export function onForeignTask(c: Cockpit, id: string): Cockpit {
  if (c.foreign?.includes(id)) return c
  const foreign = lastN([...(c.foreign ?? []), id], MAX_FOREIGN)
  // Listed before its call came back, it was taken for Claude's: it leaves the jobs.
  const jobs = c.jobs.filter(j => j.id !== id || j.toolUseId !== undefined)
  return { ...c, foreign, ...(jobs.length !== c.jobs.length ? { jobs } : {}) }
}

export function onMeta(c: Cockpit, meta: Meta): Cockpit {
  const merged: Meta = { ...c.meta }
  for (const [k, v] of Object.entries(meta) as [keyof Meta, string | undefined][]) {
    if (typeof v === 'string' && v !== '') merged[k] = v
  }
  return { ...c, meta: merged }
}

// ---------------------------------------------------------------- agents: start, list, end

/** An agent loop starting, as `agent.spawn` answered it: the Agent tool's, a workflow's, a plugin's. */
export type AgentSpawn = {
  at: number
  /** The Agent call's id (for a workflow agent, the Workflow call's, shared by its agents). */
  toolUseId: string
  agentId: string
  type: string
  description: string
  background: boolean
  /** Who started it: the main loop, a workflow it ran, a plugin, or another agent. */
  by: NonNullable<AgentRun['by']>
  byName?: string
  isTeammate?: boolean
}

/**
 * An agent started: the main loop's own Agent call gets its id (and the
 * background flag the call settled on); any other (a workflow's agent, a
 * plugin's, one another agent started) joins the list as `agent:<id>`.
 */
export function onAgentSpawn(c: Cockpit, e: AgentSpawn): Cockpit {
  if (c.agents.some(a => a.agentId === e.agentId)) return c
  const own = e.by === 'main' ? c.agents.find(a => a.id === e.toolUseId && a.agentId === undefined) : undefined
  let next: Cockpit
  if (own) {
    next = { ...c, agents: c.agents.map(a => (a === own ? { ...a, agentId: e.agentId, ...(e.background ? { isBackground: true as const } : {}), ...(e.isTeammate ? { teammate: true as const } : {}) } : a)) }
  } else {
    const run: AgentRun = {
      id: `agent:${e.agentId}`,
      agentId: e.agentId,
      description: e.description.trim() !== '' ? clip(maskSecrets(e.description), 60) : 'subagent',
      type: e.type || 'general-purpose',
      startedAt: e.at,
      status: e.background ? 'background' : 'running',
      by: e.by,
      ...(e.byName ? { byName: clip(e.byName, 40) } : {}),
      ...(e.background ? { isBackground: true as const } : {}),
      ...(e.isTeammate ? { teammate: true as const } : {}),
    }
    next = { ...c, agents: keepAgents([...c.agents, run]) }
    if (isCounted(run)) next = note(next, e.at, 'agent', `${run.type} subagent started${e.by === 'workflow' ? ' by a workflow' : ''}: ${run.description}`)
  }
  return { ...next, lastAt: Math.max(c.lastAt, e.at) }
}

/** One agent as the host lists it now (`$.agent.list()`). */
export type ListedAgent = { id: string; status: string; type?: string; description?: string; parentId?: string; spawnedBy?: string; teammateId?: string; name?: string }

const ENDED_WORDS = new Set(['completed', 'failed', 'killed'])
/** Alive and not at work, as the agents' list says it: not running. */
const WAITING_WORDS = new Set(['waiting', 'pending'])

/** How a run ends, by the word its notice or the list gave. */
function endedAs(status: string | undefined): AgentRun['status'] {
  if (status === 'failed' || status === 'error' || status === 'blocked') return 'failed'
  if (status === 'killed' || status === 'stopped' || status === 'cancelled' || status === 'canceled') return 'stopped'
  return 'done'
}

/** A run that ended at `at`, its own waits on the person kept to leave out of its length. */
function endRun(c: Cockpit, a: AgentRun, at: number, status: AgentRun['status']): AgentRun {
  const end = a.endedAt ?? at
  const held = a.agentId ? heldMs(c.waits, a.startedAt, end, { agentId: a.agentId }) : 0
  return { ...a, status, endedAt: end, ...(held > 0 ? { heldMs: held } : {}) }
}

/**
 * The agents as the host lists them now. One not known yet joins (first seen
 * now, so its start is when quackpit first saw it; started by the main loop
 * unless it names a parent agent or a plugin); a teammate between turns is
 * idle; one the list says ended, or a run of ours the list showed before and
 * no longer holds, has ended. A workflow's agents are never listed, so their
 * absence ends nothing.
 */
export function onAgentList(c: Cockpit, at: number, listed: readonly ListedAgent[], isWhole = true): Cockpit {
  const byId = new Map(listed.map(a => [a.id, a]))
  let changed = false
  let next: Cockpit = c
  const agents = c.agents.map(a => {
    if (!a.agentId || a.status === 'remote' || !isAgentLive(a)) return a
    const row = byId.get(a.agentId)
    if (!row) {
      if (!isWhole || a.by === 'workflow' || a.listed !== true) return a
      changed = true
      if (isCounted(a)) next = note(next, at, 'agentEnd', `${a.type} subagent finished: ${a.description}`)
      return endRun(c, a, at, 'done')
    }
    if (ENDED_WORDS.has(row.status)) {
      changed = true
      if (isCounted(a)) next = note(next, at, 'agentEnd', `${a.type} subagent ${row.status}: ${a.description}`)
      return endRun(c, { ...a, listed: true as const }, at, endedAs(row.status))
    }
    // Idle (a teammate between turns), waiting or queued: alive, not running. Running again: in the background or the foreground it began in.
    const status: AgentRun['status'] = row.status === 'idle' ? 'idle' : WAITING_WORDS.has(row.status) ? 'waiting' : a.isBackground || a.status === 'background' || a.status === 'idle' || a.status === 'waiting' ? 'background' : 'running'
    if (status !== a.status || a.listed !== true) {
      changed = true
      return { ...a, status, listed: true as const }
    }
    return a
  })
  const known = new Set(c.agents.map(a => a.agentId).filter((id): id is string => id !== undefined))
  const fresh: AgentRun[] = []
  for (const row of listed) {
    if (known.has(row.id) || ENDED_WORDS.has(row.status)) continue
    const by: NonNullable<AgentRun['by']> = row.spawnedBy ? 'plugin' : row.parentId ? 'agent' : 'main'
    const parent = row.parentId ? c.agents.find(a => a.agentId === row.parentId) : undefined
    const byName = row.spawnedBy ?? parent?.type
    fresh.push({
      id: `agent:${row.id}`,
      agentId: row.id,
      description: row.description && row.description.trim() !== '' ? clip(maskSecrets(row.description), 60) : clip(row.name ?? 'subagent', 60),
      type: row.type || 'general-purpose',
      startedAt: at,
      status: row.status === 'idle' ? 'idle' : WAITING_WORDS.has(row.status) ? 'waiting' : 'background',
      isBackground: true,
      by,
      ...(byName ? { byName: clip(byName, 40) } : {}),
      seenLate: true,
      listed: true,
      ...(row.teammateId ? { teammate: true as const } : {}),
    })
  }
  if (!changed && fresh.length === 0) return c
  return settleCrossing(withLengths(c, { ...next, agents: keepAgents([...agents, ...fresh]) }), at)
}

/**
 * A subagent's loop ended a turn (its own `turn.complete`): a subagent is
 * done (its notice says how, if one comes); a teammate goes idle until a
 * message wakes it. Its waits on the person end with it.
 */
export function onAgentTurnEnd(c: Cockpit, e: { at: number; agentId: string; isAborted: boolean }): Cockpit {
  const waits = endWaits(c.waits, { agentId: e.agentId }, e.at)
  const hasClosed = waits.some((w, i) => w !== c.waits[i])
  const base: Cockpit = hasClosed ? { ...c, waits } : c
  const run = c.agents.find(a => a.agentId === e.agentId)
  if (!run || !isAgentOpen(run)) return base
  if (run.teammate) return settleCrossing({ ...base, agents: base.agents.map(a => (a === run ? { ...a, status: 'idle' as const } : a)) }, e.at)
  const done = endRun(base, run, e.at, e.isAborted ? 'stopped' : 'done')
  const noted = isCounted(run) ? note(base, e.at, 'agentEnd', `${run.type} subagent ${e.isAborted ? 'was stopped' : 'finished'}: ${run.description}`) : base
  return settleCrossing(withLengths(c, { ...noted, agents: noted.agents.map(a => (a === run ? done : a)) }), e.at)
}

/**
 * The notices a turn's text (or a prompt delivered into a turn) carries: each
 * names a task that ended. A job ends as its notice says, and a background
 * check among them is judged by its exit code; an agent's run ends as its
 * notice says, if it had not yet.
 */
export function onNotices(c: Cockpit, at: number, notices: readonly TaskNotice[]): Cockpit {
  let next = c
  for (const n of notices) {
    // A monitor's events come as notices too: news from a task still running, which end nothing.
    if (n.isEvent) continue
    const job = next.jobs.find(j => (n.taskId !== undefined && j.id === n.taskId) || (n.toolUseId !== undefined && j.toolUseId === n.toolUseId))
    if (job) {
      if (isJobOpen(job)) next = endJob(next, job, at, endStatus(n.status, n.exitCode), n.exitCode)
      else if (job.isGone && job.exitCode === undefined) {
        // Found live: a run that failed at once was gone from the turn's end before its notice came.
        // The notice says how it ended; when stays unseen (its length is not kept).
        const open: Job = { ...job, status: 'running' }
        next = endJob({ ...next, jobs: next.jobs.map(j => (j === job ? open : j)) }, open, job.endedAt ?? at, endStatus(n.status, n.exitCode), n.exitCode)
      }
      continue
    }
    const run = next.agents.find(a => (n.taskId !== undefined && a.agentId === n.taskId) || (n.toolUseId !== undefined && a.id === n.toolUseId))
    if (run && isAgentLive(run)) {
      const done = endRun(next, run, at, endedAs(n.status))
      next = withLengths(next, { ...next, agents: next.agents.map(a => (a === run ? done : a)) })
    }
  }
  return next === c ? c : settleCrossing({ ...next, lastAt: Math.max(next.lastAt, at) }, at)
}

/**
 * A job ended: its status and exit, and for a background check, its verdict
 * from the exit code (a failure stands for its kinds until a later run passes
 * them, as a foreground run's does).
 */
function endJob(c: Cockpit, job: Job, at: number, status: Job['status'], exitCode: number | undefined): Cockpit {
  const done: Job = { ...job, status, endedAt: at, ...(exitCode !== undefined ? { exitCode } : {}) }
  const what = job.description ?? job.command ?? job.id
  let next: Cockpit = note({ ...c, jobs: c.jobs.map(j => (j === job ? done : j)) }, at, 'jobEnd', `background command ${status === 'done' ? 'finished' : status}${exitCode !== undefined ? ` (exit code ${exitCode})` : ''}: ${what}`)
  const check = job.toolUseId ? next.checks.find(ch => ch.id === job.toolUseId && ch.status === 'background') : undefined
  if (!check || !job.command) return next
  const verdict = jobVerdict(job.command, status, exitCode)
  const kinds = check.kinds ?? [check.kind]
  // Its length is the run's, from its start to its notice; where either went unseen, none (never the call's own instant).
  const { durationMs: _call, ...rest } = check
  const judged: CheckResult = { ...rest, status: verdict, endedAt: at, ...(job.isLate || job.isGone ? {} : { durationMs: Math.max(0, at - check.startedAt) }) }
  next = { ...next, checks: next.checks.map(ch => (ch === check ? judged : ch)) }
  if (verdict === 'fail') {
    const failed = { command: check.command, at, output: exitCode !== undefined ? `Exit code ${exitCode}` : '' }
    next = { ...next, failures: [...next.failures.filter(f => !kinds.includes(f.kind)), ...kinds.map(k => ({ kind: k, ...failed }))] }
  } else if (verdict === 'pass') {
    next = {
      ...next,
      failures: next.failures.filter(f => !kinds.includes(f.kind)),
      passing: [...next.passing.filter(p => !kinds.includes(p.kind)), ...kinds.map(k => ({ kind: k, command: check.command, at }))],
    }
  }
  return next
}

/**
 * The work still in flight as a main turn's end lists it (`classic.Stop`'s
 * `background_tasks`): shells, monitors and workflows become jobs, by the
 * status listed (one not seen to start joins; one no longer listed ended
 * unseen). Agent-like tasks are never jobs: a subagent's task carries its
 * agent's own id, and one not known yet joins as the agents' list would have
 * it; a teammate's carries a task id of its own and a status that stays
 * `running` while the teammate idles for hours (a probe on 2.1.296 saw it),
 * so teammates are the agents' list's alone, which knows when they idle.
 */
export function onBackgroundTasks(c: Cockpit, at: number, tasks: readonly ListedTask[]): Cockpit {
  const jobs = reconcileJobs(c.jobs, tasks, at, c.foreign ?? [])
  const sameJobs = jobs.length === c.jobs.length && jobs.every((j, i) => j === c.jobs[i])
  const withJobs: Cockpit = sameJobs ? c : { ...c, jobs }
  const known = new Set(c.agents.map(a => a.agentId))
  const fresh = tasks
    .filter(t => listedKind(t.type) === 'agent' && /^(?:subagent|local_agent|agent)$/i.test(t.type.trim()) && !known.has(t.id))
    .map((t): ListedAgent => ({ id: t.id, status: t.status ?? 'running', ...(t.agent_type ? { type: t.agent_type } : {}), ...(t.description ? { description: t.description } : {}) }))
  const next = fresh.length > 0 ? onAgentList(withJobs, at, fresh, false) : withJobs
  return next === c ? c : settleCrossing(next, at)
}

/**
 * The edits no passing check has seen: those whose call started after the
 * latest passing check's (of any kind) started. Undefined until a check passes.
 */
export function unverified(c: Cockpit): { count: number; paths: string[] } | undefined {
  const pass = c.checks.findLast(ch => ch.status === 'pass')
  if (!pass || pass.seq === undefined) return undefined
  const after = c.edits.filter(edit => edit.seq > (pass.seq ?? Infinity))
  return { count: after.length, paths: [...new Set(after.map(edit => edit.path))] }
}

export function hasRunningAgents(c: Cockpit): boolean {
  return c.agents.some(a => a.status === 'running' || a.status === 'background')
}

// ---------------------------------------------------------------- the duck's memory

export function acknowledge(c: Cockpit, keys: readonly string[]): Cockpit {
  const ack = [...new Set([...c.ack, ...keys])].slice(-50)
  return { ...c, ack }
}

export function markSeen(c: Cockpit, keys: readonly string[]): Cockpit {
  if (keys.every(k => c.seen.includes(k))) return c
  return { ...c, seen: [...new Set([...c.seen, ...keys])].slice(-50) }
}

export function markHandover(c: Cockpit, at: number): Cockpit {
  return { ...c, handoverAt: at, shift: c.shift.state === 'showing' ? { state: 'done' } : c.shift }
}

// ---------------------------------------------------------------- resumed sessions

/** A transcript message, in the shape `$.session.messages()` answers. */
export type PastMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly {
    tool_use_id: string
    tool: string
    input: Record<string, unknown>
    result?: unknown
    text?: string
    isError?: true
    /** How the adapter read the call's end; absent, `isError` alone decides. */
    outcome?: ToolEnd['outcome']
  }[]
}

/** Claude Code's summary at the head of a compacted transcript: the rows before it are gone. */
const SUMMARY_RE = /^This session is being continued from a previous conversation/i

/** Another session's message, as Claude Code frames it (a subagent's hand-back arrives so too). */
const PEER_RE = /^Another Claude session sent a message/
/** A plugin's `$.prompt.submit`, as the model reads it. */
const PLUGIN_RE = /^The (.{1,60}?) plugin sent a message/

/**
 * User rows no person typed: commands and their output, reminders, hook and
 * task output, agents' and teammates' messages (all markup), another
 * session's or a plugin's message, a background event's notice, an image's
 * placeholder, the old caveat line before local commands, an interruption's
 * marker, and the compaction summary.
 */
const NOT_TYPED: readonly RegExp[] = [
  // Markup, but never a paste: that is the person's own words, wrapped.
  /^<(?!pasted_content\b)/,
  /^\//,
  SUMMARY_RE,
  PEER_RE,
  PLUGIN_RE,
  /^\[SYSTEM NOTIFICATION/,
  /^\[Image: original \d+x\d+/,
  /^Caveat: The messages below were generated by the user/i,
  /^\[Request interrupted by user/,
  /^\[Tool call did not complete/,
]

/** Whether a transcript row is a prompt the person typed (or pasted). */
export function isTypedPrompt(text: string): boolean {
  const t = text.trim()
  return t !== '' && unwrapPasted(t) !== '' && !NOT_TYPED.some(re => re.test(t))
}

/** A name a turn's source carries (a task's, a teammate's summary, a command), masked and short. */
const nameOf = (text: string | undefined) => (text && text.trim() !== '' ? clip(maskSecrets(text.trim()), 48) : undefined)

/**
 * What started a turn that no person typed, from the text it began with: a
 * subagent's report handed back, a background task's notice (with the task's
 * own description when its summary gives one), a teammate's or another
 * session's message, a background event, a slash command, the summary a
 * compaction continues from, a plugin's message, or other markup. Undefined
 * for a prompt the person typed.
 */
export function turnSource(text: string): TurnSource | undefined {
  const t = text.trim()
  if (isTypedPrompt(t)) return undefined
  const named = (kind: TurnSourceKind, name: string | undefined): TurnSource => {
    const shown = nameOf(name)
    return shown ? { kind, name: shown } : { kind }
  }
  const handBack = /\[Subagent hand-back\]/.test(t.slice(0, 600))
  if (PEER_RE.test(t) || /^<agent-message\b/.test(t)) return { kind: handBack ? 'report' : 'peer' }
  if (/^<task-notification\b/.test(t)) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(t)?.[1]
    // `Agent "Map the parser" finished`, `Background command "Run the tests" completed (exit code 0)`: the task's own words.
    return named('task', /^\w+(?: \w+)* "(.+)" \w+/.exec(summary?.trim() ?? '')?.[1] ?? summary)
  }
  if (/^<teammate-message\b/.test(t)) return named('teammate', /\bsummary="([^"]*)"/.exec(t)?.[1])
  if (/^\[SYSTEM NOTIFICATION/.test(t)) return { kind: 'event' }
  if (/^<command-(?:name|message)>/.test(t)) return named('command', /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(t)?.[1])
  if (SUMMARY_RE.test(t)) return { kind: 'compaction' }
  const plugin = PLUGIN_RE.exec(t)
  if (plugin) return named('plugin', plugin[1])
  if (t.startsWith('/')) return named('command', t.split(/\s/)[0])
  return { kind: 'system' }
}

/**
 * Rebuilds what the transcript still holds (the goal, the task list, files,
 * commands and checks) for a session quackpit joined late: a resume, a
 * process that restarted, a reload or an install mid-session. Turn costs and
 * pace are not in the transcript and start from now. The goal is the first
 * row the person typed; when Claude Code's compaction summary comes before
 * any, the first prompt is gone and the mission is unknown, never a later one.
 */
export function backfill(c: Cockpit, messages: readonly PastMessage[], at: number, userTurns: number): Cockpit {
  // Joined late only where Claude had answered before: a transcript of slash commands and the prompt now
  // starting (a /clear, a first prompt) is a fresh start, whatever reloaded the module in between.
  const worked = messages.some(m => m.role !== 'user' && (m.text.trim() !== '' || m.toolUses.length > 0))
  let next: Cockpit = worked ? { ...c, joinedLate: true } : c
  for (const m of messages) {
    if (m.role === 'user') {
      const text = m.text.trim()
      if (next.goal === undefined && !next.goalLost && SUMMARY_RE.test(text)) next.goalLost = true
      else if (isTypedPrompt(text)) next = onPrompt(next, { at, text, isPersonal: true, isReplay: true })
      continue
    }
    // Claude's words: a reply that ends on a question waits on the person, until they write again.
    if (m.text.trim() !== '') {
      const { question: _was, ...rest } = next
      const question = endingQuestion(m.text)
      next = { ...rest, ...(question !== undefined ? { question } : {}) }
    }
    for (const use of m.toolUses) {
      if (use.text === undefined && use.result === undefined) continue
      const outcome = use.outcome ?? (use.isError ? 'error' : 'ok')
      const base: ToolStart = { at, id: use.tool_use_id, tool: use.tool, input: use.input }
      next = onToolStart(next, base)
      next = onToolEnd(next, { ...base, outcome, text: use.text ?? '', result: use.result, isReplay: true })
    }
  }
  // Claude Code's count of turns takes in the slash commands too: with no work in the transcript it is no count of work.
  return { ...next, turnCount: worked ? Math.max(next.turnCount, userTurns) : next.turnCount, turn: undefined, phase: { kind: 'idle', since: at } }
}
