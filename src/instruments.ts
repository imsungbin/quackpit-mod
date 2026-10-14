// The pane's instruments: every grid cell an instrument of one size, as in a
// cockpit's six-pack. Each has a title row, which is its press, then a graphic
// with its words beside it: the pace dial, the five-hour fuel gauge, the cost
// of each turn, the checks by kind, the edits per file, health's score; the
// context is one bar across its cell of what fills it, source by source; the
// session and the subagents have no honest graphic and are words at the same
// height. Two sizes: full
// (a graphic 4 rows tall, 15 columns for a dial) where two cells of 33
// columns fit across, small (3 rows, 11 columns) in a narrower pane. A
// one-line form serves the inline pane and the list beside an open detail.
// Host-neutral; the adapter draws them. Pure.

import { checkMatrix, costChart, fileBars } from './charts'
import { barLine, barParts, SOURCE_COLORS, sourceTokens, type BarPart } from './context'
import { DIAL_MAX_RATIO, fuelGauge, liveTurnUsd, PACE_BAD_RATIO, PACE_WARN_RATIO, sevenDayForecast, type Level } from './derive'
import type { DetailId } from './details'
import { DIAL_COLUMNS, DIAL_ROWS, SMALL_DIAL_COLUMNS, SMALL_DIAL_ROWS, type DialSpec } from './dial'
import { clockText, formatAge, formatCountdown, formatMinutes, formatPercent, formatTokens, formatUsd, formatLeft } from './format'
import { weakestHint, wordText } from './health'
import { t, type Key, type Locale, type Params } from './i18n'
import { hitRatio, median, MINUTE } from './metrics'
import { contextNow, contextShare, turnWorkSoFar, unverified } from './model'
import { displayWidth, fit, fitLine, lineWidth, type Line, type Span, type Tone } from './text'
import { backgroundCheckText, checksFace, checkWhen, kindsText, modelOf, shownCheck, type Readings } from './tiles'

export const INSTRUMENT_IDS = ['pace', 'five', 'context', 'cost', 'checks', 'files', 'health', 'session', 'agents'] as const
export type InstrumentId = (typeof INSTRUMENT_IDS)[number]

/** What a press on an instrument opens. */
export const DETAIL_OF: Readonly<Record<InstrumentId, DetailId>> = {
  pace: 'pace',
  five: 'limits',
  context: 'context',
  cost: 'cost',
  checks: 'checks',
  files: 'files',
  health: 'health',
  session: 'session',
  agents: 'agents',
}

/** The instrument a detail belongs to. */
export function instrumentOfDetail(id: DetailId): InstrumentId {
  return id === 'limits' ? 'five' : id
}

/**
 * The instruments in the overview, read in pairs across: how fast and how
 * much of the plan is left; what the session holds and what it costs; what
 * was checked and what was edited; how the work is going and what it runs
 * on; then the subagents, once one has run (none running is no reading).
 */
export function instrumentIds(r: Readings): InstrumentId[] {
  return INSTRUMENT_IDS.filter(id => id !== 'agents' || r.c.agents.length > 0)
}

export type InstrumentSize = 'full' | 'small'

/** Rows under an instrument's title: its graphic's height, and its lines of words beside it. */
export const INSTRUMENT_ROWS: Readonly<Record<InstrumentSize, number>> = { full: DIAL_ROWS, small: SMALL_DIAL_ROWS }
/** The narrowest cell an instrument of each size keeps its words in. */
export const INSTRUMENT_MIN_WIDTH: Readonly<Record<InstrumentSize, number>> = { full: 33, small: 26 }

export type InstrumentGraphic =
  | { kind: 'dial'; spec: DialSpec; columns: number; rows: number }
  | { kind: 'chart'; lines: Line[]; columns: number; rows: number }

