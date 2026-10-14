// The AI ETA, off by default and on only while its setting is. Once a main
// turn has worked a minute with nothing measured to say how long it has left,
// quackpit asks Claude Haiku, in the background, how many minutes the turn has
// left: from what the turn began with (secrets masked, cut), what Claude has
// said so far, the task list if any, and your recorded turn lengths to
// calibrate by. It asks again (4 calls a turn at most, the next no sooner than
// 2, then 4, then 8 minutes after the last) when the turn runs past its
// answer, when a wait on the person ended, or when the work changed shape,
// and tells it its earlier answers and what happened since. It reads one
// number from each reply, strictly; anything else draws nothing. Every call's
// own usage is tallied by day (tokens, never dollars: there is no price
// reading for these calls), answered and failed calls counted, and each
// answer is scored at the turn's real end against the history-only estimate
// made at the same moment. Only numbers are kept, never a prompt or a reply.
// The call is a completion of its own: nothing reaches the conversation's
// context. Pure: the adapter makes the call and keeps the store.

import { clockText, formatSpan } from './format'
import type { Calibration } from './lengths'
import type { AiAsk, AiWhy, TurnSourceKind } from './model'

export const AI_MODEL = 'haiku'
export const AI_EFFORT = 'low'
/** A turn that has worked this long with no measured estimate is asked about. */
export const AI_AFTER_MS = 60_000
/** Calls a turn at most: its first answer and three revisions. */
export const AI_MAX_CALLS = 4
/** The least time after a call before the next: 2 minutes, then 4, then 8. */
export const AI_GAPS_MS = [2 * 60_000, 4 * 60_000, 8 * 60_000] as const
/** Past its answer by this much at least (or half the answer, when that is more), the turn is asked about again. */
export const AI_OVERRUN_MS = 30_000
export const AI_TIMEOUT_MS = 10_000
/** One number fits in a few tokens; a reply that runs on is cut and read as none. */
export const AI_MAX_TOKENS = 16
/** Past 12 hours an estimate is no help (the measured one's limit too). */
export const AI_MAX_MINUTES = 720

/** One task as the request lists it. */
export type AiTask = { title: string; status: 'pending' | 'in_progress' | 'completed' }

export type AiInput = {
  /** How long the turn has worked (its waits on the person left out), and the tool calls it made. */
  elapsedMs: number
  tools: number
  /** The text the turn began with, masked and cut. */
  text?: string
  /** What started the turn when no person typed it, in English words (the request is in English). */
  startedBy?: string
  /** Claude's own words so far this turn, masked and cut. */
  words?: string
  tasks?: readonly AiTask[]
  calibration?: Calibration
  /** A re-ask: the answers given before, oldest first, and what happened since the last. */
  previous?: readonly AiPrevious[]
  since?: AiSince
}

/** An earlier answer as a re-ask recalls it: when it was given, how long the turn had worked then, and what it said. */
export type AiPrevious = { at: number; elapsedMs: number; leftMs?: number }

/** What happened since the last answer: the working time since, what happened, and Claude's latest words. */
export type AiSince = { workedMs: number; heldMs: number; notes: readonly string[]; lastWords?: string }

export type AiRequest = { model: string; system: string; prompt: string; maxTokens: number; effort: 'low'; timeoutMs: number }

const SYSTEM =
  'You estimate how much longer a turn of Claude Code, an AI coding assistant, will run. A turn starts when a request arrives and ends when Claude has finished working on it and replied. Answer with a single number: the minutes left. Write only the number.'

/** What started a turn no person typed, in the request's words (it is written in English). */
const STARTED_BY: Record<TurnSourceKind, string> = {
  report: "a subagent's report",
  task: "a background task's notice",
  teammate: "a teammate's message",
  peer: "another session's message",
  event: 'a background event',
  command: 'a slash command',
  compaction: 'the summary of a compacted conversation',
  plugin: "a plugin's message",
  system: 'a system message',
}

export function startedBy(kind: TurnSourceKind): string {
  return STARTED_BY[kind]
}

