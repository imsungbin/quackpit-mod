// The pane `/quackpit` opens, a view at a time (views.ts): on top the view
// bar and, outside the overview, the progress in one line; at the bottom the
// keys of the view in front; between them the view's body, sized to the rows
// the pane has. The overview is progress across the top and the instruments
// under it (instruments.ts), with one line of cautions when there are any; a
// press on an instrument drills into its detail (details.ts), in its place
// or, where the pane is wide, beside a list of the instruments. The other
// views are the timeline (timeline.ts), the turns with the mission over them,
// the band's layout, the handover and the guide. Everything is laid out as
// parts of a known height, so the terminal's pinned window (pin.ts) can tell
// where each press is. Host-neutral; the adapter draws them. Pure.

import { cautionsOf, cautionText, type Caution } from './duck'
import type { Level } from './derive'
import type { Detail, DetailId } from './details'
import { baseName, clockText, formatDuration, formatPercent, formatTokens, formatUsd } from './format'
import { t, type Key, type Locale } from './i18n'
import { DETAIL_OF, INSTRUMENT_MIN_WIDTH, INSTRUMENT_ROWS, instrumentIds, instrumentName, instrumentOf, instrumentReading, nameColumn, shortName, type Instrument, type InstrumentId, type InstrumentSize } from './instruments'
import { contextNow, turnLength, type TurnSource } from './model'
import { displayWidth, fit, fitLine, lineWidth, pad, plain, sparkline, wrapLine, type Line, type Span, type Tone } from './text'
import { summaryLine, topSection, type Summary, type TopSection } from './top'
import { weakestHint, wordText } from './health'
import { backgroundCheckText, checksFace, checkWhen, compactFace, contextFace, costFace, kindsText, shownCheck, tileFace, type Readings, type TileId } from './tiles'
import type { Graphic } from './gauges'
import type { TimeBlocks } from './timeline'
import type { GuideRow } from './guide'
import { barWidth, hintLine, viewBar, type PaneView, type ViewBar } from './views'

const toneOf = (level: Level): Tone | undefined => (level === 'bad' ? 'bad' : level === 'warn' ? 'warn' : level === 'ok' ? 'ok' : undefined)
const muted = (text: string): Span => ({ text, tone: 'muted' })

// ------------------------------------------------------------------ the cautions and the mission

/**
 * The cautions as one line, only when there are any: `Quack:` and each one's
 * words, the acknowledged ones dim. The overview's; the band says the same.
 */
export function cautionsLine(r: Readings, width: number): Line | undefined {
  const L = r.ctx.locale
  const list: Caution[] = cautionsOf(r.c, r.ctx.now)
  if (list.length === 0) return undefined
  const worst = list.some(k => k.level === 'bad' && !r.c.ack.includes(k.key)) ? 'bad' : 'warn'
  const spans: Span[] = [{ text: `${t(L, 'duck.quack')} `, bold: true, tone: list.every(k => r.c.ack.includes(k.key)) ? 'muted' : worst }]
  list.forEach((k, i) => {
    const isAck = r.c.ack.includes(k.key)
    if (i > 0) spans.push(muted(' · '))
    spans.push({ text: cautionText(k, L), ...(isAck ? { tone: 'muted' as const } : { tone: k.level === 'bad' ? ('bad' as const) : ('warn' as const) }) })
  })
  return fitLine(spans, width)
}

/** A head of 9 columns, then words that wrap beneath it, at most two lines. */
function headed(head: string, body: Line, width: number): Line[] {
  // 9 columns, or the head and two more where a language's word is longer (`ミッション` takes 10).
  const headW = Math.max(9, displayWidth(head) + 2)
  const lines = wrapLine(body, Math.max(8, width - headW), 2)
  return lines.map((line, i) => [i === 0 ? { text: pad(head, headW), bold: true, tone: 'muted' } : { text: ' '.repeat(headW) }, ...line])
}

/** The mission: the goal over two lines at most, cut where the second ends (the handover keeps it whole). */
export function missionLines(r: Readings, width: number): Line[] {
  const L = r.ctx.locale
  const goal = r.c.goal
  return headed(t(L, 'pane.mission'), [goal ? { text: goal } : muted(t(L, r.c.goalLost ? 'pane.goalLost' : 'pane.noGoal'))], width)
}

// ------------------------------------------------------------------ the turns

/** The turns table's columns: each head's words and its width. */
const HISTORY_COLUMNS: readonly [Key, number][] = [
  ['hist.n', 3],
  ['hist.start', 6],
  ['hist.time', 8],
  ['hist.tokens', 8],
  ['hist.cost', 7],
  ['hist.tools', 6],
  ['hist.edits', 6],
]