export type Instrument = {
  id: InstrumentId
  detail: DetailId
  /** Its name and, where it fits, what it covers: `PACE · this session`. */
  title: Line
  graphic?: InstrumentGraphic
  /** The words beside the graphic (the whole cell's, where it has none), a line a row. */
  words: Line[]
  /**
   * A bar across the cell at one of its rows (the context's): its parts, for
   * a surface that draws pictures; `words` holds the same bar as text.
   */
  bar?: { row: number; parts: BarPart[] }
  level: Level
}

const muted = (text: string): Span => ({ text, tone: 'muted' })
const toneOf = (level: Level): Tone | undefined => (level === 'bad' ? 'bad' : level === 'warn' ? 'warn' : level === 'ok' ? 'ok' : undefined)
const strong = (text: string, tone?: Tone): Line => [{ text, bold: true, ...(tone ? { tone } : {}) }]

/** The first of the forms of a sentence that fits `room` columns, else the last. */
function firstFit(L: Locale, keys: readonly Key[], room: number, params: Params = {}): string {
  const forms = keys.map(key => t(L, key, params))
  return forms.find(text => displayWidth(text) <= room) ?? forms.at(-1) ?? ''
}

/** An instrument's name: the tile's, the five-hour window's own. */
export function instrumentName(id: InstrumentId, L: Locale): string {
  return id === 'pace' ? t(L, 'dial.paceTitle') : id === 'five' ? t(L, 'dial.fiveTitle') : t(L, `tile.${id}`)
}

/** What an instrument covers, said after its name where it fits: the dials' scope, the files' count. */
function titleWhat(r: Readings, id: InstrumentId): string | undefined {
  const L = r.ctx.locale
  if (id === 'pace') return t(L, 'dial.paceWhat')
  if (id === 'five') return t(L, 'dial.fiveWhat')
  if (id === 'files' && r.c.files.length > 0) {
    const edits = r.c.files.reduce((sum, f) => sum + f.edits, 0)
    return t(L, 'files.count', { files: t(L, r.c.files.length === 1 ? 'unit.file' : 'unit.files', { n: r.c.files.length }), edits: t(L, edits === 1 ? 'unit.edit' : 'unit.edits', { n: edits }) })
  }
  return undefined
}

/** The title row: the name bold, then what it covers where the cell has room. */
export function instrumentTitle(r: Readings, id: InstrumentId, width: number): Line {
  const name: Span = { text: instrumentName(id, r.ctx.locale), bold: true, tone: 'muted' }
  const what = titleWhat(r, id)
  const long: Line = what ? [name, muted(` · ${what}`)] : [name]
  // The mark (▸ or ▾) and its space come before it: two columns.
  return lineWidth(long) + 2 <= width ? long : [name]
}

/** The pace dial: now against your usual, the bug at usual, amber from 1.5×, red from 1.8×. */
function paceSpec(r: Readings): DialSpec {
  const p = r.pace
  return { ...(p.needle !== undefined ? { needle: p.needle } : {}), isGrey: !p.hasData || p.needle === undefined, bug: 0.5, warnFrom: PACE_WARN_RATIO / DIAL_MAX_RATIO, badFrom: PACE_BAD_RATIO / DIAL_MAX_RATIO }
}

/** The fuel gauge: the needle the percent used, the sweep to where the trend ends at the reset. */
function fiveSpec(r: Readings): DialSpec {
  const g = fuelGauge(r.c, r.ctx.now)
  return {
    ...(g && !g.isReset ? { needle: Math.min(1, g.pct / 100) } : {}),
    ...(g?.atReset !== undefined && !g.isReset ? { sweep: Math.min(1, g.atReset / 100) } : {}),
    isGrey: !g || g.isStale || g.isReset,
    warnFrom: FIVE_WARN_PCT / 100,
    badFrom: FIVE_BAD_PCT / 100,
  }
}

/** The fuel gauge's zones: amber from 80% used, red from 90% (the duck's caution, and the notification's). */
export const FIVE_WARN_PCT = 80
export const FIVE_BAD_PCT = 90

