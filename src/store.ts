// What quackpit keeps across sessions, in the host's key-value store:
//   layout        the band's override (prefs.ts)
//   pane          the pane's open tab and open detail (panes.ts), so it opens as it was left
//   hud           whether claude-hud's config was looked at (once)
//   notify        today's OS-notification count (3 a day at most)
//   welcomed      when the first-run toast was shown (once, ever)
//   np:<day>:<sid> one session's new tokens and active minutes that day
//   nd:<day>       finished days rolled up: what "your usual pace" reads
//   s:<sid>        one session's record (record.ts), written at most once a
//                  turn and read back when a process restarts; the 20 written
//                  last are kept, none older than 7 days
//   ai:<day>:<sid> one session-day's AI ETA calls and the tokens their own
//                  usage reported (ai.ts); kept 14 days
//   aa:<sid>       one session's AI ETA answers, scored at their turns' ends:
//                  numbers only, the newest 200 kept across sessions
//   runs           how long each command took the last few times it ran, by
//                  project (jobs.ts): a background job's expected length; 60
//                  commands kept, 5 runs each, the commands masked and cut
// Each session writes only its own `np:`, `ai:` and `aa:` keys, so parallel
// sessions never race on one; finished days roll up into `nd:` at the next
// session start, and days older than 30 are dropped. A few KiB in all, far
// under 2 MiB (the AI ETA's keys add at most about 20 KiB).
// The first builds kept the same records under `p:` and `d:`, counting cache reads:
// another unit, so the roll-up drops them rather than mix the two.
// Pure apart from the KV it is handed.

import { addCall, asRecords, asTally, KEEP_RECORDS, scoresOf, sumTallies, type AiOutcome, type AiRecord, type AiScores, type AiTally, type AiUsage } from './ai'
import type { DayTotals } from './derive'
import { asDurations, priorsOf, turnsOfHistory, type Durations } from './eta'
import type { Cockpit } from './model'
import { fromRecord, staleRecords, type SessionRecord } from './record'
import { returnNotifySlot, takeNotifySlot, type NotifyRecord } from './duck'
import { addRun, asLengths, type CommandLengths } from './jobs'
import { asView, type PaneView } from './views'
import { asLayout, type LayoutRecord } from './prefs'

export type KV = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

export const KEEP_DAYS = 30
const MAX_PARTS_READ = 400

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0

function asTotals(day: string, x: unknown): DayTotals | undefined {
  if (typeof x !== 'object' || x === null) return undefined
  const r = x as Record<string, unknown>
  if (!isNum(r.tokens) || !isNum(r.activeMin)) return undefined
  return { day, tokens: r.tokens, activeMin: r.activeMin }
}

export async function loadLayout(kv: KV): Promise<LayoutRecord | undefined> {
  return asLayout(await kv.get('layout'))
}

export async function saveLayout(kv: KV, record: LayoutRecord | undefined): Promise<void> {
  if (record) await kv.set('layout', record)
  else await kv.delete('layout')
}

/** The pane's view as it was left: the view in front and the detail drilled into. */
export async function loadView(kv: KV): Promise<PaneView | undefined> {
  return asView(await kv.get('pane'))
}

export async function saveView(kv: KV, view: PaneView): Promise<void> {
  await kv.set('pane', view)
}

export type HudRecord = { checkedAt: number; tiles?: string[] }

export async function loadHud(kv: KV): Promise<HudRecord | undefined> {
  const x = await kv.get('hud')
  if (typeof x !== 'object' || x === null || !isNum((x as Record<string, unknown>).checkedAt)) return undefined
  return x as HudRecord
}

export async function saveHud(kv: KV, record: HudRecord): Promise<void> {
  await kv.set('hud', record)
}

function asNotify(x: unknown): NotifyRecord | undefined {
  if (typeof x !== 'object' || x === null) return undefined
  const r = x as Record<string, unknown>
  return typeof r.day === 'string' && isNum(r.count) ? { day: r.day, count: r.count } : undefined
}

/** Takes one of today's 3 notification slots, shared by every session. */
export async function takeNotify(kv: KV, day: string): Promise<boolean> {
  const { record, isTaken } = takeNotifySlot(asNotify(await kv.get('notify')), day)
  if (isTaken) await kv.set('notify', record)
  return isTaken
}

export async function giveBackNotify(kv: KV, day: string): Promise<void> {
  await kv.set('notify', returnNotifySlot(asNotify(await kv.get('notify')), day))
}

/** Session-day parts and rolled-up days, in new tokens. */
const PART = 'np:'
const DAY = 'nd:'
/** The first builds' parts and days, in all four token counts. */
const OLD_UNIT = ['p:', 'd:'] as const

