// Readings derived from the cockpit: pace now against your usual pace (or,
// until 3 past days are kept, this session's own average), the five-hour
// window as a fuel gauge (used, where the trend ends at the reset, how much of
// the window has passed), and the threshold level of each gauge. Pure.

import { dayPace, HOUR, median, MINUTE, nowRate, paceAt, paceCoverageMs } from './metrics'
import { limitsAt, type Cockpit, type Window } from './model'

/** Colour only on thresholds: `none` draws in the theme's own text colour. */
export type Level = 'none' | 'ok' | 'warn' | 'bad'

/** Below 10 minutes of data the pace needle is grey and only the number shows. */
export const PACE_MIN_DATA_MS = 10 * MINUTE

/** The dial reads 0 to 2× your usual pace: usual straight up, amber from 1.5×, red from 1.8×. */
export const DIAL_MAX_RATIO = 2
export const PACE_WARN_RATIO = 1.5
export const PACE_BAD_RATIO = 1.8

/** A day as the store rolls it up: what `dayPace` takes. */
export type DayTotals = { day: string; tokens: number; activeMin: number }

/** Where "usual" comes from: the median of your last days (3 at least), or this session's own average. */
export type Usual = { perHour: number; basis: 'days' | 'session'; n: number }

/**
 * Your usual pace in tokens per active hour: the median day of the last 14
 * (3 days or more), else this session's own average once it has 10 active
 * minutes, else unknown. `n` is how many days, or how many active minutes.
 */
export function usualOf(c: Cockpit, days: readonly DayTotals[], today: string): Usual | undefined {
  const past = days.filter(d => d.day < today && d.activeMin > 0 && d.tokens > 0).slice(-14)
  if (past.length >= 3) return { perHour: median(past.map(d => dayPace(d.tokens, d.activeMin))) ?? 0, basis: 'days', n: past.length }
  const activeMin = c.activeMs / MINUTE
  if (activeMin >= 10 && c.tokens > 0) return { perHour: dayPace(c.tokens, activeMin), basis: 'session', n: Math.floor(activeMin) }
  return undefined
}

/** Your usual pace's figure alone (see `usualOf`). */
export function usualPace(c: Cockpit, days: readonly DayTotals[], today: string): number | undefined {
  return usualOf(c, days, today)?.perHour
}

export type Eta =
  | { kind: 'empties'; at: number }
  | { kind: 'holds'; resetsAt: number }
  | { kind: 'flat' }

export const FIVE_HOUR_MS = 5 * 60 * MINUTE
export const SEVEN_DAY_MS = 7 * 24 * 60 * MINUTE
/** The readings a five-hour forecast fits a line through. */
export const FIT_SPAN_MS = 90 * MINUTE
const FIT_MIN_READINGS = 3

/** A reading whose window reset has come: that window is over, whatever it said. */
export function isReset(w: Window, now: number): boolean {
  return w.resetsAt !== undefined && w.resetsAt <= now
}

/** Points per millisecond, by least squares through the readings (or undefined with no spread in time). */
function slope(points: readonly [number, number][]): number | undefined {
  const n = points.length
  const mx = points.reduce((a, [x]) => a + x, 0) / n
  const my = points.reduce((a, [, y]) => a + y, 0) / n
  const sxx = points.reduce((a, [x]) => a + (x - mx) ** 2, 0)
  const sxy = points.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0)
  return sxx > 0 ? sxy / sxx : undefined
}

export type Forecast = {
  /** Points per millisecond. */
  rate: number
  /** `fit`: a least-squares line through the last 90 minutes of readings; `average`: the window's use so far over its time so far. */
  how: 'fit' | 'average'
  /** The percent the window reaches at its reset at this rate (past 100 when it runs out first). */
  atReset?: number
  /** When it reaches 100%, if before its reset. */
  emptiesAt?: number
}

/**
 * Where a plan window is heading, from its own readings only. The five-hour
 * window fits a least-squares line through the readings of the last 90
 * minutes (3 at least, 10 minutes apart at least); without that, and for the
 * seven-day window always, the rate is what it used over the time it has
 * been open (its reset less its length), once 10 minutes have passed. A
 * window that has reset has no forecast.
 */