/** Health's score on 0 to 100: its zones would cover most of the arc, so the needle takes amber under 70 and red under 50. */
function healthSpec(r: Readings): DialSpec {
  const h = r.health
  return { ...(h.isMeasuring ? { needle: h.score / 100 } : {}), isGrey: !h.isMeasuring, warnFrom: 1, badFrom: 1, noZones: true, ...(h.level === 'bad' || h.level === 'warn' ? { needleLevel: h.level } : {}) }
}

function dial(spec: DialSpec, size: InstrumentSize): InstrumentGraphic {
  return size === 'full' ? { kind: 'dial', spec, columns: DIAL_COLUMNS, rows: DIAL_ROWS } : { kind: 'dial', spec, columns: SMALL_DIAL_COLUMNS, rows: SMALL_DIAL_ROWS }
}

function chart(lines: Line[], size: InstrumentSize): InstrumentGraphic | undefined {
  if (lines.length === 0) return undefined
  const columns = size === 'full' ? DIAL_COLUMNS : SMALL_DIAL_COLUMNS
  return { kind: 'chart', lines, columns, rows: INSTRUMENT_ROWS[size] }
}

/** An instrument `width` columns wide at `size`. */
export function instrumentOf(r: Readings, id: InstrumentId, width: number, size: InstrumentSize): Instrument {
  const rows = INSTRUMENT_ROWS[size]
  const gw = size === 'full' ? DIAL_COLUMNS : SMALL_DIAL_COLUMNS
  const base = { id, detail: DETAIL_OF[id], title: instrumentTitle(r, id, width) }
  const done = (graphic: InstrumentGraphic | undefined, words: (Line | undefined)[], level: Level): Instrument => {
    const room = Math.max(4, width - (graphic ? graphic.columns + 1 : 0))
    const kept = words.filter((line): line is Line => line !== undefined).slice(0, rows)
    return { ...base, ...(graphic ? { graphic } : {}), words: kept.map(line => fitLine(line, room)), level }
  }
  const room = Math.max(4, width - gw - 1)
  const L = r.ctx.locale
  switch (id) {
    case 'pace':
      return done(dial(paceSpec(r), size), paceWords(r, room, rows), r.pace.level)
    case 'five': {
      const g = fuelGauge(r.c, r.ctx.now)
      return done(dial(fiveSpec(r), size), fiveWords(r, room, rows), g?.level ?? 'none')
    }
    case 'context': {
      // What fills it, across the whole cell, once it has a reading and a split; else the words alone.
      const bar = contextBarOf(r, width)
      if (!bar) return done(undefined, contextWords(r, width, rows), contextLevelOf(r))
      const words = [contextHead(r, width), barLine(bar, width), contextLegend(r, width), rows > 3 ? contextFoot(r, width) : undefined]
      return { ...base, words: words.filter((line): line is Line => line !== undefined).map(line => fitLine(line, width)), bar: { row: 1, parts: bar }, level: contextLevelOf(r) }
    }
    case 'cost': {
      const c = costChart(r.c, gw, rows)
      const graphic = chart(c.lines, size)
      return done(graphic, costWords(r, c.unit, graphic ? room : width), r.c.history.at(-1)?.runaway && !r.c.turn ? 'warn' : 'none')
    }
    case 'checks': {
      const graphic = chart(checkMatrix(r.c, L, gw, rows), size)
      const check = shownCheck(r.c)
      return done(graphic, checksWords(r, graphic ? room : width), check?.status === 'fail' ? 'bad' : check?.status === 'pass' ? 'ok' : 'none')
    }
    case 'files': {
      // The bars and the names are one: the whole cell.
      const lines = fileBars(r.c, L, width, rows)
      return { ...base, words: lines.length > 0 ? lines.map(line => fitLine(line, width)) : [[muted('—')], [muted(t(L, 'files.none'))]], level: 'none' }
    }
    case 'health':
      return done(dial(healthSpec(r), size), healthWords(r, room), r.health.level)
    case 'session':
      return done(undefined, sessionWords(r, width), 'none')
    case 'agents':
      return done(undefined, agentsWords(r, width), 'none')
  }
}