/** Quoted text, set off so the model reads it as material, not as instructions to it. */
const quoted = (text: string) => `<<<\n${text}\n>>>`

/** The tasks shown at most: the open ones are what is left. */
const MAX_TASKS = 12
const MARK: Record<AiTask['status'], string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' }
/** What happened since the last answer, the latest few. */
const MAX_NOTES = 12

const minutes = (ms: number) => {
  const m = Math.round(ms / 6000) / 10
  return `${Number.isInteger(m) ? m : m.toFixed(1)} minute${m === 1 ? '' : 's'}`
}

/** One completion the AI ETA makes for a turn: its first question, or a re-ask with what came before. */
export function aiRequest(input: AiInput): AiRequest {
  const parts: string[] = [`This turn has worked ${formatSpan(input.elapsedMs)} so far (time spent waiting on the person left out) and made ${input.tools} tool call${input.tools === 1 ? '' : 's'}.`]
  if (input.text) {
    const what = input.startedBy ? `The message that started the turn (${input.startedBy}, not typed by the person)` : "The person's request"
    parts.push(`${what}, secrets masked, long text cut:\n${quoted(input.text)}`)
  }
  parts.push(input.words ? `What Claude has said so far this turn, cut:\n${quoted(input.words)}` : 'Claude has said nothing yet this turn.')
  const tasks = input.tasks ?? []
  if (tasks.length > 0) {
    const done = tasks.filter(task => task.status === 'completed').length
    // The open tasks first when the list is long: they are what is left.
    const shown = tasks.length > MAX_TASKS ? [...tasks.filter(task => task.status !== 'completed'), ...tasks.filter(task => task.status === 'completed')].slice(0, MAX_TASKS) : tasks
    const lines = shown.map(task => `${MARK[task.status]} ${task.title}`)
    if (shown.length < tasks.length) lines.push(`(${tasks.length - shown.length} more)`)
    parts.push(`Claude's task list, ${done} of ${tasks.length} done:\n${lines.join('\n')}`)
  }
  const cal = input.calibration
  if (cal) {
    const all = `This person's recorded turns (${cal.n}): half ended within ${formatSpan(cal.p50)}, 9 in 10 within ${formatSpan(cal.p90)}, 19 in 20 within ${formatSpan(cal.p95)}.`
    const longer = cal.longer ? ` Of the ${cal.longer.n} that ran past ${formatSpan(input.elapsedMs)}, half ended within ${formatSpan(cal.longer.p50)} in all and 9 in 10 within ${formatSpan(cal.longer.p90)}.` : ''
    parts.push(all + longer)
  }
  const previous = input.previous ?? []
  if (previous.length > 0) {
    const said = previous.map(p => `at ${clockText(p.at)}, ${formatSpan(p.elapsedMs)} into the turn, ${p.leftMs !== undefined ? `you said ${minutes(p.leftMs)} were left` : 'you gave no number'}`)
    parts.push(`You were asked before: ${said.join('; ')}.`)
    const since = input.since
    if (since) {
      const held = since.heldMs >= 1000 ? `, besides ${formatSpan(since.heldMs)} it waited on the person` : ''
      const notes = since.notes.slice(-MAX_NOTES)
      const happened = notes.length > 0 ? `\n${notes.map(n => `- ${n}`).join('\n')}` : ' nothing new.'
      parts.push(`Since your last answer the turn has worked ${formatSpan(since.workedMs)}${held}. What happened since:${happened}`)
      if (since.lastWords) parts.push(`Claude's latest words, cut:\n${quoted(since.lastWords)}`)
    }
    parts.push('Keep your previous estimate unless what happened since changes it.')
  }
  parts.push('How many more minutes will this turn run? Answer with the number only.')
  return { model: AI_MODEL, system: SYSTEM, prompt: parts.join('\n\n'), maxTokens: AI_MAX_TOKENS, effort: AI_EFFORT, timeoutMs: AI_TIMEOUT_MS }
}

// ------------------------------------------------------------------ when to ask

/** What the planner decides: ask now (and why), look again in `inMs`, or nothing to do. */
export type AiPlan = { kind: 'none' } | { kind: 'ask'; why: AiWhy } | { kind: 'later'; inMs: number }