export function forecast(w: Window | undefined, lengthMs: number, readAt: number, samples: readonly [number, number][] | undefined): Forecast | undefined {
  if (!w || isReset(w, readAt)) return undefined
  let rate: number | undefined
  let how: Forecast['how'] = 'fit'
  if (samples) {
    const points = samples.filter(([t]) => t > readAt - FIT_SPAN_MS && t <= readAt)
    const first = points[0]
    const last = points.at(-1)
    if (first && last && points.length >= FIT_MIN_READINGS && last[0] - first[0] >= PACE_MIN_DATA_MS) rate = slope(points)
  }
  if (rate === undefined && w.resetsAt !== undefined) {
    const open = readAt - (w.resetsAt - lengthMs)
    if (open >= PACE_MIN_DATA_MS && open <= lengthMs) {
      rate = w.pct / open
      how = 'average'
    }
  }
  if (rate === undefined) return undefined
  rate = Math.max(0, rate)
  const out: Forecast = { rate, how }
  if (w.resetsAt !== undefined) out.atReset = w.pct + rate * (w.resetsAt - readAt)
  if (rate > 0 && w.pct < 100) {
    const at = readAt + (100 - w.pct) / rate
    if (w.resetsAt === undefined || at < w.resetsAt) out.emptiesAt = at
  }
  return out
}

/** The five-hour window's forecast, from the cockpit's readings. */
export function fiveHourForecast(c: Cockpit): Forecast | undefined {
  const r = c.reading
  return r ? forecast(r.fiveHour, FIVE_HOUR_MS, r.at, c.fiveSamples) : undefined
}

/** The seven-day window's forecast: its average so far (a 90-minute slope would read a working hour as the week). */
export function sevenDayForecast(c: Cockpit): Forecast | undefined {
  const r = c.reading
  return r ? forecast(r.sevenDay, SEVEN_DAY_MS, r.at, undefined) : undefined
}

/** When the five-hour window empties at the rate its readings show, or that it lasts to its reset. */
export function fiveHourEta(c: Cockpit, now: number): Eta | undefined {
  const w = c.reading?.fiveHour
  if (!w || isReset(w, now)) return undefined
  const f = fiveHourForecast(c)
  if (!f) return undefined
  if (f.rate <= 0.01 / MINUTE) return { kind: 'flat' }
  if (f.emptiesAt !== undefined) return { kind: 'empties', at: f.emptiesAt }
  return w.resetsAt !== undefined ? { kind: 'holds', resetsAt: w.resetsAt } : { kind: 'flat' }
}

/** Under this long to its reset, a window the forecast says will last raises no caution. */
export const CALM_BEFORE_RESET_MS = 30 * MINUTE

/** Whether a window that lasts until its reset at this rate resets soon enough that a caution would be noise. */
export function lastsToReset(w: Window, f: Forecast | undefined, now: number): boolean {
  return w.resetsAt !== undefined && w.resetsAt - now < CALM_BEFORE_RESET_MS && f?.atReset !== undefined && f.atReset < 100
}

export type PaceReading = {
  /** New tokens an hour now: each response weighed by how recent it is, halving every 5 minutes. */
  perHour: number
  /** New tokens over the last 60 minutes. */
  hourSum: number
  hasData: boolean
  usual?: number
  /** Where the usual comes from: your last days, or this session's own average (until 3 days are kept). */
  usualBasis?: Usual['basis']
  /** The needle, 0 to 1 across the dial; absent without a usual pace. */
  needle?: number
  /** Now against usual. */
  ratio?: number
  /** The last hour's sum against usual: a slower reading, which health's pace part takes. */
  hourRatio?: number
  eta?: Eta
  level: Level
  /** With no turn running, how long since the last one ended (or since quackpit began watching). */
  idleMs?: number
}

export function paceReading(c: Cockpit, now: number, days: readonly DayTotals[], today: string): PaceReading {
  const perHour = nowRate(c.recent, now)
  const hourSum = paceAt(c.recent, now)
  const hasData = paceCoverageMs(c.startedAt, now) >= PACE_MIN_DATA_MS
  const usual = usualOf(c, days, today)
  const eta = fiveHourEta(c, now)
  const ratio = hasData && usual !== undefined && usual.perHour > 0 ? perHour / usual.perHour : undefined
  const hourRatio = hasData && usual !== undefined && usual.perHour > 0 ? hourSum / usual.perHour : undefined
  let level: Level = 'none'
  if (ratio !== undefined && ratio >= PACE_BAD_RATIO) level = 'bad'
  else if (ratio !== undefined && ratio >= PACE_WARN_RATIO) level = 'warn'
  if (eta?.kind === 'empties' && level === 'none') level = 'warn'
  const lastEnd = c.history.at(-1)?.endedAt ?? c.startedAt
  return {
    perHour,
    hourSum,
    hasData,
    level,
    ...(usual !== undefined ? { usual: usual.perHour, usualBasis: usual.basis } : {}),
    ...(ratio !== undefined ? { ratio, needle: Math.min(1, ratio / DIAL_MAX_RATIO) } : {}),
    ...(hourRatio !== undefined ? { hourRatio } : {}),
    ...(eta ? { eta } : {}),
    ...(c.turn ? {} : { idleMs: Math.max(0, now - lastEnd) }),
  }
}