function contextLevelOf(r: Readings): Level {
  const share = contextShare(contextNow(r.c))
  return share === undefined ? 'none' : share >= 90 ? 'bad' : share >= 70 ? 'warn' : 'none'
}

/** PACE: tokens an hour now, against your usual (or this session's average), idle or the usual, the cache's share. */
function paceWords(r: Readings, room: number, rows: number): (Line | undefined)[] {
  const L = r.ctx.locale
  const p = r.pace
  const tone = p.ratio !== undefined && p.ratio >= PACE_BAD_RATIO ? 'bad' : p.ratio !== undefined && p.ratio >= PACE_WARN_RATIO ? 'warn' : undefined
  const x = p.ratio?.toFixed(1)
  const ratio = x === undefined ? t(L, p.hasData ? 'dial.noUsual' : 'pace.warming') : p.usualBasis === 'session' ? firstFit(L, ['dial.sessionX', 'dial.sessionXShort'], room, { x }) : t(L, 'dial.usualX', { x })
  const usual = p.usual !== undefined ? t(L, p.usualBasis === 'session' ? 'dial.average' : 'dial.usual', { pace: t(L, 'pace.perHour', { tokens: formatTokens(p.usual) }) }) : undefined
  const hits = hitRatio(r.c.cache)
  const idle = p.idleMs !== undefined && p.idleMs >= MINUTE ? t(L, 'dial.idle', { time: formatMinutes(p.idleMs) }) : undefined
  const third = idle ?? usual
  return [
    strong(t(L, 'pace.perHour', { tokens: formatTokens(p.perHour) }), tone),
    [{ text: ratio, ...(tone && x !== undefined ? { tone } : { tone: 'muted' as const }) }],
    third ? [muted(third)] : undefined,
    rows > 3 && hits !== undefined ? [muted(t(L, 'dial.cache', { pct: formatPercent(100 * hits) }))] : undefined,
  ]
}

/**
 * 5H WINDOW: what is used; where the trend ends at the reset, or when it runs
 * out (amber) and how long before the reset; when it resets; then the
 * seven-day window where it runs out first, else how old the readings are.
 * Gone stale, the readings' age comes before the rest: the needle is grey.
 */
function fiveWords(r: Readings, room: number, rows: number): (Line | undefined)[] {
  const L = r.ctx.locale
  const now = r.ctx.now
  const g = fuelGauge(r.c, now)
  if (!g) return [[muted('—')], [muted(firstFit(L, ['limits.none', 'cell.noReading'], room))]]
  if (g.isReset) return [[muted(t(L, 'limits.reset'))], [muted(firstFit(L, ['dial.resetNext', 'dial.resetNextShort'], room))]]
  const tone = toneOf(g.level)
  const warn = tone ?? 'warn'
  const age = formatAge(now - g.asOf, L)
  const read: Line = [muted(displayWidth(t(L, 'dial.read', { age })) <= room ? t(L, 'dial.read', { age }) : age)]
  const outcome: Line =
    g.isUsedUp && g.resetsAt !== undefined
      ? [{ text: t(L, 'dial.usedUp', { time: clockText(g.resetsAt) }), tone: 'bad' }]
      : g.emptiesAt !== undefined
        ? [{ text: t(L, 'dial.runsOut', { time: clockText(g.emptiesAt) }), tone: warn }]
        : g.atReset !== undefined
          ? [muted(t(L, 'dial.atReset', { pct: formatPercent(Math.min(100, g.atReset)) }))]
          : [muted(firstFit(L, ['dial.measuring', 'dial.measuringShort'], room))]
  const before = g.emptiesAt !== undefined && g.resetsAt !== undefined ? t(L, 'dial.beforeReset', { left: formatCountdown(g.resetsAt - g.emptiesAt) }) : undefined
  const timing: Line | undefined =
    before !== undefined && g.resetsAt !== undefined
      ? displayWidth(before) <= room
        ? [{ text: before, tone: warn }]
        : [muted(t(L, 'dial.resets', { time: clockText(g.resetsAt) }))]
      : g.resetsAt !== undefined && !g.isUsedUp
        ? [muted(t(L, 'dial.resets', { time: clockText(g.resetsAt) }))]
        : undefined
  const week = sevenDayForecast(r.c)
  const seven: Line | undefined =
    r.c.reading?.sevenDay && week?.emptiesAt !== undefined ? [{ text: firstFit(L, ['dial.sevenRunsOut', 'dial.sevenRunsOutShort'], room, { in: formatCountdown(week.emptiesAt - now) }), tone: 'warn' }] : undefined
  const used = strong(t(L, 'dial.used', { pct: formatPercent(g.pct) }), tone)
  if (g.isStale) return [used, read, outcome, timing]
  if (rows <= 3) return [used, outcome, seven ?? timing]
  return [used, outcome, timing, seven ?? read]
}