/** Adds one turn to this session's totals for the day it ended in. */
export async function addToDay(kv: KV, day: string, sid: string, tokens: number, activeMin: number): Promise<void> {
  const key = `${PART}${day}:${sid || 'session'}`
  const before = asTotals(day, await kv.get(key)) ?? { day, tokens: 0, activeMin: 0 }
  await kv.set(key, { tokens: before.tokens + Math.max(0, tokens), activeMin: Math.round((before.activeMin + Math.max(0, activeMin)) * 100) / 100 })
}

function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`)
  const tb = Date.parse(`${b}T00:00:00Z`)
  return Number.isFinite(ta) && Number.isFinite(tb) ? Math.round((tb - ta) / 86_400_000) : 0
}

/**
 * Rolls finished days' session parts into one `nd:<day>` record each and
 * drops days older than 30, and the first builds' records in the old unit. Safe to run
 * from two sessions at once: a part is deleted only after the day's record
 * holding it was written, and a day's record lists the parts it holds so
 * none is added twice.
 */
export async function rollUp(kv: KV, today: string): Promise<void> {
  const keys = await kv.keys()
  for (const key of keys) if (OLD_UNIT.some(prefix => key.startsWith(prefix))) await kv.delete(key)
  const parts = keys.filter(k => k.startsWith(PART)).slice(0, MAX_PARTS_READ)
  const byDay = new Map<string, string[]>()
  for (const key of parts) {
    const day = key.split(':')[1] ?? ''
    if (day >= today || day === '') continue
    byDay.set(day, [...(byDay.get(day) ?? []), key])
  }
  for (const [day, dayParts] of byDay) {
    const existing = (await kv.get(`${DAY}${day}`)) as { tokens?: number; activeMin?: number; parts?: string[] } | undefined
    const held = new Set(Array.isArray(existing?.parts) ? existing.parts : [])
    let tokens = isNum(existing?.tokens) ? existing.tokens : 0
    let activeMin = isNum(existing?.activeMin) ? existing.activeMin : 0
    for (const key of dayParts) {
      if (held.has(key)) continue
      const part = asTotals(day, await kv.get(key))
      if (part) {
        tokens += part.tokens
        activeMin += part.activeMin
      }
      held.add(key)
    }
    await kv.set(`${DAY}${day}`, { tokens, activeMin: Math.round(activeMin * 100) / 100, parts: [...held].slice(-50) })
    for (const key of dayParts) await kv.delete(key)
  }
  for (const key of keys) {
    if (!key.startsWith(DAY) && !key.startsWith(PART)) continue
    const day = key.split(':')[1] ?? ''
    if (day !== '' && daysBetween(day, today) > KEEP_DAYS) await kv.delete(key)
  }
}

/** Finished days, oldest first: what the pace dial calls your usual. */
export async function loadDays(kv: KV, today: string): Promise<DayTotals[]> {
  const keys = (await kv.keys()).filter(k => k.startsWith(DAY))
  const days: DayTotals[] = []
  for (const key of keys) {
    const day = key.slice(DAY.length)
    if (day >= today) continue
    const totals = asTotals(day, await kv.get(key))
    if (totals) days.push(totals)
  }
  return days.sort((a, b) => a.day.localeCompare(b.day)).slice(-KEEP_DAYS)
}

const SESSION = 's:'

/** Writes this session's record over its last one. */
export async function saveSession(kv: KV, record: SessionRecord): Promise<void> {
  if (record.cockpit.sid === '') return
  await kv.set(`${SESSION}${record.cockpit.sid}`, record)
}

/** The cockpit a session's record holds, if quackpit kept one for it in this shape. */
export async function loadSession(kv: KV, sid: string): Promise<Cockpit | undefined> {
  return sid === '' ? undefined : fromRecord(await kv.get(`${SESSION}${sid}`), sid)
}

/**
 * Drops all but the 20 records written last, any older than 7 days, and any
 * not in a record's shape; and reads what the other sessions measured (the
 * lengths of their finished tasks, subagents and turns), newest first, for
 * the estimate of what is left until this session has its own.
 */
export async function surveySessions(kv: KV, sid: string, now: number): Promise<Durations> {
  const saved: { key: string; savedAt: number; durations?: Durations }[] = []
  for (const key of (await kv.keys()).filter(k => k.startsWith(SESSION))) {
    const record = (await kv.get(key)) as { savedAt?: unknown; cockpit?: { durations?: unknown; history?: unknown } } | undefined
    const savedAt = record?.savedAt
    if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) {
      await kv.delete(key)
      continue
    }
    // The oldest records kept no lengths at all: their history's turns are still turns.
    const history = record?.cockpit?.history
    const durations = asDurations(record?.cockpit?.durations, history) ?? (Array.isArray(history) ? { tasks: [], agents: {}, turns: turnsOfHistory(history) } : undefined)
    saved.push({ key, savedAt, ...(durations ? { durations } : {}) })
  }
  const stale = new Set(staleRecords(saved, now))
  for (const key of stale) await kv.delete(key)
  const others = saved.filter(s => !stale.has(s.key) && s.key !== `${SESSION}${sid}`).sort((a, b) => b.savedAt - a.savedAt)
  return priorsOf(others.flatMap(s => (s.durations ? [s.durations] : [])))
}

/** Drops the records past keeping (see `surveySessions`). */
export async function pruneSessions(kv: KV, now: number): Promise<void> {
  await surveySessions(kv, '', now)
}

// ------------------------------------------------------------------ the AI ETA

const AI_DAY = 'ai:'
const AI_RECORDS = 'aa:'
export const KEEP_AI_DAYS = 14
/** The days the pane's tally sums: today and the six before it. */
const WEEK_DAYS = 7

/** Adds one AI ETA call to this session's tally for the day it was made. */
export async function addAiCall(kv: KV, day: string, sid: string, outcome: AiOutcome, usage: AiUsage | undefined): Promise<void> {
  const key = `${AI_DAY}${day}:${sid || 'session'}`
  await kv.set(key, addCall(asTally(await kv.get(key)), outcome, usage))
}

export type AiDay = { day: string; tally: AiTally }

/** The AI ETA's calls of the last 7 days, every session's summed, one tally a day, oldest first. */
export async function loadAiDays(kv: KV, today: string): Promise<AiDay[]> {
  const byDay = new Map<string, AiTally[]>()
  for (const key of (await kv.keys()).filter(k => k.startsWith(AI_DAY))) {
    const day = key.split(':')[1] ?? ''
    if (day === '' || day > today || daysBetween(day, today) >= WEEK_DAYS) continue
    const tally = asTally(await kv.get(key))
    if (tally) byDay.set(day, [...(byDay.get(day) ?? []), tally])
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, tallies]) => ({ day, tally: sumTallies(tallies) }))
}

/** Keeps one scored answer in this session's records. */
export async function addAiRecord(kv: KV, sid: string, record: AiRecord): Promise<void> {
  const key = `${AI_RECORDS}${sid || 'session'}`
  await kv.set(key, [...asRecords(await kv.get(key)), record].slice(-KEEP_RECORDS))
}

/** Every session's scored answers, newest first, at most 200. */
export async function loadAiRecords(kv: KV): Promise<AiRecord[]> {
  const all: AiRecord[] = []
  for (const key of (await kv.keys()).filter(k => k.startsWith(AI_RECORDS))) all.push(...asRecords(await kv.get(key)))
  return all.sort((a, b) => b[0] - a[0]).slice(0, KEEP_RECORDS)
}

export type AiSummary = { days: AiDay[]; scores: AiScores }

/** What the pane shows of the AI ETA: the last 7 days' calls and tokens, and how its answers scored, first answers and revisions apart. */
export async function loadAiSummary(kv: KV, today: string): Promise<AiSummary> {
  return { days: await loadAiDays(kv, today), scores: scoresOf(await loadAiRecords(kv)) }
}

/** Drops tallies older than 14 days, and every record past the newest 200 across sessions. */
export async function pruneAi(kv: KV, today: string): Promise<void> {
  const keys = await kv.keys()
  for (const key of keys.filter(k => k.startsWith(AI_DAY))) {
    const day = key.split(':')[1] ?? ''
    if (day === '' || daysBetween(day, today) > KEEP_AI_DAYS) await kv.delete(key)
  }
  const kept = await loadAiRecords(kv)
  const oldest = kept.at(-1)?.[0]
  if (kept.length < KEEP_RECORDS || oldest === undefined) return
  for (const key of keys.filter(k => k.startsWith(AI_RECORDS))) {
    const records = asRecords(await kv.get(key))
    const newer = records.filter(r => r[0] >= oldest)
    if (newer.length === 0) await kv.delete(key)
    else if (newer.length < records.length) await kv.set(key, newer)
  }
}


// ------------------------------------------------------------------ how long commands take

const RUNS = 'runs'

/** The last runs of each command, by project: what a background job is expected to take. */
export async function loadLengths(kv: KV): Promise<CommandLengths | undefined> {
  return asLengths(await kv.get(RUNS))
}

/** Adds one run of a command in a project to the record, and answers it as written. */
export async function addCommandRun(kv: KV, project: string, command: string, ms: number, at: number): Promise<CommandLengths> {
  const next = addRun(await loadLengths(kv), project, command, ms, at)
  await kv.set(RUNS, next)
  return next
}