export type AiPlanInput = {
  now: number
  /** How long the turn has worked so far: its waits on the person left out. */
  workedMs: number
  /** A wait on the person holds the turn now: no call goes out during one. */
  isWaiting: boolean
  /** A call is in flight: never two at once. */
  isAsking: boolean
  /** This turn's calls so far. */
  asks: readonly AiAsk[]
  /** Something measured says how long the turn's own work has left: the first call defers to it. */
  isCovered: boolean
  /** A reason to ask again that came since the last call (a wait ended, the work changed shape). */
  due?: AiWhy
  /** Working time since the latest answer was asked for. */
  workedSinceLast?: number
}

/** The least time after the `n`th call (1-based) before the next one goes out. */
export function gapAfter(n: number): number {
  return AI_GAPS_MS[Math.min(AI_GAPS_MS.length, Math.max(1, n)) - 1] ?? 8 * 60_000
}

/** How far past its answer the turn may run before it is asked again: 30 seconds, or half the answer. */
export function overrunAfter(leftMs: number): number {
  return leftMs + Math.max(AI_OVERRUN_MS, leftMs / 2)
}

/**
 * When the AI ETA is asked: first, once the turn has worked a minute with
 * nothing measured covering it; then again when the turn runs past the last
 * answer by 30 seconds or half that answer (whichever is more), or for a
 * reason that came since (a wait on the person ended, the work changed
 * shape, the measured estimate it deferred to went away). Four calls a turn
 * at most, the next no sooner than 2, 4 and then 8 minutes after the one
 * before, none while one is in flight or while the turn waits on the person.
 */
export function planAsk(p: AiPlanInput): AiPlan {
  if (p.isWaiting || p.isAsking || p.asks.length >= AI_MAX_CALLS) return { kind: 'none' }
  if (p.asks.length === 0) {
    if (p.isCovered) return { kind: 'none' }
    if (p.workedMs < AI_AFTER_MS) return { kind: 'later', inMs: AI_AFTER_MS - p.workedMs }
    return { kind: 'ask', why: p.due === 'deferred' ? 'deferred' : 'first' }
  }
  const last = p.asks.at(-1) as AiAsk
  const waitGap = Math.max(0, last.askedAt + gapAfter(p.asks.length) - p.now)
  const answered = p.asks.findLast(a => a.state === 'answered' && a.leftMs !== undefined)
  const since = p.workedSinceLast ?? 0
  const overrunIn = answered?.leftMs !== undefined ? overrunAfter(answered.leftMs) - since : undefined
  const why: AiWhy | undefined = overrunIn !== undefined && overrunIn < 0 ? 'overrun' : p.due
  if (why) return waitGap > 0 ? { kind: 'later', inMs: waitGap } : { kind: 'ask', why }
  // Nothing to ask about yet: look again when the turn would run past the answer.
  return overrunIn !== undefined ? { kind: 'later', inMs: Math.max(waitGap, overrunIn + 1000) } : { kind: 'none' }
}

/**
 * The minutes a reply says, read strictly: a number alone (`8`, `12.5`), 0 to
 * 720. Anything else (words, a range, a unit, a reply cut short) is none, and
 * draws nothing.
 */
export function parseMinutes(reply: string): number | undefined {
  const m = /^\s*(\d{1,4}(?:\.\d{1,2})?)\s*$/.exec(reply)
  if (!m) return undefined
  const minutes = Number(m[1])
  return Number.isFinite(minutes) && minutes >= 0 && minutes <= AI_MAX_MINUTES ? minutes : undefined
}

// ------------------------------------------------------------------ the tally

/**
 * How a call ended: `answered` with a number quackpit read; `unread`, a reply
 * that was no number; `failed`, no reply (an API error, an empty reply, the
 * 10 seconds out, a request refused); `cancelled`, cut by quackpit because
 * the turn ended first.
 */
export type AiOutcome = 'answered' | 'unread' | 'failed' | 'cancelled'