/** `text` padded on the left to `width` columns, a wide character counting two. */
const padStart = (text: string, width: number) => ' '.repeat(Math.max(0, width - displayWidth(text))) + text

/** A history row, and the transcript row it scrolls to when pressed: the turn's first tool call. */
export type HistoryRow = { line: Line; target?: string; n: number }

/**
 * What started a turn no person typed, in plain words: `(a subagent's report)`,
 * `(background task: Map the parser)`. Within `room` columns the name is cut,
 * never the words around it.
 */
export function sourceText(source: TurnSource, L: Locale, room = Infinity): string {
  const label = (name: string | undefined) => sourceLabel({ ...source, ...(name !== undefined ? { name } : {}) }, L)
  if (displayWidth(label(source.name)) <= room) return label(source.name)
  if (source.name === undefined) return fit(label(undefined), room)
  // The label's own words, measured with a one-column name (an empty one reads as no name at all).
  const around = displayWidth(label('x')) - 1
  return around + 2 <= room ? label(fit(source.name, room - around)) : fit(label(source.name), room)
}

function sourceLabel(source: TurnSource, L: Locale): string {
  const name = source.name
  switch (source.kind) {
    case 'report':
      return t(L, 'source.report')
    case 'task':
      return name ? t(L, 'source.taskNamed', { name }) : t(L, 'source.task')
    case 'teammate':
      return name ? t(L, 'source.teammateNamed', { name }) : t(L, 'source.teammate')
    case 'peer':
      return t(L, 'source.peer')
    case 'event':
      return t(L, 'source.event')
    case 'command':
      return name ? t(L, 'source.commandNamed', { name }) : t(L, 'source.command')
    case 'compaction':
      return t(L, 'source.compaction')
    case 'plugin':
      return name ? t(L, 'source.pluginNamed', { name }) : t(L, 'source.plugin')
    case 'system':
      return t(L, 'source.system')
  }
}

/** The last 20 turns as table rows, newest first. */
export function historyRows(r: Readings, width = 100): { head?: Line; rows: HistoryRow[] } {
  const L = r.ctx.locale
  const rows = r.c.history.slice(-20).reverse()
  if (rows.length === 0) return { rows: [{ n: 0, line: [muted(r.c.joinedLate ? t(L, 'pane.history.since', { time: clockText(r.c.startedAt) }) : t(L, 'pane.history.none'))] }] }
  // Each head over its column, aligned as the figures are: to the right, by display width.
  const head = HISTORY_COLUMNS.map(([key, w]) => padStart(t(L, key), w)).join(' ')
  return {
    head: [muted(head)],
    rows: rows.map((h): HistoryRow => {
      const tone: Tone | undefined = h.runaway ? 'warn' : h.aborted ? 'muted' : undefined
      const cells = [
        String(h.n).padStart(3),
        clockText(h.startedAt).padStart(6),
        formatDuration(turnLength(h)).padStart(8),
        formatTokens(h.tokens).padStart(8),
        formatUsd(h.costUsd).padStart(7),
        String(h.tools).padStart(6),
        String(h.edits).padStart(6),
      ]
      const row = cells.join(' ')
      // The prompt's words take what the pane has left, and none when that is too little to read;
      // a turn no person typed says what started it, never its markup.
      const room = Math.min(40, width - displayWidth(row) - 2)
      const words = h.prompt ? fit(h.prompt, room) : h.source ? sourceText(h.source, L, room) : undefined
      const line: Line = [{ text: row, ...(tone ? { tone } : {}) }, ...(words && room >= 8 ? [muted(`  ${words}`)] : [])]
      return { n: h.n, line, ...(h.firstTool ? { target: h.firstTool } : {}) }
    }),
  }
}

/** The longest run of the check history strip. */
const STRIP_RUNS = 24

/**
 * Every finished check as one square, newest on the right: ■ green for a
 * pass, ■ red for a failure, □ for a run that was stopped or whose result
 * was cut away. Nothing else is coloured.
 */
export function historyStrip(c: Readings['c']): Line {
  const runs = c.checks.filter(ch => ch.status === 'pass' || ch.status === 'fail' || ch.status === 'interrupted' || ch.status === 'hidden').slice(-STRIP_RUNS)
  return runs.map((ch): Span => (ch.status === 'interrupted' || ch.status === 'hidden' ? muted('□') : { text: '■', tone: ch.status === 'pass' ? 'ok' : 'bad' }))
}

// ------------------------------------------------------------------ the compact cells

/**
 * A compact cell, for a pane too short for the instruments: a title that is
 * its press, a gauge beside two lines; what an older build drew in its grid.
 */
