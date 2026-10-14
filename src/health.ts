// Health: is the way this work is going healthy? A judgement, never a
// measurement: 100 less what each of seven parts takes off. Each part turns a
// value quackpit measured into a share by a stated rule (whole at one value,
// nothing at another, a straight line between) and is weighed; a part with
// nothing to judge yet counts whole and says so. Every part is shown with its
// value, its rule, its weight and what it took off, one press away from the
// score. quackpit computes it alone, from this session's own events and
// readings; it calls no model and reads nothing of any other plugin. Pure.

import { fuelGauge, type Level, type PaceReading } from './derive'
import { formatPercent } from './format'
import { t, type Locale } from './i18n'
import { MINUTE } from './metrics'
import { contextNow, contextShare, PAUSE_MS, unverified, type Cockpit } from './model'

export type HealthPartId = 'checks' | 'context' | 'window' | 'runaway' | 'pace' | 'breaks' | 'night'

/** The parts in the order the detail lists them, and each one's weight: they add up to 100. */
export const HEALTH_WEIGHTS: Readonly<Record<HealthPartId, number>> = { checks: 25, context: 20, window: 15, runaway: 10, pace: 10, breaks: 10, night: 10 }
export const HEALTH_PARTS = Object.keys(HEALTH_WEIGHTS) as HealthPartId[]

/** What each part measured, as numbers; absent where it had nothing to judge. */
export type PartReading =
  | { id: 'checks'; edits: number; hasPassed: boolean }
  | { id: 'context'; pct?: number; ofCompact: boolean; compactions: number }
  | { id: 'window'; atReset?: number; pct: number; isUsedUp: boolean; emptiesAt?: number }
  | { id: 'runaway'; count: number; last?: number }
  | { id: 'pace'; ratio: number; isSession?: true }
  | { id: 'breaks'; minutes: number; isPaused: boolean; since: number }
  | { id: 'night'; minutes: number }

export type HealthPart = {
  id: HealthPartId
  weight: number
  /** 0 to 1: how much of its weight the part keeps; 1 with nothing to judge. */
  share: number
  /** Whole points it took off the score; the parts' add up to 100 less the score. */
  off: number
  /** What it measured; absent with nothing to judge yet. */
  reading?: PartReading
  /** The pace part with a usual pace to judge against, while the session is watched under 10 minutes. */
  isWarming?: true
}

export type HealthWord = 'smooth' | 'light' | 'choppy' | 'turbulent'

export type Health = {
  /** 0 to 100, whole: 100 less what the parts took off. */
  score: number
  word: HealthWord
  /** A colour only past a threshold: amber under 70, red under 50. */
  level: Level
  parts: HealthPart[]
  /** The part that took off the most, if any took off anything. */
  weakest?: HealthPart
  /** Whether any part had anything to judge: until one has, the pane's grid leaves health out. */
  isMeasuring: boolean
}

/** A share from a straight line: whole at `full` and better, nothing at `none` and worse. */
export function lineShare(value: number, full: number, none: number): number {
  if (!Number.isFinite(value)) return 1
  const share = (none - value) / (none - full)
  return Math.max(0, Math.min(1, share))
}

/** Edits no passing check has seen: whole up to 2, nothing from 15. */
const EDITS = [2, 15] as const
/** The context's way to auto-compact (or of the window), in percent: whole to 50, nothing at 100. */
const CONTEXT = [50, 100] as const
/** Each compaction this session caps the context's share a quarter lower. */
const PER_COMPACTION = 0.25
/** Where the five-hour window's trend ends at its reset, in percent: whole to 90, nothing at 120 (it runs out well before). */
const WINDOW = [90, 120] as const
/** Runaway turns among the last 10: each takes half. */
const RUNAWAY_TURNS = 10
/** Pace against your usual: whole to 1.2×, nothing at 2×. */
const PACE = [1.2, 2] as const
/** Minutes of prompting without a 30-minute pause: whole to 2 hours, nothing at 5. */
const BREAKS = [120, 300] as const
/** Minutes of the stretch between midnight and 6: whole with none, nothing at 2 hours. */
const NIGHT = [0, 120] as const
/** The night, in local hours: from midnight to 6. */
export const NIGHT_HOURS = [0, 6] as const

/**
 * How much of [from, to] fell in the night (midnight to 6, local time), in
 * milliseconds.
 */
export function nightMs(from: number, to: number): number {
  if (!(to > from)) return 0
  let total = 0
  const first = new Date(from)
  let day = new Date(first.getFullYear(), first.getMonth(), first.getDate())
  // A stretch of more than a fortnight is no stretch: count its last days only.
  for (let i = 0; i < 15 && day.getTime() < to; i++) {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), NIGHT_HOURS[0]).getTime()
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), NIGHT_HOURS[1]).getTime()
    total += Math.max(0, Math.min(to, end) - Math.max(from, start))
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  }
  return total
}

