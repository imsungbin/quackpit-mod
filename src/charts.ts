// The instruments' charts, each a real reading drawn in block characters in
// the theme's own colours, so light and dark themes both read: the cost of
// each turn; the checks as a row a kind and a square a run; the edits per
// file. (The context's bar is context.ts's.) What has passed is dim, the latest reading in full ink, and
// colour comes only past a threshold. Host-neutral lines. Pure.

import { judgedKinds, kindsOf, type CheckKind, type CheckResult } from './checks'
import { liveTurnUsd } from './derive'
import { baseName } from './format'
import { t, type Locale } from './i18n'
import { unverified, type Cockpit } from './model'
import { displayWidth, fit, pad, type Line, type Span, type Tone } from './text'

const EIGHTHS = ' ▁▂▃▄▅▆▇█'

/** A column's look: a threshold's colour, or dim for what has passed and full ink for the latest. */
type Column = { value: number; tone?: Tone; isLatest?: boolean }

/** Columns of eighth blocks `rows` tall against `max`, one cell a column, merged into spans; the top row first. */
function columnLines(columns: readonly Column[], max: number, rows: number, width: number): Line[] {
  const levels = rows * 8
  const heights = columns.map(col => (max > 0 && col.value > 0 ? Math.max(1, Math.round(Math.min(1, col.value / max) * levels)) : 0))
  return Array.from({ length: rows }, (_, row) => {
    const floor = (rows - 1 - row) * 8
    const spans: Span[] = []
    for (let i = 0; i < width; i++) {
      const col = columns[i]
      const inRow = (heights[i] ?? 0) - floor
      const ch = inRow >= 8 ? '█' : inRow <= 0 ? ' ' : (EIGHTHS[inRow] ?? ' ')
      const tone: Tone | undefined = ch === ' ' || !col ? undefined : (col.tone ?? (col.isLatest ? undefined : 'muted'))
      const last = spans.at(-1)
      if (last && last.tone === tone) last.text += ch
      else spans.push({ text: ch, ...(tone ? { tone } : {}) })
    }
    return spans
  })
}

/**
 * What each turn cost: a column a turn, the latest the turn running once the
 * ledger moved; in dollars where every turn shown was priced, else in new
 * tokens. The scale runs to 3× the median turn, the line a runaway crosses,
 * so a full column is a turn that ran away (amber), and one turn alone is a
 * third of the way up, not a full column that reads as dear.
 */
export function costChart(c: Cockpit, width: number, rows: number): { lines: Line[]; unit: 'usd' | 'tokens' } {
  const history = c.history.slice(-width)
  const live = c.turn ? liveTurnUsd(c) : undefined
  const isPriced = history.length > 0 && history.every(h => h.costUsd !== undefined)
  const values: Column[] = history.map(h => ({ value: isPriced ? (h.costUsd ?? 0) : h.tokens, ...(h.runaway ? { tone: 'warn' as const } : {}) }))
  if (isPriced && live !== undefined) values.push({ value: live })
  const shown = values.slice(-width)
  if (shown.length === 0) return { lines: [], unit: isPriced ? 'usd' : 'tokens' }
  const last = shown.at(-1)
  if (last) last.isLatest = true
  const sorted = shown.map(col => col.value).sort((a, b) => a - b)
  const mid = sorted.length % 2 === 1 ? (sorted[(sorted.length - 1) / 2] ?? 0) : ((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2
  return { lines: columnLines(shown, Math.max(3 * mid, ...sorted), rows, width), unit: isPriced ? 'usd' : 'tokens' }
}

const KINDS: readonly CheckKind[] = ['test', 'typecheck', 'lint', 'build']

/** A run's square: green for a pass, red for a failure, hollow for one stopped or cut off, ◌ while it runs. */
function square(check: CheckResult, kind: CheckKind): Span {
  if (check.status === 'pass') return { text: '■', tone: 'ok' }
  if (check.status === 'fail') return judgedKinds(check).includes(kind) ? { text: '■', tone: 'bad' } : { text: '■', tone: 'ok' }
  if (check.status === 'running' || check.status === 'background') return { text: '◌' }
  return { text: '□', tone: 'muted' }
}

/**
 * The checks by kind: a row a kind that ran, its short name, then a square a
 * run, newest on the right. A chain is a run of each of its kinds, failed
 * only on the kinds its output named. The kinds run last keep their rows.
 */
export function checkMatrix(c: Cockpit, L: Locale, width: number, rows: number): Line[] {
  const runs = new Map<CheckKind, { at: number; squares: Span[] }>()
  for (const check of c.checks) {
    for (const kind of kindsOf(check)) {
      const row = runs.get(kind) ?? { at: 0, squares: [] }
      row.squares.push(square(check, kind))
      row.at = check.startedAt
      runs.set(kind, row)
    }
  }
  const kinds = KINDS.filter(kind => runs.has(kind))
  const shown = kinds.length > rows ? [...kinds].sort((a, b) => (runs.get(b)?.at ?? 0) - (runs.get(a)?.at ?? 0)).slice(0, rows) : kinds
  const ordered = KINDS.filter(kind => shown.includes(kind))
  const labelW = Math.max(0, ...ordered.map(kind => displayWidth(t(L, `kindShort.${kind}`)))) + 1
  const room = Math.max(1, width - labelW)
  return ordered.map(kind => {
    const squares = runs.get(kind)?.squares.slice(-room) ?? []
    return [{ text: pad(t(L, `kindShort.${kind}`), labelW), tone: 'muted' as const }, ...squares]
  })
}

/**
 * The edits per file, the most edited first: a thin bar each (its length the
 * file's edits against the most edited), its name and count after it. A file
 * no passing check has seen since its edit has its bar in full ink, the rest
 * dim. Past `rows` files the last row counts the rest.
 */
export function fileBars(c: Cockpit, L: Locale, width: number, rows: number): Line[] {
  if (c.files.length === 0) return []
  const files = [...c.files].sort((a, b) => b.edits - a.edits || b.lastAt - a.lastAt)
  const open = new Set(unverified(c)?.paths ?? [])
  const barMax = Math.max(3, Math.min(10, width - 22))
  const top = Math.max(1, files[0]?.edits ?? 1)
  const shown = files.length > rows ? files.slice(0, rows - 1) : files
  const lines: Line[] = shown.map(f => {
    const halves = Math.max(1, Math.round((f.edits / top) * barMax * 2))
    const bar = '━'.repeat(Math.floor(halves / 2)) + (halves % 2 === 1 ? '╸' : '')
    const count = ` ×${f.edits}`
    const name = fit(baseName(f.path), Math.max(4, width - barMax - 1 - displayWidth(count)))
    return [{ text: pad(bar, barMax + 1), ...(open.has(f.path) ? {} : { tone: 'muted' as const }) }, { text: name }, { text: count, tone: 'muted' }]
  })
  if (files.length > shown.length) {
    const left = files.length - shown.length
    lines.push([{ text: ' '.repeat(barMax + 1) }, { text: t(L, 'time.more', { n: left }), tone: 'muted' }])
  }
  return lines
}
