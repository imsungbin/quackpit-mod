// The duck is quackpit's Master Caution. It stays still with its head down
// until one of four things needs attention:
//   - a failed check (the latest run of a test, typecheck, lint or build),
//   - the five-hour window at 80% or more (unless it resets within 30 minutes
//     and its forecast says it lasts until then, or its reset has passed),
//   - the context within 10% of the point where Claude Code compacts it by
//     itself (at 90% of the window while auto-compact is off),
//   - a turn that cost over 3x the session's median turn.
// Then it raises its head and its cell says "Quack:". Pressing it
// acknowledges, as a pilot presses the caution light; the gauge stays lit
// until the cause clears. Only a failed check and the five-hour window at
// 90% may raise an OS notification, at most 3 a day. Pure.

import type { CheckKind } from './checks'
import { fiveHourForecast, isReset, lastsToReset } from './derive'
import { formatPercent } from './format'
import { t, type Locale } from './i18n'
import { formatTokens } from './format'
import { contextNow, contextShare, type Cockpit } from './model'
import { displayWidth, fit } from './text'

export type CautionKind = 'check' | 'five' | 'context' | 'runaway'

export type Caution = {
  /** Stable while the cause lasts; a new cause gets a new key. */
  key: string
  kind: CautionKind
  level: 'warn' | 'bad'
  /** Worth an OS notification (a failed check, five_hour at 90%+). */
  isNotify: boolean
  /** When its cause happened: the check's end, the turn's end, the latest reading for the gauges. */
  at: number
  checkKind?: CheckKind
  pct?: number
  /** Tokens left before the auto-compact point, when auto-compact is on. */
  left?: number
  turn?: number
  factor?: number
}

export const FIVE_CAUTION_PCT = 80
export const FIVE_NOTIFY_PCT = 90
/** Of the auto-compact point while auto-compact is on, else of the window. */
export const CONTEXT_CAUTION_PCT = 90
export const NOTIFY_PER_DAY = 3

export function cautionsOf(c: Cockpit, now: number = c.lastAt): Caution[] {
  const out: Caution[] = []
  // Each kind of check whose latest run failed: a chain counts for every check it ran, so a
  // later pass of a kind clears its failure wherever that pass ran (decision 98).
  for (const failure of c.failures) {
    out.push({
      key: `check:${failure.kind}:${failure.at}`,
      kind: 'check',
      level: 'bad',
      isNotify: true,
      at: failure.at,
      checkKind: failure.kind,
    })
  }
  const five = c.reading?.fiveHour
  // A window that has reset is over; one that resets within 30 minutes and lasts until then needs no one.
  if (five && five.pct >= FIVE_CAUTION_PCT && !isReset(five, now) && !lastsToReset(five, fiveHourForecast(c), now)) {
    const isHigh = five.pct >= FIVE_NOTIFY_PCT
    out.push({
      key: `five:${isHigh ? FIVE_NOTIFY_PCT : FIVE_CAUTION_PCT}:${five.resetsAt ?? 0}`,
      kind: 'five',
      level: isHigh ? 'bad' : 'warn',
      isNotify: isHigh,
      at: c.reading?.at ?? 0,
      pct: five.pct,
    })
  }
  const fill = contextNow(c)
  const share = contextShare(fill)
  if (share !== undefined && share >= CONTEXT_CAUTION_PCT) {
    const left = fill.autoCompact !== undefined && fill.tokens !== undefined ? Math.max(0, fill.autoCompact - fill.tokens) : undefined
    out.push({ key: `ctx:${c.compactions}`, kind: 'context', level: 'bad', isNotify: false, at: c.lastAt, ...(fill.pct !== undefined ? { pct: fill.pct } : {}), ...(left !== undefined ? { left } : {}) })
  }
  const last = c.history.at(-1)
  if (last?.runaway && !c.turn) {
    out.push({
      key: `runaway:${last.n}`,
      kind: 'runaway',
      level: 'warn',
      isNotify: false,
      at: last.endedAt,
      turn: last.n,
      ...(last.factor !== undefined ? { factor: last.factor } : {}),
    })
  }
  // Worst first, then by kind, then the newest check. Kind before time, because the
  // gauges' cautions carry the latest reading's time: ordered by time, the one the
  // duck names would change with every reading.
  const rank = { bad: 1, warn: 0 }
  const order: Record<CautionKind, number> = { check: 0, five: 1, context: 2, runaway: 3 }
  return out.sort((a, b) => rank[b.level] - rank[a.level] || order[a.kind] - order[b.kind] || b.at - a.at)
}