export type Cell = { id: InstrumentId; title: string; graphic?: Graphic; lines: [Line, Line]; level: Level }

const fitTo = (line: Line, width: number): Line => fitLine(line, Math.max(1, width))

/**
 * Items joined with ` · ` over at most `max` lines of `width` columns, each
 * whole where it fits a line, the ones left over counted as `+N` at the end.
 */
export function packed(items: readonly string[], width: number, max: number): string[] {
  const lines: string[][] = [[]]
  const widthOf = (parts: readonly string[]) => displayWidth(parts.join(' · '))
  let i = 0
  for (; i < items.length; i++) {
    const item = fit(items[i] ?? '', width)
    const current = lines.at(-1) as string[]
    if (current.length === 0 || widthOf([...current, item]) <= width) current.push(item)
    else if (lines.length < max) lines.push([item])
    else break
  }
  let left = items.length - i
  const last = lines.at(-1) as string[]
  // The count of those left takes the last line's end, an item giving way to it where it must.
  while (left > 0 && last.length > 1 && widthOf(last) + ` +${left}`.length > width) {
    last.pop()
    left++
  }
  return lines.filter(parts => parts.length > 0).map(parts => parts.join(' · ') + (parts === last && left > 0 && widthOf(parts) + ` +${left}`.length <= width ? ` +${left}` : ''))
}

/** The tile a compact cell shows: the dials' own tiles. */
const TILE_OF: Readonly<Record<InstrumentId, TileId>> = { pace: 'pace', five: 'limits', context: 'context', cost: 'cost', checks: 'checks', files: 'files', health: 'health', session: 'session', agents: 'agents' }

/** A compact cell `width` columns wide. */
export function cellOf(r: Readings, id: InstrumentId, width: number): Cell {
  const { c, ctx } = r
  const L = ctx.locale
  const title = instrumentName(id, L)
  const textW = (chrome: number) => Math.max(8, width - chrome)
  switch (id) {
    case 'context': {
      const face = contextFace(r)
      const fill = contextNow(c)
      const tone = toneOf(face.level)
      const w = textW((face.graphic?.cols ?? 0) + 1)
      const line1: Line = [{ text: formatPercent(fill.pct), bold: true, ...(tone ? { tone } : {}) }]
      if (fill.tokens !== undefined && fill.window) line1.push(muted(` · ${t(L, 'ctx.of', { tokens: formatTokens(fill.tokens), window: formatTokens(fill.window) })}`))
      const left = { left: formatTokens(Math.max(0, fill.autoCompact !== undefined && fill.tokens !== undefined ? fill.autoCompact - fill.tokens : 0)) }
      const line2: Line =
        fill.autoCompact !== undefined && fill.tokens !== undefined
          ? [muted(displayWidth(t(L, 'cell.toCompact', left)) <= w ? t(L, 'cell.toCompact', left) : t(L, 'ctx.toCompact', left))]
          : c.autoCompact && !c.autoCompact.isOn
            ? [muted(t(L, 'ctx.compactOff'))]
            : fill.pct === undefined
              ? [muted(t(L, 'cell.noReading'))]
              : []
      // The compactions where they fit beside it; the detail lists them.
      const compacted = muted(` · ${t(L, 'ctx.compactions', { n: c.compactions })}`)
      if (c.compactions > 0 && lineWidth([...line2, compacted]) <= w) line2.push(compacted)
      return { id, title, ...(face.graphic ? { graphic: face.graphic } : {}), lines: [fitTo(line1, w), fitTo(line2, w)], level: face.level }
    }
    case 'checks': {
      const face = checksFace(r)
      const check = shownCheck(c)
      if (!check) return { id, title, lines: [[muted('—')], [muted(t(L, 'checks.none'))]], level: 'none' }
      const strip = historyStrip(c).slice(-Math.max(4, Math.min(12, width - 18)))
      // A check in the background: its time so far and its command's usual length, where the cell has room.
      const background = backgroundCheckText(r, check, width - 2)
      const line1: Line = background ? [{ text: `◌ ${background}`, bold: true }] : face.lines[0]
      const line2: Line = background ? [...strip, muted(`  ${plain(face.lines[1])}`)] : [...strip, muted(`  ${kindsText(check, L)} · ${checkWhen(r, check)}`)]
      return { id, title, lines: [fitTo(line1, width), fitTo(line2, width)], level: face.level }
    }
    case 'cost': {
      const face = costFace(r)
      const values = c.history.slice(-12).map(h => h.tokens)
      const line2: Line = values.length > 0 ? [{ text: sparkline(values) }, muted(` ${t(L, 'cost.spark')}`)] : c.turn ? [] : [muted(t(L, 'pane.history.none'))]
      return { id, title, lines: [fitTo(face.lines[0], width), fitTo(line2, width)], level: face.level }
    }
    case 'files': {
      const face = tileFace(r, 'files')
      if (c.files.length === 0) return { id, title, lines: [[muted('—')], [muted(t(L, 'files.none'))]], level: 'none' }
      // The files edited most, each name whole where it fits, the rest counted.
      const files = [...c.files].sort((a, b) => b.edits - a.edits || b.lastAt - a.lastAt)
      const [first = ''] = packed(files.map(f => `${baseName(f.path)} ×${f.edits}`), width, 1)
      return { id, title, lines: [fitTo(face.lines[0], width), [muted(first)]], level: 'none' }
    }
    case 'health': {
      const h = r.health
      const tone = toneOf(h.level)
      const line1: Line = h.isMeasuring ? [{ text: `${h.score} ${wordText(h.word, L)}`, bold: true, ...(tone ? { tone } : {}) }] : [muted('—')]
      return { id, title, lines: [fitTo(line1, width), [muted(fit(weakestHint(h, L), width))]], level: h.level }
    }
    case 'pace':
    case 'five': {
      // The dials' compact faces: the band's own, its one-row tachometer and its limits without their meters.
      const face = compactFace(r, TILE_OF[id])
      return { id, title, lines: [fitTo(face.lines[0], width), fitTo(face.lines[1], width)], level: face.level }
    }
    default: {
      const face = tileFace(r, TILE_OF[id])
      const w = textW(face.graphic ? face.graphic.cols + 1 : 0)
      return { id, title, ...(face.graphic ? { graphic: face.graphic } : {}), lines: [fitTo(face.lines[0], w), fitTo(face.lines[1], w)], level: face.level }
    }
  }
}