/**
 * The context's bar: the whole window, what is used split by source in the
 * shares last measured, the free space up to the auto-compact point, the
 * buffer past it. Undefined with no fill (a fresh session, just after a
 * compaction) or nothing measured yet to split it by.
 */
export function contextBarOf(r: Readings, columns: number): BarPart[] | undefined {
  const fill = contextNow(r.c)
  const split = r.c.ctx
  // Nothing measured to split it by (no rows read, a breakdown with none): no bar.
  if (!split || split.messages + split.setup.reduce((sum, row) => sum + row.tokens, 0) <= 0) return undefined
  if (fill.tokens === undefined || fill.window === undefined || columns < 4) return undefined
  return barParts(split, { tokens: fill.tokens, window: fill.window, ...(fill.autoCompact !== undefined ? { autoCompact: fill.autoCompact } : {}) })
}

/** `42% · 83k left`: the fill in its threshold's colour, and the room to the auto-compact point (to the window's end while it is off). */
function contextHead(r: Readings, room: number): Line {
  const L = r.ctx.locale
  const fill = contextNow(r.c)
  const tone = toneOf(contextLevelOf(r))
  const head: Line = [{ text: formatPercent(fill.pct), bold: true, ...(tone ? { tone } : {}) }]
  const end = fill.autoCompact ?? fill.window
  if (fill.tokens === undefined || end === undefined) return head
  const left = muted(` · ${t(L, 'ctx.left', { left: formatTokens(Math.max(0, end - fill.tokens)) })}`)
  return lineWidth([...head, left]) <= room ? [...head, left] : head
}

/** The legend: the three largest sources, a swatch in each one's colour and its name, as many as fit; no numbers. */
export function contextLegend(r: Readings, room: number, count = 3): Line {
  const L = r.ctx.locale
  const split = r.c.ctx
  if (!split) return []
  const out: Line = []
  let used = 0
  for (const { id } of sourceTokens(split).slice(0, count)) {
    const item: Line = [{ text: '■', color: SOURCE_COLORS[id] }, { text: ` ${t(L, `ctx.src.${id}`)}` }]
    const w = lineWidth(item) + (out.length > 0 ? 2 : 0)
    if (used + w > room) break
    if (out.length > 0) out.push({ text: '  ' })
    out.push(...item)
    used += w
  }
  return out
}

/** The full instrument's fourth row: its compactions, or that auto-compact is off. */
function contextFoot(r: Readings, room: number): Line {
  const L = r.ctx.locale
  const c = r.c
  const last = c.compactTimes?.at(-1)
  if (c.compactions > 0) return [muted(t(L, c.compactions === 1 ? 'inst.compactedOnce' : 'inst.compacted', { n: c.compactions, ...(last !== undefined ? { time: clockText(last) } : { time: '—' }) }))]
  if (c.autoCompact && !c.autoCompact.isOn) return [muted(t(L, 'ctx.compactOff'))]
  return [muted(firstFit(L, ['inst.noCompaction', 'inst.noCompactionShort'], room))]
}