/** The person's stretch as it stands: running, or ended by a pause of 30 minutes without a prompt. */
export function stretchNow(c: Cockpit, now: number): { from: number; last: number; isPaused: boolean } | undefined {
  const s = c.stretch
  if (!s) return undefined
  return { ...s, isPaused: now - s.last >= PAUSE_MS }
}

/** Each part's reading, or undefined with nothing to judge. */
function readingOf(id: HealthPartId, c: Cockpit, now: number, pace: PaceReading): PartReading | undefined {
  switch (id) {
    case 'checks': {
      // Until a check runs, there is no telling whether this project has any.
      const hasRun = c.checks.some(ch => ch.status === 'pass' || ch.status === 'fail') || c.passing.length > 0
      if (!hasRun) return undefined
      const open = unverified(c)
      return { id, edits: open ? open.count : c.edits.length, hasPassed: open !== undefined }
    }
    case 'context': {
      const fill = contextNow(c)
      const pct = contextShare(fill)
      if (pct === undefined && c.compactions === 0) return undefined
      return { id, ...(pct !== undefined ? { pct } : {}), ofCompact: fill.autoCompact !== undefined, compactions: c.compactions }
    }
    case 'window': {
      const g = fuelGauge(c, now)
      if (!g || g.isReset || (!g.isUsedUp && g.atReset === undefined)) return undefined
      return { id, pct: g.pct, isUsedUp: g.isUsedUp, ...(g.atReset !== undefined ? { atReset: g.atReset } : {}), ...(g.emptiesAt !== undefined ? { emptiesAt: g.emptiesAt } : {}) }
    }
    case 'runaway': {
      // Runaways are judged from the session's sixth turn on (5 before it to compare with).
      if (c.turnTokens.length < 5 && c.turnUsd.length < 5) return undefined
      const recent = c.history.slice(-RUNAWAY_TURNS).filter(h => h.runaway)
      return { id, count: recent.length, ...(recent.length > 0 ? { last: recent.at(-1)?.n } : {}) }
    }
    case 'pace':
      // The last hour against usual: health is a slow judgement, and the dial's "now" swings with one response.
      return pace.hourRatio !== undefined ? { id, ratio: pace.hourRatio, ...(pace.usualBasis === 'session' ? { isSession: true as const } : {}) } : undefined
    case 'breaks': {
      const s = stretchNow(c, now)
      if (!s) return undefined
      return { id, minutes: s.isPaused ? 0 : (now - s.from) / MINUTE, isPaused: s.isPaused, since: s.isPaused ? s.last : s.from }
    }
    case 'night': {
      const s = stretchNow(c, now)
      if (!s) return undefined
      return { id, minutes: s.isPaused ? 0 : nightMs(s.from, now) / MINUTE }
    }
  }
}

/** The share a reading keeps of its part's weight, by the part's rule. */
export function shareOf(r: PartReading): number {
  switch (r.id) {
    case 'checks':
      return lineShare(r.edits, ...EDITS)
    case 'context': {
      const fill = r.pct !== undefined ? lineShare(r.pct, ...CONTEXT) : 1
      return Math.min(fill, Math.max(0, 1 - PER_COMPACTION * r.compactions))
    }
    case 'window':
      return r.isUsedUp ? 0 : r.atReset !== undefined ? lineShare(r.atReset, ...WINDOW) : 1
    case 'runaway':
      return Math.max(0, 1 - 0.5 * r.count)
    case 'pace':
      return lineShare(r.ratio, ...PACE)
    case 'breaks':
      return lineShare(r.minutes, ...BREAKS)
    case 'night':
      return lineShare(r.minutes, ...NIGHT)
  }
}

/**
 * Whole points off for each part, adding up to `100 - score` exactly: each
 * part's exact loss rounded down, the points left given to the largest
 * remainders.
 */
function wholeOffs(exact: readonly number[], target: number): number[] {
  const floors = exact.map(x => Math.floor(x + 1e-9))
  let left = target - floors.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => ({ i, rest: x - (floors[i] ?? 0) })).sort((a, b) => b.rest - a.rest || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    floors[i] = (floors[i] ?? 0) + 1
    left--
  }
  return floors
}

export function healthWord(score: number): HealthWord {
  return score >= 85 ? 'smooth' : score >= 70 ? 'light' : score >= 50 ? 'choppy' : 'turbulent'
}