/** Readings older than this are stale: the fuel gauge's needle goes grey. */
export const STALE_MS = 15 * MINUTE
/** A run-out this near is red: there is little left to do about it. */
export const RUNS_OUT_SOON_MS = 30 * MINUTE

/**
 * The five-hour window as a fuel gauge, for the whole account (other
 * sessions, other machines and claude.ai draw on it too): how much is used,
 * where the trend ends at the reset (the 90-minute fit, or the window's
 * average so far), how much of the window has passed, and when it runs out if
 * that comes first. All of it as of the readings' own time: they come only
 * with this session's responses, so while it is idle they go stale, and
 * `asOf` says since when.
 */
export type FuelGauge = {
  pct: number
  resetsAt?: number
  /** How much of the window has passed, 0 to 1: the dial's tick. */
  elapsed?: number
  /** The percent the window reaches at its reset at this trend (past 100 when it runs out first): where the dial's grey arc ends. */
  atReset?: number
  /** Points an hour: how fast the window has been filling. */
  rate?: number
  how?: Forecast['how']
  /** When it reaches 100%, if before its reset. */
  emptiesAt?: number
  isReset: boolean
  isUsedUp: boolean
  asOf: number
  isStale: boolean
  level: Level
}

export function fuelGauge(c: Cockpit, now: number): FuelGauge | undefined {
  const r = c.reading
  const w = r?.fiveHour
  if (!r || !w) return undefined
  const asOf = limitsAt(c) ?? r.at
  const base = { pct: w.pct, ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}), asOf, isStale: now - asOf > STALE_MS }
  if (isReset(w, now)) return { ...base, isReset: true, isUsedUp: false, level: 'none' }
  const isUsedUp = w.pct >= 100
  const f = fiveHourForecast(c)
  const elapsed = w.resetsAt !== undefined ? Math.max(0, Math.min(1, 1 - (w.resetsAt - now) / FIVE_HOUR_MS)) : undefined
  const runsOutSoon = f?.emptiesAt !== undefined && f.emptiesAt - now < RUNS_OUT_SOON_MS
  const level: Level = isUsedUp || w.pct >= 90 || runsOutSoon ? 'bad' : w.pct >= 80 || f?.emptiesAt !== undefined ? 'warn' : 'none'
  return {
    ...base,
    isReset: false,
    isUsedUp,
    ...(elapsed !== undefined ? { elapsed } : {}),
    ...(f?.atReset !== undefined ? { atReset: f.atReset } : {}),
    ...(f ? { rate: f.rate * HOUR, how: f.how } : {}),
    ...(f?.emptiesAt !== undefined && !isUsedUp ? { emptiesAt: f.emptiesAt } : {}),
    level,
  }
}

export function contextLevel(pct: number | undefined): Level {
  if (pct === undefined) return 'none'
  if (pct >= 90) return 'bad'
  if (pct >= 70) return 'warn'
  return 'none'
}

export function fiveHourLevel(w: Window | undefined, now?: number): Level {
  if (!w || (now !== undefined && isReset(w, now))) return 'none'
  if (w.pct >= 90) return 'bad'
  if (w.pct >= 80) return 'warn'
  return 'none'
}

export function sevenDayLevel(w: Window | undefined, now?: number): Level {
  if (!w || (now !== undefined && isReset(w, now))) return 'none'
  if (w.pct >= 90) return 'bad'
  if (w.pct >= 75) return 'warn'
  return 'none'
}

/**
 * The cost of the turn running now: the ledger's growth since the turn began,
 * once a reading shows any. The ledger is read as the turn starts and pushed
 * again only when a plan window moves a point or the turn ends, so until then
 * the growth reads 0, which is no figure: every response costs something.
 */
export function liveTurnUsd(c: Cockpit): number | undefined {
  const start = c.turn?.costAtStart
  const now = c.reading?.costUsd
  return start !== undefined && now !== undefined && now > start ? now - start : undefined
}

/** The worse of two levels. */
export function worse(a: Level, b: Level): Level {
  const rank: Record<Level, number> = { none: 0, ok: 1, warn: 2, bad: 3 }
  return rank[a] >= rank[b] ? a : b
}