// ------------------------------------------------------------------ the overview, sized

/** How the overview draws its instruments: full, small, compact cells, or a line each. */
export type OverviewForm = InstrumentSize | 'compact' | 'lines'

/** The overview's plan for a pane: progress whole or as a line, the instruments' form, how many across, whether the bar has its rule. */
export type OverviewPlan = { top: 'full' | 'line'; form: OverviewForm; across: 1 | 2; cellWidth: number; rule: boolean; gap: boolean }

/** The gutter between two cells side by side: a space, a thin rule, a space. */
export const GUTTER = 3

/** The fewest rows a pane gives before the view bar drops its rule (an inline pane's twelve). */
const RULE_FROM_ROWS = 20

/** The narrowest compact cell, and the narrowest line two of them share. */
const COMPACT_MIN_WIDTH = 24
const LINES_TWO_FROM = 70

function across(form: OverviewForm, width: number): 1 | 2 {
  const twoW = Math.floor((width - GUTTER) / 2)
  if (form === 'full' || form === 'small') return 2
  if (form === 'compact') return twoW >= COMPACT_MIN_WIDTH ? 2 : 1
  return width >= LINES_TWO_FROM ? 2 : 1
}

/** Rows the instruments take in a form: a title and its rows each, a rule between the rows of cells; a line each, no rules. */
export function instrumentRows(form: OverviewForm, count: number, n: 1 | 2): number {
  const rows = Math.ceil(count / n)
  if (form === 'lines') return rows
  const each = form === 'compact' ? 3 : 1 + INSTRUMENT_ROWS[form]
  return rows * each + Math.max(0, rows - 1)
}

/**
 * The overview's plan for `width` columns and `paneRows` rows: the largest
 * form that fits, progress kept whole before the instruments stay large
 * (it is what a person opening the pane mid-task wants first). Full
 * instruments need two cells of 33 columns, small ones two of 26; past
 * that, compact cells, then a line each. Where nothing fits, the smallest,
 * and the body scrolls under the pinned bar.
 */
