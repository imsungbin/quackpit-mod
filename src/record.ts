// The session's record across restarts: a trimmed copy of the cockpit, kept
// in the store under the session's id and written at most once a turn, so a
// process that restarts (a resume, an update) gets its turns, timings, checks
// and samples back with their real times instead of rebuilding a thinner
// picture from the transcript. Pure: the adapter reads and writes the store.

import { asCockpit, type Cockpit } from './model'

/** The record's own shape; the cockpit inside carries MODEL_VERSION, and either changing drops it. */
export const RECORD_VERSION = 1

/** Sessions kept: the 20 written last, none older than 7 days. */
export const KEEP_SESSIONS = 20
export const KEEP_SESSION_DAYS = 7

/** What a record keeps of each list, newest last, and of each text: enough for the pane, the handover and the forecasts. */
const KEEP = { checks: 8, commands: 8, files: 15, edits: 12, agents: 10, jobs: 8, tasks: 25, ack: 20, seen: 20, recent: 60, fiveSamples: 45, medians: 20, failureChars: 300, text: 80, prompt: 40, words: 100, lastWords: 600, question: 200 } as const

/** A text cut to `max` characters, its head kept. */
const head = (text: string, max: number = KEEP.text) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
/** A path cut to `max` characters, its tail kept: the file's name says most. */
const tail = (text: string, max: number = KEEP.text) => (text.length > max ? `…${text.slice(-(max - 1))}` : text)

export type SessionRecord = { v: typeof RECORD_VERSION; savedAt: number; cockpit: Cockpit }

const lastN = <T>(xs: readonly T[], n: number): T[] => xs.slice(Math.max(0, xs.length - n))

/**
 * The cockpit as a record keeps it: the lists cut to what is shown, the
 * failing outputs to their tails, and nothing that is only true now (the turn
 * running, the latest reading and response, the phase, the waits on the
 * person, the crossing under way, what fills the context).
 */
export function toRecord(c: Cockpit, savedAt: number): SessionRecord {
  // What fills the context and other loops' tasks are true of this process's window alone.
  const { turn: _turn, reading: _reading, lastStep: _step, crossing: _crossing, ctx: _ctx, foreign: _foreign, ...kept } = c
  const cockpit: Cockpit = {
    ...kept,
    phase: { kind: 'idle', since: c.lastAt },
    history: c.history.map(h => (h.prompt ? { ...h, prompt: head(h.prompt, KEEP.prompt) } : h)),
    prompts: c.prompts.map(text => head(text, KEEP.words)),
    ...(c.lastPrompt !== undefined ? { lastPrompt: head(c.lastPrompt, KEEP.lastWords) } : {}),
    ...(c.question !== undefined ? { question: head(c.question, KEEP.question) } : {}),
    passing: c.passing.map(p => ({ ...p, command: head(p.command) })),
    turnTokens: lastN(c.turnTokens, KEEP.medians),
    turnUsd: lastN(c.turnUsd, KEEP.medians),
    checks: lastN(c.checks, KEEP.checks).map(ch => ({ ...ch, command: head(ch.command) })),
    commands: lastN(c.commands, KEEP.commands).map(run => ({ ...run, command: head(run.command) })),
    files: lastN(c.files, KEEP.files).map(f => ({ ...f, path: tail(f.path) })),
    edits: lastN(c.edits, KEEP.edits).map(edit => ({ ...edit, path: tail(edit.path) })),
    agents: lastN(c.agents, KEEP.agents).map(a => ({ ...a, description: head(a.description, 60) })),
    jobs: lastN(c.jobs, KEEP.jobs).map(j => ({ ...j, ...(j.command ? { command: head(j.command) } : {}) })),
    waits: [],
    failures: c.failures.map(f => ({ ...f, command: head(f.command), output: tail(f.output, KEEP.failureChars) })),
    ack: lastN(c.ack, KEEP.ack),
    seen: lastN(c.seen, KEEP.seen),
    recent: lastN(c.recent, KEEP.recent),
    fiveSamples: lastN(c.fiveSamples, KEEP.fiveSamples),
    // The spinner's words are for the turn running; a record keeps the titles.
    ...(c.tasks ? { tasks: { ...c.tasks, items: c.tasks.items.slice(0, KEEP.tasks).map(({ active: _active, ...t }) => ({ ...t, title: head(t.title) })) } } : {}),
  }
  return { v: RECORD_VERSION, savedAt, cockpit }
}

/** A stored record read back: the cockpit it holds for `sid`, or undefined when it is another shape or session. */
export function fromRecord(x: unknown, sid: string): Cockpit | undefined {
  if (typeof x !== 'object' || x === null) return undefined
  const r = x as Partial<SessionRecord>
  if (r.v !== RECORD_VERSION || typeof r.savedAt !== 'number') return undefined
  const c = asCockpit(r.cockpit)
  if (!c || c.sid !== sid) return undefined
  // A process that restarted took its background shells with it: they ended unseen.
  const savedAt = r.savedAt
  return { ...c, jobs: c.jobs.map(j => (j.status === 'running' || j.status === 'waiting' ? { ...j, status: 'done' as const, endedAt: savedAt, isGone: true as const } : j)) }
}

/** Which records to drop: all but the 20 written last, and any older than 7 days. */
export function staleRecords(saved: readonly { key: string; savedAt: number }[], now: number): string[] {
  const oldest = now - KEEP_SESSION_DAYS * 24 * 60 * 60_000
  const newestFirst = [...saved].sort((a, b) => b.savedAt - a.savedAt)
  return newestFirst.filter((s, i) => i >= KEEP_SESSIONS || s.savedAt < oldest).map(s => s.key)
}
