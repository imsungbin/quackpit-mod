// Numbers, money, durations and clock times as the band and the handover
// print them. Pure; locale-aware only where words are involved.

import { t, type Locale } from './i18n'
import { HOUR, MINUTE } from './metrics'

/** 950, 12.3k, 340k, 1.2M, 15M. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${trim1(n / 1000)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`
  return `${Math.round(n / 1_000_000)}M`
}

function trim1(x: number): string {
  const s = x.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/** $0.004, $0.42, $3.10, $12.4, $128. */
export function formatUsd(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '—'
  const v = Math.max(0, usd)
  if (v === 0) return '$0'
  // Under a tenth of a cent it would round to $0.000, which reads as nothing spent.
  if (v < 0.0005) return '<$0.001'
  if (v < 0.01) return `$${v.toFixed(3)}`
  if (v < 10) return `$${v.toFixed(2)}`
  if (v < 100) return `$${v.toFixed(1)}`
  return `$${Math.round(v)}`
}

/** 0.4 s, 3.1 s, 42 s, 4m 05s, 1h 12m. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms < MINUTE) return `${Math.round(ms / 1000)} s`
  if (ms < HOUR) {
    const m = Math.floor(ms / MINUTE)
    const s = Math.floor((ms % MINUTE) / 1000)
    return `${m}m ${String(s).padStart(2, '0')}s`
  }
  const h = Math.floor(ms / HOUR)
  const m = Math.floor((ms % HOUR) / MINUTE)
  return `${h}h ${String(m).padStart(2, '0')}m`
}

/** A turn clock: 0:42, 3:05, 1:12:09. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/**
 * A length in whole minutes, for what is still going or shown on a 30-second
 * redraw: <1m, 4m, 1h12m. Nothing in the band ticks seconds.
 */
export function formatMinutes(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const min = Math.floor(ms / MINUTE)
  if (min < 1) return '<1m'
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`
}

/** A finished length as the pane's task and agent rows print it: 4m12, 52s, 1h04m. */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** An estimate of time left, whole minutes, never finer: 9m, 1h20m. The caller adds the `~`. */
export function formatLeft(ms: number): string {
  const min = Math.max(1, Math.round(ms / MINUTE))
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`
}

/** A countdown in whole minutes: 45m, 1h12, 3d4h. */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  const min = Math.max(0, Math.ceil(ms / MINUTE))
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h${String(min % 60).padStart(2, '0')}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24}h`
}

/** Local wall-clock time, 24-hour: 14:52. */
export function clockText(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Local date and time for the handover: 2026-10-11 14:52. */
export function stampText(at: number): string {
  const d = new Date(at)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${date} ${clockText(at)}`
}

/** The local calendar day of a moment, as YYYY-MM-DD. */
export function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** How long ago, in whole minutes: just now, 4 min ago, 2 h ago, in the person's language. No seconds: the band redraws every 30 s. */
export function formatAge(ms: number, locale: Locale): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return t(locale, 'age.now')
  if (s < 3600) return t(locale, 'age.min', { n: Math.floor(s / 60) })
  if (s < 86_400) return t(locale, 'age.hour', { n: Math.floor(s / 3600) })
  return t(locale, 'age.day', { n: Math.floor(s / 86_400) })
}

/** 0 to 100 as a whole percent; one decimal under 10 when it has one. */
export function formatPercent(pct: number | undefined): string {
  if (pct === undefined || !Number.isFinite(pct)) return '—'
  const v = Math.max(0, pct)
  if (v < 10 && Math.round(v * 10) % 10 !== 0) return `${v.toFixed(1)}%`
  return `${Math.round(v)}%`
}

/** Cuts text to `max` characters on a word boundary where one is near, with an ellipsis. */
export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  if (max <= 1) return '…'
  const cut = one.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`
}

/**
 * A long text cut to about `max` characters, its lines kept: the head (where a
 * request or a plan says what it is) and the tail, an ellipsis line between.
 */
export function squeeze(text: string, max: number): string {
  const whole = text.trim()
  if (whole.length <= max) return whole
  const head = Math.ceil(max * 0.6)
  return `${whole.slice(0, head).trimEnd()}\n…\n${whole.slice(whole.length - (max - head)).trimStart()}`
}

/**
 * Words added to words kept so far, held to `max` characters: once over, the
 * first `head` stay (a plan is said first) and the latest fill the rest, so a
 * long turn's words stay as long as this however often they are added to.
 */
export function addWords(kept: string | undefined, words: string, max = 1600, head = 900): string {
  const more = words.trim()
  if (more === '') return kept ?? ''
  const joined = kept ? `${kept}\n${more}` : more
  if (joined.length <= max) return joined
  // Untrimmed, so the head is the same 900 characters every time and the ellipsis never reaches the tail.
  return `${joined.slice(0, head)}\n…\n${joined.slice(joined.length - (max - head - 3))}`
}

/** The last segment of a path. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

/** A path shown relative to the project root when it lies under it. */
export function relativePath(path: string, root: string | undefined): string {
  if (!root) return path
  const r = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(r) ? path.slice(r.length) : path
}