/** The judgement: every part's reading, share and loss, the score, its word and its colour. */
export function healthOf(c: Cockpit, now: number, pace: PaceReading): Health {
  const judged = HEALTH_PARTS.map(id => {
    const reading = readingOf(id, c, now, pace)
    const isWarming = id === 'pace' && !reading && !pace.hasData && pace.usual !== undefined
    return { id, weight: HEALTH_WEIGHTS[id], share: reading ? shareOf(reading) : 1, ...(reading ? { reading } : {}), ...(isWarming ? { isWarming: true as const } : {}) }
  })
  const exact = judged.map(p => p.weight * (1 - p.share))
  const score = Math.max(0, Math.min(100, Math.round(100 - exact.reduce((a, b) => a + b, 0))))
  const offs = wholeOffs(exact, 100 - score)
  const parts: HealthPart[] = judged.map((p, i) => ({ ...p, off: offs[i] ?? 0 }))
  const weakest = parts.reduce<HealthPart | undefined>((worst, p) => (p.off > 0 && (!worst || p.off > worst.off) ? p : worst), undefined)
  const level: Level = score < 50 ? 'bad' : score < 70 ? 'warn' : 'none'
  return { score, word: healthWord(score), level, parts, ...(weakest ? { weakest } : {}), isMeasuring: parts.some(p => p.reading !== undefined) }
}

// ------------------------------------------------------------------ words

const minutesText = (minutes: number) => {
  const m = Math.max(0, Math.floor(minutes))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

/** The state's word: smooth, light chop, choppy, turbulent. */
export function wordText(word: HealthWord, L: Locale): string {
  return t(L, `health.word.${word}`)
}

/** A part's name, as the detail lists it. */
export function partName(id: HealthPartId, L: Locale): string {
  return t(L, `health.part.${id}`)
}

/** The rule that turns a part's value into its share. */
export function partRule(id: HealthPartId, L: Locale): string {
  return t(L, `health.rule.${id}`)
}

/** What a part measured, in words; or that it has nothing to judge yet, and why. */
export function partValue(part: HealthPart, L: Locale, clock: (at: number) => string): string {
  const r = part.reading
  if (!r) return t(L, part.isWarming ? 'health.none.paceWarming' : `health.none.${part.id}`)
  switch (r.id) {
    case 'checks':
      return r.hasPassed ? t(L, r.edits === 1 ? 'health.value.checks.one' : 'health.value.checks', { n: r.edits }) : t(L, 'health.value.checksNoPass', { n: r.edits })
    case 'context': {
      const pct = r.pct !== undefined ? t(L, r.ofCompact ? 'health.value.contextCompact' : 'health.value.contextWindow', { pct: formatPercent(r.pct) }) : undefined
      const compactions = r.compactions > 0 ? t(L, r.compactions === 1 ? 'ctx.compaction.long' : 'ctx.compactions.long', { n: r.compactions }) : undefined
      return [pct, compactions].filter(Boolean).join(' · ')
    }
    case 'window':
      if (r.isUsedUp) return t(L, 'health.value.windowUsedUp')
      if (r.emptiesAt !== undefined) return t(L, 'health.value.windowRunsOut', { time: clock(r.emptiesAt), pct: formatPercent(r.pct) })
      return t(L, 'health.value.window', { at: formatPercent(Math.min(999, r.atReset ?? r.pct)), pct: formatPercent(r.pct) })
    case 'runaway':
      return r.count === 0 ? t(L, 'health.value.runawayNone') : t(L, r.count === 1 ? 'health.value.runawayOne' : 'health.value.runaway', { n: r.count, last: r.last ?? 0 })
    case 'pace':
      // Named as the dial names it: this session's own average until 3 past days are kept.
      return t(L, r.isSession ? 'health.value.paceSession' : 'health.value.pace', { x: r.ratio.toFixed(1) })
    case 'breaks':
      return r.isPaused ? t(L, 'health.value.paused', { time: clock(r.since) }) : t(L, 'health.value.breaks', { time: minutesText(r.minutes), since: clock(r.since) })
    case 'night':
      return r.minutes < 1 ? t(L, 'health.value.nightNone') : t(L, 'health.value.night', { time: minutesText(r.minutes) })
  }
}

/** The weakest part in a few words, for the face's second line: `4 edits unverified`. */
export function weakestHint(h: Health, L: Locale): string {
  const r = h.weakest?.reading
  if (!r) return t(L, h.isMeasuring ? 'health.hint.clear' : 'health.hint.none')
  switch (r.id) {
    case 'checks':
      return t(L, r.edits === 1 ? 'health.hint.checks.one' : 'health.hint.checks', { n: r.edits })
    case 'context':
      return r.pct !== undefined && lineShare(r.pct, ...CONTEXT) <= Math.max(0, 1 - PER_COMPACTION * r.compactions)
        ? t(L, 'health.hint.context', { pct: formatPercent(r.pct) })
        : t(L, 'health.hint.compactions', { n: r.compactions })
    case 'window':
      return t(L, r.isUsedUp ? 'health.hint.windowUsedUp' : 'health.hint.window')
    case 'runaway':
      return t(L, r.count === 1 ? 'health.hint.runaway.one' : 'health.hint.runaway', { n: r.count })
    case 'pace':
      return t(L, 'health.hint.pace', { x: r.ratio.toFixed(1) })
    case 'breaks':
      return t(L, 'health.hint.breaks', { time: minutesText(r.minutes) })
    case 'night':
      return t(L, 'health.hint.night', { time: minutesText(r.minutes) })
  }
}