/** A day's calls (of one session, or summed) and the tokens their own usage reported. */
export type AiTally = {
  calls: number
  answered: number
  unread: number
  failed: number
  cancelled: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** The four counts a call's usage reports, as the API spells them. */
export type AiUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

export function emptyTally(): AiTally {
  return { calls: 0, answered: 0, unread: 0, failed: 0, cancelled: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.round(x) : 0)

/** A tally with one more call, its tokens as its own usage reported them (every outcome has one). */
export function addCall(tally: AiTally | undefined, outcome: AiOutcome, usage: AiUsage | undefined): AiTally {
  const t = tally ?? emptyTally()
  return {
    ...t,
    calls: t.calls + 1,
    [outcome]: t[outcome] + 1,
    input: t.input + count(usage?.input_tokens),
    output: t.output + count(usage?.output_tokens),
    cacheRead: t.cacheRead + count(usage?.cache_read_input_tokens),
    cacheWrite: t.cacheWrite + count(usage?.cache_creation_input_tokens),
  }
}

/** A stored tally read back defensively: missing counts are zero, anything else is none. */
export function asTally(x: unknown): AiTally | undefined {
  if (typeof x !== 'object' || x === null) return undefined
  const r = x as Record<string, unknown>
  const t = emptyTally()
  for (const key of Object.keys(t) as (keyof AiTally)[]) t[key] = count(r[key])
  return t.calls > 0 ? t : undefined
}

export function sumTallies(tallies: readonly AiTally[]): AiTally {
  const sum = emptyTally()
  for (const t of tallies) for (const key of Object.keys(sum) as (keyof AiTally)[]) sum[key] += t[key]
  return sum
}

/** Every token a tally's calls reported: input, output, cache reads and cache writes. */
export function tallyTokens(t: AiTally): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

// ------------------------------------------------------------------ the score

/**
 * One answer, scored when its turn ended: when it was asked, how long the
 * turn had worked, what the AI said was left, what history alone said at the
 * same moment (-1 when it had nothing to say), what was really left (the
 * turn's working time from then to its end), and which answer of the turn it
 * was (1 the first; 2 to 4 its revisions; an older record has no sixth
 * number and was a first answer). Numbers only.
 */
export type AiRecord = [askedAt: number, elapsedMs: number, aiMs: number, historyMs: number, actualMs: number, n?: number]

/** Answers scored before "within 2×" is shown: under 20 a share means little. */
export const MIN_SCORED = 20
/** Records kept across sessions, the newest. */
export const KEEP_RECORDS = 200

/** Within 2× of the truth: neither more than twice the other. */
export function isWithin2x(predictedMs: number, actualMs: number): boolean {
  return predictedMs <= 2 * actualMs && actualMs <= 2 * predictedMs
}

export function asRecords(x: unknown): AiRecord[] {
  if (!Array.isArray(x)) return []
  return x.filter((r): r is AiRecord => Array.isArray(r) && (r.length === 5 || r.length === 6) && r.every(n => typeof n === 'number' && Number.isFinite(n)) && r[2] >= 0 && r[4] >= 0)
}

/** Whether a record is a revision (a later answer in its turn), not a first answer. */
export const isRevision = (r: AiRecord) => (r[5] ?? 1) > 1

/**
 * How often each landed within 2× of what was really left, over the same
 * answers: those the AI gave. An answer history could not match counts
 * against history, as an estimate it did not give.
 */
export type AiScore = { n: number; ai: number; history: number }

export function scoreOf(records: readonly AiRecord[]): AiScore {
  let ai = 0
  let history = 0
  for (const [, , aiMs, historyMs, actualMs] of records) {
    if (isWithin2x(aiMs, actualMs)) ai++
    if (historyMs >= 0 && isWithin2x(historyMs, actualMs)) history++
  }
  return { n: records.length, ai, history }
}

/** First answers and revisions, scored apart: a revision knows more of the turn than a first answer did. */
export type AiScores = { first: AiScore; revised: AiScore }

export function scoresOf(records: readonly AiRecord[]): AiScores {
  return { first: scoreOf(records.filter(r => !isRevision(r))), revised: scoreOf(records.filter(isRevision)) }
}