/** CONTEXT before there is a bar to draw: its fill and size, how far to the auto-compact point, its compactions. */
function contextWords(r: Readings, room: number, rows: number): (Line | undefined)[] {
  const L = r.ctx.locale
  const c = r.c
  const fill = contextNow(c)
  const tone = toneOf(contextLevelOf(r))
  const head: Line = [{ text: formatPercent(fill.pct), bold: true, ...(tone ? { tone } : {}) }]
  if (fill.tokens !== undefined && fill.window) {
    const of = muted(` · ${t(L, 'ctx.of', { tokens: formatTokens(fill.tokens), window: formatTokens(fill.window) })}`)
    if (lineWidth([...head, of]) <= room) head.push(of)
  }
  const second: Line =
    fill.autoCompact !== undefined && fill.tokens !== undefined
      ? [muted(firstFit(L, ['cell.toCompact', 'ctx.toCompact'], room, { left: formatTokens(Math.max(0, fill.autoCompact - fill.tokens)) }))]
      : c.autoCompact && !c.autoCompact.isOn
        ? [muted(t(L, 'ctx.compactOff'))]
        : fill.pct === undefined
          ? [muted(t(L, 'cell.noReading'))]
          : []
  const last = c.compactTimes?.at(-1)
  const third: Line = c.compactions === 0 ? [muted(firstFit(L, ['inst.noCompaction', 'inst.noCompactionShort'], room))] : [muted(t(L, c.compactions === 1 ? 'inst.compactedOnce' : 'inst.compacted', { n: c.compactions, ...(last !== undefined ? { time: clockText(last) } : { time: '—' }) }))]
  return rows > 2 ? [head, second, third] : [head, second]
}

/** COST: the session's, this turn's, the median turn's, what the columns are in. */
function costWords(r: Readings, unit: 'usd' | 'tokens', room: number): (Line | undefined)[] {
  const L = r.ctx.locale
  const c = r.c
  const turnUsd = c.turn ? liveTurnUsd(c) : c.history.at(-1)?.costUsd
  const runaway = !c.turn && c.history.at(-1)?.runaway === true
  const mid = median(c.turnUsd)
  return [
    strong(t(L, 'cost.session', { usd: formatUsd(c.reading?.costUsd) })),
    [{ text: t(L, 'cost.turn', { usd: formatUsd(turnUsd) }), tone: runaway ? 'warn' : 'muted' }],
    mid !== undefined ? [muted(t(L, 'inst.median', { usd: formatUsd(mid) }))] : [muted(t(L, 'inst.noMedian'))],
    c.history.length > 0 ? [muted(firstFit(L, [unit === 'usd' ? 'inst.costLegend' : 'inst.tokensLegend', unit === 'usd' ? 'inst.costLegendShort' : 'inst.tokensLegendShort'], room))] : undefined,
  ]
}

/** CHECKS: the run the duck would name, its kinds and when; the runs' tally; the edits since the last pass. */
function checksWords(r: Readings, room: number): (Line | undefined)[] {
  const L = r.ctx.locale
  const c = r.c
  const check = shownCheck(c)
  if (!check) return [[muted('—')], [muted(t(L, 'checks.none'))]]
  const face = checksFace(r)
  const background = backgroundCheckText(r, check, room - 2)
  // The run's time gives way first, where its verdict and the time do not fit together.
  const head: Line = background ? [{ text: `◌ ${background}`, bold: true }] : lineWidth(face.lines[0]) <= room ? face.lines[0] : face.lines[0].slice(0, 1)
  const kinds = kindsText(check, L)
  const job = background ? c.jobs.find(j => j.toolUseId === check.id) : undefined
  const expected = job ? r.eta?.jobs.find(j => j.id === job.id) : undefined
  // A run sent to the background is a job once its call comes back; until then nothing is said of its length.
  const when = !background ? `${kinds} · ${checkWhen(r, check)}` : !job ? undefined : expected ? t(L, 'hero.left', { left: formatLeft(Math.max(0, expected.to - r.ctx.now)) }) : t(L, 'agents.noUsual')
  const runs = c.checks.filter(ch => ch.status === 'pass' || ch.status === 'fail')
  const tally = t(L, 'inst.runs', { pass: runs.filter(ch => ch.status === 'pass').length, fail: runs.filter(ch => ch.status === 'fail').length })
  const open = unverified(c)
  const since = open === undefined ? t(L, 'inst.noPass') : open.count === 0 ? t(L, 'inst.noneSince') : t(L, open.count === 1 ? 'checks.editSince' : 'checks.editsSince', { n: open.count })
  return [head, when === undefined ? undefined : [muted(displayWidth(when) <= room ? when : kinds)], [muted(tally)], [muted(since)]]
}