export type DuckState = {
  pose: 'idle' | 'alert'
  /** The caution the cell names: the worst one not yet acknowledged. */
  caution?: Caution
  /** How many cautions are live, acknowledged or not. */
  live: number
}

export function duckState(c: Cockpit, cautions: readonly Caution[] = cautionsOf(c)): DuckState {
  const open = cautions.filter(k => !c.ack.includes(k.key))
  const first = open[0]
  return first ? { pose: 'alert', caution: first, live: cautions.length } : { pose: 'idle', live: cautions.length }
}

/** Cautions not yet announced: each gets one toast (and maybe a notification). */
export function freshCautions(c: Cockpit, cautions: readonly Caution[] = cautionsOf(c)): Caution[] {
  return cautions.filter(k => !c.seen.includes(k.key))
}

/** The words for a caution, without the "Quack:" prefix. */
export function cautionText(k: Caution, locale: Locale): string {
  switch (k.kind) {
    case 'check':
      return t(locale, 'caution.check', { kind: t(locale, `kind.${k.checkKind ?? 'test'}`) })
    case 'five':
      return t(locale, 'caution.five', { pct: formatPercent(k.pct) })
    case 'context':
      return k.left !== undefined ? t(locale, 'caution.compact', { left: formatTokens(k.left) }) : t(locale, 'caution.context', { pct: formatPercent(k.pct) })
    case 'runaway':
      return t(locale, 'caution.runaway', { n: k.turn ?? 0, x: k.factor !== undefined ? k.factor.toFixed(1) : '3+' })
  }
}

/**
 * The caution in at most `room` columns, for the band's duck: its words where
 * they fit, else their short form (`5h at 84%`, `turn 12: 3.4×`), never a
 * reading cut off.
 */
export function cautionFit(k: Caution, locale: Locale, room: number): string {
  const long = cautionText(k, locale)
  if (displayWidth(long) <= room) return long
  switch (k.kind) {
    case 'check':
      return fit(t(locale, 'caution.check', { kind: t(locale, `kindShort.${k.checkKind ?? 'test'}`) }), room)
    case 'five':
      return fit(t(locale, 'caution.fiveShort', { pct: formatPercent(k.pct) }), room)
    case 'context':
      return fit(k.left !== undefined ? long : t(locale, 'caution.contextShort', { pct: formatPercent(k.pct) }), room)
    case 'runaway':
      return fit(t(locale, 'caution.runawayShort', { n: k.turn ?? 0, x: k.factor !== undefined ? k.factor.toFixed(1) : '3+' }), room)
  }
}

export function quackLine(k: Caution, locale: Locale): string {
  return `${t(locale, 'duck.quack')} ${cautionText(k, locale)}`
}

/** The per-day notification counter as the store keeps it. */
export type NotifyRecord = { day: string; count: number }

/** Takes one of the day's 3 notification slots, if one is left. */
export function takeNotifySlot(record: NotifyRecord | undefined, day: string): { record: NotifyRecord; isTaken: boolean } {
  const current = record && record.day === day ? record : { day, count: 0 }
  if (current.count >= NOTIFY_PER_DAY) return { record: current, isTaken: false }
  return { record: { day, count: current.count + 1 }, isTaken: true }
}

/** Gives a slot back when the notification did not go out. */
export function returnNotifySlot(record: NotifyRecord | undefined, day: string): NotifyRecord {
  if (!record || record.day !== day) return { day, count: 0 }
  return { day, count: Math.max(0, record.count - 1) }
}