export function overviewPlan(r: Readings, width: number, paneRows: number): OverviewPlan {
  const count = instrumentIds(r).length
  const top = topSection(r, width)
  const topRows = (top.head.length > 0 ? 1 : 0) + (top.pond ? 2 : 0) + top.under.length
  const cautions = cautionsOf(r.c, r.ctx.now).length > 0 ? 1 : 0
  const rule = paneRows >= RULE_FROM_ROWS
  const head = 1 + (rule ? 1 : 0)
  const foot = 1
  const twoW = Math.floor((width - GUTTER) / 2)
  const isWide = (form: OverviewForm) => (form === 'full' || form === 'small' ? twoW >= INSTRUMENT_MIN_WIDTH[form] : true)
  // The instruments stay instruments as long as they can, progress giving way to a line first; then compact cells, then a line each.
  const order: { top: 'full' | 'line'; form: OverviewForm }[] = [
    { top: 'full' as const, form: 'full' as const },
    { top: 'full' as const, form: 'small' as const },
    { top: 'line' as const, form: 'full' as const },
    { top: 'line' as const, form: 'small' as const },
    { top: 'full' as const, form: 'compact' as const },
    { top: 'line' as const, form: 'compact' as const },
    { top: 'full' as const, form: 'lines' as const },
    { top: 'line' as const, form: 'lines' as const },
  ].filter(c => isWide(c.form))
  const total = (c: { top: 'full' | 'line'; form: OverviewForm }, gap: boolean) => head + foot + (c.top === 'full' ? topRows : 1) + (gap ? 1 : 0) + instrumentRows(c.form, count, across(c.form, width)) + cautions
  for (const c of order) {
    const n = across(c.form, width)
    const cellWidth = n === 2 ? twoW : width
    if (total(c, true) <= paneRows) return { ...c, across: n, cellWidth, rule, gap: true }
    if (total(c, false) <= paneRows) return { ...c, across: n, cellWidth, rule, gap: false }
  }
  const last = order.at(-1) ?? { top: 'line', form: 'lines' }
  const n = across(last.form, width)
  return { ...last, across: n, cellWidth: n === 2 ? twoW : width, rule, gap: false }
}

// ------------------------------------------------------------------ the parts of a body

/** One instrument as a line: its press's name and its reading. */
export type ReadingItem = { id: InstrumentId; detail: DetailId; name: string; reading: Line }

export type BodyPart =
  | { kind: 'top'; top: TopSection }
  | { kind: 'summary'; summary: Summary }
  | { kind: 'blank' }
  | { kind: 'instruments'; size: InstrumentSize; across: 1 | 2; cellWidth: number; rows: Instrument[][] }
  | { kind: 'cells'; across: 1 | 2; cellWidth: number; rows: Cell[][] }
  | { kind: 'readings'; across: 1 | 2; cellWidth: number; nameWidth: number; items: ReadingItem[]; open?: DetailId }
  | { kind: 'cautions'; line: Line }
  | { kind: 'lines'; lines: Line[] }
  /** The press that leaves a detail (`b`), with the detail's name and headline beside it. */
  | { kind: 'back'; label: string; name: string; title: Line }
  /** An open detail beside the list of instruments. */
  | { kind: 'beside'; left: BodyPart[]; right: BodyPart[]; leftWidth: number }
  | { kind: 'turns'; rows: HistoryRow[] }
  | { kind: 'presses'; rows: Press[][] }

/** A press of the band's layout or the handover's, laid out in rows by its width. */
export type Press = { key: string; label: string; width: number; kind: 'remove' | 'add' | 'reset' | 'write' | 'copy'; tile?: TileId; isPrimary?: boolean }

/** How many rows a part draws. */
export function partRows(p: BodyPart): number {
  switch (p.kind) {
    case 'top':
      return (p.top.head.length > 0 ? 1 : 0) + (p.top.pond ? 2 : 0) + p.top.under.length
    case 'summary':
    case 'blank':
    case 'cautions':
    case 'back':
      return 1
    case 'instruments':
      return p.rows.length * (1 + INSTRUMENT_ROWS[p.size]) + Math.max(0, p.rows.length - 1)
    case 'cells':
      return p.rows.length * 3 + Math.max(0, p.rows.length - 1)
    case 'readings':
      return Math.ceil(p.items.length / p.across)
    case 'lines':
      return p.lines.length
    case 'beside':
      return Math.max(sumRows(p.left), sumRows(p.right))
    case 'turns':
      return p.rows.length
    case 'presses':
      return p.rows.length
  }
}

export function sumRows(parts: readonly BodyPart[]): number {
  return parts.reduce((sum, p) => sum + partRows(p), 0)
}