/** HEALTH: the score and its word, its weakest part, what it is. */
function healthWords(r: Readings, room: number): (Line | undefined)[] {
  const L = r.ctx.locale
  const h = r.health
  if (!h.isMeasuring) return [[muted('—')], [muted(firstFit(L, ['health.hint.none', 'inst.notJudged'], room))]]
  return [strong(`${h.score} ${wordText(h.word, L)}`, toneOf(h.level)), [muted(fit(weakestHint(h, L), room))], [muted(firstFit(L, ['inst.judgement', 'inst.judgementShort'], room))]]
}

/** 45m, 3h12. */
function hm(ms: number): string {
  const min = Math.max(0, Math.floor(ms / MINUTE))
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`
}

/** SESSION: the model and effort, the permission mode, the time up and working, the turns and the project. */
function sessionWords(r: Readings, width: number): (Line | undefined)[] {
  const L = r.ctx.locale
  const { c, ctx } = r
  const model = [modelOf(c), c.meta.effort].filter(Boolean).join(' · ') || '—'
  const began = c.sessionStartedAt ?? c.startedAt
  const working = c.activeMs + turnWorkSoFar(c, ctx.now)
  const turns = c.turnCount + (c.turn ? 1 : 0)
  const project = c.meta.repo ?? (c.meta.root ? c.meta.root.replace(/\/+$/, '').split('/').at(-1) : undefined)
  return [
    strong(fit(model, width)),
    c.meta.mode ? [muted(t(L, 'inst.mode', { mode: c.meta.mode }))] : undefined,
    [muted(t(L, 'inst.up', { up: hm(ctx.now - began), working: hm(working) }))],
    [muted([t(L, turns === 1 ? 'ho.turns.one' : 'ho.turns.many', { n: turns }), ...(project ? [project] : [])].join(' · '))],
  ]
}

/**
 * AGENTS: how many of Claude's agents run (the one answer the progress reads
 * too), the first of them and its time; with none running, the quiet line of
 * teammates idle and agents waiting; the finished ones.
 */
function agentsWords(r: Readings, width: number): (Line | undefined)[] {
  const L = r.ctx.locale
  const { c, ctx, eta, work } = r
  const running = work.agents
  const done = c.agents.filter(a => a.status === 'done').length
  const failed = c.agents.filter(a => a.status === 'failed').length
  const first = running[0]
  const end = first ? eta?.agents.find(a => a.id === first.id) : undefined
  const quiet = agentsQuiet(r)
  return [
    running.length > 0 ? strong(t(L, 'agents.running', { n: running.length })) : [muted(t(L, 'agents.none'))],
    first ? [{ text: fit(`${first.type === 'general-purpose' ? 'general' : first.type} · ${first.description}`, width) }] : quiet ? [muted(fit(quiet, width))] : undefined,
    first ? [muted([t(L, 'inst.agentFor', { time: formatMinutes(ctx.now - first.startedAt) }), end ? t(L, 'hero.left', { left: formatLeft(end.to - ctx.now) }) : t(L, 'agents.noUsual')].join(' · '))] : undefined,
    [muted([t(L, 'agents.done', { n: done }), ...(failed > 0 ? [t(L, 'agents.failedCount', { n: failed })] : []), ...(first && quiet ? [quiet] : [])].join(' · '))],
  ]
}

/** Claude's agents alive and not running, in a few words: `3 teammates idle · 1 waiting`. */
function agentsQuiet(r: Readings): string | undefined {
  const L = r.ctx.locale
  const { idle, waiting } = r.work
  const parts = [...(idle.length > 0 ? [t(L, idle.length === 1 ? 'work.idleOne' : 'work.idle', { n: idle.length })] : []), ...(waiting.length > 0 ? [t(L, 'work.waiting', { n: waiting.length })] : [])]
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * An instrument as one line: its reading alone, for the inline pane and the
 * list beside an open detail (`151k/h · 1.3×`, `64% · ~96% at reset`).
 */
export function instrumentReading(r: Readings, id: InstrumentId): Line {
  const L = r.ctx.locale
  const c = r.c
  switch (id) {
    case 'pace': {
      const p = r.pace
      const tone = toneOf(p.level)
      return [{ text: t(L, 'pace.perHour', { tokens: formatTokens(p.perHour) }), bold: true, ...(tone ? { tone } : {}) }, ...(p.ratio !== undefined ? [muted(` · ${p.ratio.toFixed(1)}×`)] : [])]
    }
    case 'five': {
      const g = fuelGauge(c, r.ctx.now)
      if (!g) return [muted('—')]
      if (g.isReset) return [muted(t(L, 'limits.reset'))]
      const tone = toneOf(g.level)
      const head: Span = { text: formatPercent(g.pct), bold: true, ...(tone ? { tone } : {}) }
      if (g.emptiesAt !== undefined) return [head, { text: ` · ${t(L, 'dial.runsOut', { time: clockText(g.emptiesAt) })}`, tone: tone ?? 'warn' }]
      return [head, ...(g.atReset !== undefined ? [muted(` · ${t(L, 'dial.atReset', { pct: formatPercent(Math.min(100, g.atReset)) })}`)] : [])]
    }
    case 'context':
      return contextHead(r, Number.POSITIVE_INFINITY)
    case 'cost': {
      const turnUsd = c.turn ? liveTurnUsd(c) : c.history.at(-1)?.costUsd
      return [{ text: formatUsd(c.reading?.costUsd), bold: true }, muted(` · ${t(L, 'cost.turn', { usd: formatUsd(turnUsd) })}`)]
    }
    case 'checks': {
      const check = shownCheck(c)
      if (!check) return [muted(t(L, 'checks.none'))]
      const face = checksFace(r)
      // A run in the background names its kinds already: its time left follows it instead, once known.
      if (backgroundCheckText(r, check, 30)) {
        const left = (face.lines[1] ?? []).map(span => span.text).join('')
        return [...face.lines[0].slice(0, 1), ...(left ? [muted(` · ${left}`)] : [])]
      }
      return [...face.lines[0].slice(0, 1), muted(` · ${kindsText(check, L)}`)]
    }
    case 'files': {
      if (c.files.length === 0) return [muted(t(L, 'files.none'))]
      return [{ text: titleWhat(r, 'files') ?? '' }]
    }
    case 'health': {
      const h = r.health
      if (!h.isMeasuring) return [muted(t(L, 'health.hint.none'))]
      const tone = toneOf(h.level)
      return [{ text: `${h.score} ${wordText(h.word, L)}`, bold: true, ...(tone ? { tone } : {}) }]
    }
    case 'session':
      return [{ text: [modelOf(c), c.meta.effort].filter(Boolean).join(' · ') || '—' }]
    case 'agents': {
      const n = r.work.agents.length
      const quiet = agentsQuiet(r)
      return [n > 0 ? { text: t(L, 'agents.running', { n }), bold: true } : muted(t(L, 'agents.none')), ...(quiet ? [muted(` · ${quiet}`)] : [])]
    }
  }
}

/** The one-line form's name column: wide enough for every instrument's name in the language. */
export function nameColumn(r: Readings, ids: readonly InstrumentId[]): number {
  return Math.max(...ids.map(id => displayWidth(shortName(id, r.ctx.locale)))) + 1
}

/** An instrument's name in the one-line form: the five-hour window's short. */
export function shortName(id: InstrumentId, L: Locale): string {
  return id === 'five' ? t(L, 'inst.fiveShort') : instrumentName(id, L)
}
