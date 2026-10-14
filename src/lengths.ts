// What your turns usually take, from the lengths quackpit recorded: this
// session's finished turns and the other sessions' (read with their records,
// as the task priors are). Three uses: the fact a long turn with no estimate
// shows ("longer than 90% of your turns"), never a guessed time; the
// history-only estimate the AI ETA is scored against (the median of your past
// turns that ran longer than this one so far, as the claude-eta mod does it);
// and the figures the AI ETA is sent to calibrate by. Pure.

import type { Durations } from './eta'
import { median } from './metrics'
import type { Cockpit } from './model'

/** Recorded turns needed before a turn is compared with them. */
export const MIN_TURNS_FOR_FACT = 20
/** Past turns longer than this one needed before history estimates what is left. */
export const MIN_LONGER_FOR_HISTORY = 3
/** The shares a fact rounds down to: it says no more than it knows. */
const STEPS = [99, 95, 90, 80, 70, 60, 50] as const

/** This session's finished turns and the other sessions', as recorded. */
export function turnLengths(c: Cockpit, priors?: Durations): number[] {
  return [...c.durations.turns, ...(priors?.turns ?? [])]
}

/** The `q` quantile (0 to 1) of lengths, by nearest rank. */
export function quantile(lengths: readonly number[], q: number): number | undefined {
  if (lengths.length === 0) return undefined
  const sorted = [...lengths].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)))
  return sorted[rank - 1]
}

/** How a turn running this long compares with your recorded turns. */
export type TurnFact = { kind: 'share'; pct: (typeof STEPS)[number]; n: number } | { kind: 'longest'; n: number }

/**
 * The fact for a turn that has run `elapsedMs`: longer than every recorded
 * turn, or longer than at least a round share of them (half, 60%, ... 90%,
 * 95%, 99%), rounded down. Undefined under 20 recorded turns, and while the
 * turn is shorter than half of them: there is nothing to say yet.
 */
export function turnFact(lengths: readonly number[], elapsedMs: number): TurnFact | undefined {
  const n = lengths.length
  if (n < MIN_TURNS_FOR_FACT || !(elapsedMs > 0)) return undefined
  const shorter = lengths.filter(ms => ms < elapsedMs).length
  if (shorter === n) return { kind: 'longest', n }
  const pct = STEPS.find(step => shorter * 100 >= step * n)
  return pct === undefined ? undefined : { kind: 'share', pct, n }
}

/**
 * What history alone says is left of a turn that has run `elapsedMs`: the
 * median of your recorded turns that ran longer, less the time it has run.
 * Undefined with fewer than 3 such turns. Free and local: what the AI ETA is
 * compared with.
 */
export function historyLeft(lengths: readonly number[], elapsedMs: number): number | undefined {
  const longer = lengths.filter(ms => ms > elapsedMs)
  if (longer.length < MIN_LONGER_FOR_HISTORY) return undefined
  const mid = median(longer)
  return mid === undefined ? undefined : Math.max(0, mid - elapsedMs)
}

/** Your turn lengths in a few figures: all of them, and those that ran past this one so far. */
export type Calibration = {
  n: number
  p50: number
  p90: number
  p95: number
  longer?: { n: number; p50: number; p90: number }
}

export function calibration(lengths: readonly number[], elapsedMs: number): Calibration | undefined {
  const p = (xs: readonly number[], q: number) => quantile(xs, q) ?? 0
  if (lengths.length < MIN_LONGER_FOR_HISTORY) return undefined
  const longer = lengths.filter(ms => ms > elapsedMs)
  return {
    n: lengths.length,
    p50: p(lengths, 0.5),
    p90: p(lengths, 0.9),
    p95: p(lengths, 0.95),
    ...(longer.length >= MIN_LONGER_FOR_HISTORY ? { longer: { n: longer.length, p50: p(longer, 0.5), p90: p(longer, 0.9) } } : {}),
  }
}