/** The presses a part draws, each with the row it stands on within the part and its height. */
export function partKeys(p: BodyPart): { key: string; at: number; height: number }[] {
  switch (p.kind) {
    case 'instruments':
      return p.rows.flatMap((row, i) => row.map(cell => ({ key: `cell-${cell.detail}`, at: i * (2 + INSTRUMENT_ROWS[p.size]), height: 1 })))
    case 'cells':
      return p.rows.flatMap((row, i) => row.map(cell => ({ key: `cell-${DETAIL_OF[cell.id]}`, at: i * 4, height: 1 })))
    case 'readings':
      return p.items.map((item, k) => ({ key: `cell-${item.detail}`, at: Math.floor(k / p.across), height: 1 }))
    case 'back':
      return [{ key: 'pane-back', at: 0, height: 1 }]
    case 'beside': {
      const keys = (parts: readonly BodyPart[]) => {
        let at = 0
        return parts.flatMap(part => {
          const out = partKeys(part).map(k => ({ ...k, at: k.at + at }))
          at += partRows(part)
          return out
        })
      }
      return [...keys(p.left), ...keys(p.right)]
    }
    case 'turns':
      return p.rows.flatMap((row, i) => (row.target ? [{ key: `pane-turn-${row.n}`, at: i, height: 1 }] : []))
    case 'presses':
      return p.rows.flatMap((row, i) => row.map(press => ({ key: press.key, at: i, height: 1 })))
    default:
      return []
  }
}

/** Every press of a body, with the row of the body it stands on. */
export function bodyKeys(parts: readonly BodyPart[]): Map<string, { at: number; height: number }> {
  const out = new Map<string, { at: number; height: number }>()
  let at = 0
  for (const p of parts) {
    for (const k of partKeys(p)) out.set(k.key, { at: at + k.at, height: k.height })
    at += partRows(p)
  }
  return out
}

/** Rows of `width` columns, cells `across` to a row. */
function inRows<T>(items: readonly T[], n: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += n) rows.push(items.slice(i, i + n))
  return rows
}

/** The instruments as one line each, `across` to a row, names in a column. */
export function readingsPart(r: Readings, width: number, n: 1 | 2, open?: DetailId): Extract<BodyPart, { kind: 'readings' }> {
  const ids = instrumentIds(r)
  const cellWidth = n === 2 ? Math.floor((width - GUTTER) / 2) : width
  const nameWidth = nameColumn(r, ids)
  const items = ids.map((id): ReadingItem => ({ id, detail: instrumentOf(r, id, cellWidth, 'small').detail, name: shortName(id, r.ctx.locale), reading: fitLine(instrumentReading(r, id), Math.max(4, cellWidth - nameWidth - 2)) }))
  return { kind: 'readings', across: n, cellWidth, nameWidth, items, ...(open ? { open } : {}) }
}

/** The overview's body as its plan has it: progress, the instruments, the cautions. */
export function overviewBody(r: Readings, width: number, plan: OverviewPlan): BodyPart[] {
  const parts: BodyPart[] = []
  parts.push(plan.top === 'full' ? { kind: 'top', top: topSection(r, width) } : { kind: 'summary', summary: summaryLine(r, width) })
  if (plan.gap) parts.push({ kind: 'blank' })
  const ids = instrumentIds(r)
  if (plan.form === 'full' || plan.form === 'small') {
    const size = plan.form
    const widths = (j: number) => (plan.across === 2 ? (j === 0 ? plan.cellWidth : width - plan.cellWidth - GUTTER) : width)
    const rows = inRows(ids, plan.across).map(row => row.map((id, j) => instrumentOf(r, id, widths(j), size)))
    parts.push({ kind: 'instruments', size, across: plan.across, cellWidth: plan.cellWidth, rows })
  } else if (plan.form === 'compact') {
    parts.push({ kind: 'cells', across: plan.across, cellWidth: plan.cellWidth, rows: inRows(ids.map(id => cellOf(r, id, plan.cellWidth)), plan.across) })
  } else {
    parts.push(readingsPart(r, width, plan.across))
  }
  const cautions = cautionsLine(r, width)
  if (cautions) parts.push({ kind: 'cautions', line: cautions })
  return parts
}

/** Where an open detail goes beside the list of instruments: from 90 columns, which leaves it 56. */
export const BESIDE_FROM = 90
/** The list beside an open detail. */
const BESIDE_LIST = 31

/**
 * An open detail: in the overview's place, under its back press, or beside
 * the list of instruments where the pane is wide, the open one marked.
 */
export function drillBody(r: Readings, width: number, open: { name: string; detail: Detail }, back: string, besideDetail?: (w: number) => { name: string; detail: Detail }): BodyPart[] {
  const head = (d: { name: string; detail: Detail }): BodyPart => ({ kind: 'back', label: back, name: d.name, title: d.detail.title })
  if (width >= BESIDE_FROM && besideDetail) {
    const rightW = width - BESIDE_LIST - GUTTER
    const d = besideDetail(rightW)
    const left: BodyPart[] = [{ kind: 'back', label: back, name: '', title: [] }, readingsPart(r, BESIDE_LIST, 1, d.detail.id)]
    const right: BodyPart[] = [{ kind: 'lines', lines: [fitLine([{ text: '▾ ', tone: 'accent' }, { text: d.name, bold: true, tone: 'accent' }, { text: '  ' }, ...d.detail.title], rightW)] }, { kind: 'lines', lines: d.detail.lines }]
    return [{ kind: 'beside', left, right, leftWidth: BESIDE_LIST }]
  }
  return [head(open), { kind: 'lines', lines: open.detail.lines }]
}

// ------------------------------------------------------------------ the other views

/** The timeline's lines: TIME and CACHE, then the tasks, waits, agents and jobs on one axis. */
export function timelineBody(time: TimeBlocks, empty?: string): BodyPart[] {
  const lines = [...time.head, ...(time.axis ? [time.axis] : []), ...time.rows, ...(empty ? [[muted(empty)]] : [])]
  return [{ kind: 'lines', lines }]
}

/** The turns: the mission over them, the AI ETA's tally, then the last 20 turns, each with a tool call a press. */
export function turnsBody(r: Readings, width: number, ai: Line[]): BodyPart[] {
  const L = r.ctx.locale
  const c = r.c
  const history = historyRows(r, width)
  const title = c.history.length === 0 ? t(L, 'pane.history.zero') : c.history.length === 1 ? t(L, 'pane.history.one') : t(L, 'pane.history', { n: Math.min(20, c.history.length) })
  const parts: BodyPart[] = [{ kind: 'lines', lines: missionLines(r, width) }, { kind: 'blank' }]
  if (ai.length > 0) parts.push({ kind: 'lines', lines: ai }, { kind: 'blank' })
  parts.push({ kind: 'lines', lines: [[{ text: title, bold: true, tone: 'muted' }], ...(history.head ? [history.head] : [])] })
  parts.push({ kind: 'turns', rows: history.rows })
  return parts
}

/** Presses laid out left to right in rows of `width`, a column between them. */
function layOut(presses: readonly Press[], width: number): Press[][] {
  const rows: Press[][] = [[]]
  let used = 0
  for (const press of presses) {
    const row = rows.at(-1) as Press[]
    if (row.length > 0 && used + 1 + press.width > width) {
      rows.push([press])
      used = press.width
    } else {
      row.push(press)
      used += (row.length > 1 ? 1 : 0) + press.width
    }
  }
  return rows.filter(row => row.length > 0)
}

/** The band's layout: its help, each tile in the band a press that removes it, each other one a press that adds it, and reset. */
export function bandBody(L: Locale, width: number, inBand: readonly TileId[], notInBand: readonly TileId[], isDefault: boolean): BodyPart[] {
  const presses: Press[] = [
    ...inBand.map((id, i): Press => {
      const label = `${i + 1}.${id} ×`
      return { key: `pane-rm-${id}`, label, width: displayWidth(label), kind: 'remove', tile: id }
    }),
    ...notInBand.map((id): Press => ({ key: `pane-add-${id}`, label: `+ ${id}`, width: displayWidth(`+ ${id}`), kind: 'add', tile: id })),
    ...(isDefault ? [] : [{ key: 'pane-reset', label: t(L, 'pane.reset'), width: displayWidth(t(L, 'pane.reset')) + 4, kind: 'reset' as const }]),
  ]
  return [{ kind: 'lines', lines: wrapLine([muted(t(L, 'pane.bandHelp'))], width, 3) }, { kind: 'presses', rows: layOut(presses, width) }]
}

/**
 * The handover: write and copy, whether and when it was written, then its
 * text as lines: headings bold, quotes and lists set in, code as it is.
 */
export function handoverBody(L: Locale, width: number, status: Line, text: string): BodyPart[] {
  const write = t(L, 'pane.write')
  const copy = t(L, 'pane.copy')
  const presses: Press[] = [
    { key: 'pane-write', label: write, width: displayWidth(write) + 4, kind: 'write', isPrimary: true },
    { key: 'pane-copy', label: copy, width: displayWidth(copy) + 4, kind: 'copy' },
  ]
  const room = width - presses.reduce((sum, p) => sum + p.width + 1, 0)
  return [{ kind: 'presses', rows: [presses] }, { kind: 'lines', lines: [fitLine(status, Math.max(8, room > 12 ? width : width))] }, { kind: 'blank' }, { kind: 'lines', lines: markdownLines(text, width) }]
}

/** Markdown as lines `width` wide: `#` headings bold, `>` quotes and `-` items set in, ``` code as it is, backticks and underscores dropped. */
export function markdownLines(text: string, width: number): Line[] {
  const out: Line[] = []
  let isCode = false
  const clean = (s: string) => s.replace(/`([^`]*)`/g, '$1').replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')
  for (const raw of text.split('\n')) {
    if (/^(```|~~~)/.test(raw)) {
      isCode = !isCode
      continue
    }
    if (isCode) {
      out.push(fitLine([muted(`  ${raw}`)], width))
      continue
    }
    if (raw.trim() === '') {
      if (out.length > 0 && plain(out.at(-1) ?? []).trim() !== '') out.push([])
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (heading) {
      out.push(fitLine([{ text: clean(heading[2] ?? ''), bold: true, ...(heading[1] === '#' ? {} : { tone: 'muted' as const }) }], width))
      continue
    }
    const quote = /^>\s?(.*)$/.exec(raw)
    if (quote) {
      for (const line of wrapLine([{ text: clean(quote[1] ?? '') }], Math.max(8, width - 2), 6)) out.push([muted('│ '), ...line])
      continue
    }
    const item = /^(\s*)- (\[[ x]\] )?(.*)$/.exec(raw)
    if (item) {
      const box = item[2]
      const mark: Span = box === '[x] ' ? { text: '✓ ', tone: 'ok' } : box === '[ ] ' ? muted('· ') : muted('• ')
      const lines = wrapLine([{ text: clean(item[3] ?? ''), ...(box === '[x] ' ? { tone: 'muted' as const } : {}) }], Math.max(8, width - 2), 4)
      lines.forEach((line, i) => out.push([i === 0 ? mark : { text: '  ' }, ...line]))
      continue
    }
    for (const line of wrapLine([{ text: clean(raw) }], width, 6)) out.push(line)
  }
  while (out.length > 0 && plain(out.at(-1) ?? []).trim() === '') out.pop()
  return out
}

/** The guide: each part's name in a column, its words wrapped beside it; a name too long for the column stands on a line of its own. */
export function guideBody(rows: readonly GuideRow[], width: number): BodyPart[] {
  const nameW = Math.max(8, Math.min(12, Math.floor(width / 5)))
  const lines: Line[] = []
  for (const row of rows) {
    const wrapped = wrapLine([{ text: row.text }], Math.max(12, width - nameW), 14)
    const isLong = displayWidth(row.name) > nameW - 1
    if (isLong) lines.push([{ text: fit(row.name, width), bold: true, tone: 'muted' }])
    wrapped.forEach((line, i) => lines.push([i === 0 && !isLong ? { text: pad(row.name, nameW), bold: true, tone: 'muted' } : { text: ' '.repeat(nameW) }, ...line]))
  }
  return [{ kind: 'lines', lines }]
}

// ------------------------------------------------------------------ the whole pane

/** The pane, ready to draw: its header, its body and the line at its foot, and the window the body scrolls in. */
export type PaneModel = {
  width: number
  view: PaneView
  bar: ViewBar
  /** The view bar's rule under it: dropped in a pane of few rows (an inline one). */
  rule: boolean
  /** Outside the overview, and in a drill-down: the progress in one line, pinned under the bar. */
  summary?: Summary
  body: BodyPart[]
  hint: Line
}

/** Rows the header takes: the bar, its rule, the summary. */
export function headRows(m: Pick<PaneModel, 'rule' | 'summary'>): number {
  return 1 + (m.rule ? 1 : 0) + (m.summary ? 1 : 0)
}

/** What a pane is built from besides the readings: its size, the view, and the open view's own parts. */
export type PaneInput = {
  width: number
  rows: number
  view: PaneView
  isFocused: boolean
  /** The open view's body, built by the caller (it alone holds the timeline's clock, the handover's text...). */
  body: (plan: OverviewPlan) => BodyPart[]
}

/** The pane's model: the bar (the full names where they fit), the summary outside the overview, the body, the hint. */
export function paneModel(r: Readings, input: PaneInput): PaneModel {
  const L = r.ctx.locale
  const { width, rows, view } = input
  const plan = overviewPlan(r, width, rows)
  const isDrilled = view.view === 'overview' && view.detail !== undefined
  const rule = view.view === 'overview' && !isDrilled ? plan.rule : rows >= RULE_FROM_ROWS
  const summary = view.view !== 'overview' || isDrilled ? summaryLine(r, width) : undefined
  const body = input.body(plan)
  const head = 1 + (rule ? 1 : 0) + (summary ? 1 : 0)
  const canScroll = sumRows(body) > Math.max(1, rows - head - 1)
  return { width, view, bar: viewBar(L, view.view, width), rule, ...(summary ? { summary } : {}), body, hint: hintLine(L, { view: view.view, isDrilled, isFocused: input.isFocused, canScroll }, width) }
}

export { barWidth }
