// What a cell of the pane's grid, or one of its two dials, opens under the
// grid when pressed: the tile at length, from what quackpit already keeps.
// The pace's samples and its usual; the five-hour window's readings, its fit
// and their age; the context turn by turn with its compactions; the turns by
// cost; every check run with its failing lines; every subagent run; every
// edited file; the session's model, effort, mode and time; and health's
// parts, each with its value, rule, weight and what it took off. Host-neutral
// lines; the adapter draws them. Pure.

import { judgedKinds, kindsOf, type CheckResult } from './checks'
import { FIT_SPAN_MS, FIVE_HOUR_MS, fuelGauge, PACE_WARN_RATIO, PACE_BAD_RATIO, sevenDayForecast, type Level } from './derive'
import { baseName, clockText, formatAge, formatCountdown, formatDuration, formatMinutes, formatPercent, formatSpan, formatTokens, formatUsd, relativePath } from './format'
import { partName, partRule, partValue, wordText } from './health'
import { t, type Locale } from './i18n'
import { hitRatio, median, MINUTE, PACE_WINDOW_MS } from './metrics'
import { SETUP_KEYS, SOURCE_COLORS, sourceTokens, type SetupKey, type SourceId } from './context'
import { contextNow, contextShare, unverified, type AgentRun } from './model'
import { columnChart, displayWidth, fit, fitLine, lineWidth, pad, sparkline, wrapLine, type Line, type Span, type Tone } from './text'
import { checkSummary, kindsText, modelOf, projectionSpans, type Readings, type TileId } from './tiles'

/** What a press opens: any tile's but the hero's, whose detail is the timeline tab; pace and limits are the dials'. */
export type DetailId = Exclude<TileId, 'progress'>

export type Detail = {
  id: DetailId
  /** After the tile's name: the headline figure and what it is. */
  title: Line
  lines: Line[]
}

const muted = (text: string): Span => ({ text, tone: 'muted' })
/** A sentence of quackpit's own, wrapped whole over at most three lines rather than cut. */
const para = (text: string, width: number, tone: Tone = 'muted'): Line[] => wrapLine([{ text, tone }], width, 3)
const toneOf = (level: Level): Tone | undefined => (level === 'bad' ? 'bad' : level === 'warn' ? 'warn' : level === 'ok' ? 'ok' : undefined)
/** Whole minutes as hours and minutes: 45m, 3h12. */
const hm = (ms: number) => {
  const min = Math.max(0, Math.floor(ms / MINUTE))
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`
}

/** What the details need beyond the readings: the project root for paths. */
export type DetailExtra = { root?: string }

export function detailOf(r: Readings, id: DetailId, width: number, extra: DetailExtra = {}): Detail {
  const w = Math.max(24, width)
  const detail = DETAILS[id](r, w, extra)
  return { ...detail, lines: detail.lines.map(line => fitLine(line, w)) }
}

const DETAILS: Record<DetailId, (r: Readings, width: number, extra: DetailExtra) => Detail> = {
  pace: paceDetail,
  limits: windowDetail,
  context: contextDetail,
  cost: costDetail,
  checks: checksDetail,
  files: filesDetail,
  agents: agentsDetail,
  session: sessionDetail,
  health: healthDetail,
}

/** A chart's lines set in from the left, with its two ends named under it. */
function charted(chart: Line[], left: string, right: string, width: number): Line[] {
  const inner = Math.max(...chart.map(lineWidth), 0)
  const gap = Math.max(1, inner - displayWidth(left) - displayWidth(right))
  return [...chart.map(line => [{ text: '  ' }, ...line]), [muted(`  ${left}${' '.repeat(gap)}${right}`)]].map(line => fitLine(line, width))
}

// ------------------------------------------------------------------ the dials

function paceDetail(r: Readings, width: number): Detail {
  const L = r.ctx.locale
  const { c, ctx, pace: p } = r
  const tone = p.ratio !== undefined && p.ratio >= PACE_BAD_RATIO ? 'bad' : p.ratio !== undefined && p.ratio >= PACE_WARN_RATIO ? 'warn' : undefined
  const title: Line = [{ text: t(L, 'detail.pace.now', { pace: t(L, 'pace.perHour', { tokens: formatTokens(p.perHour) }) }), bold: true, ...(tone ? { tone } : {}) }]
  const lines: Line[] = [...para(t(L, 'detail.pace.what'), width)]
  // The last hour, a column a stretch of minutes, from the one-a-minute samples.
  const columns = width >= 48 ? 30 : 20
  const span = PACE_WINDOW_MS / columns
  const from = ctx.now - PACE_WINDOW_MS
  const buckets = Array.from({ length: columns }, () => 0)
  for (const [at, tokens] of c.recent) {
    const i = Math.floor((at - from) / span)
    if (i >= 0 && i < columns) buckets[i] = (buckets[i] ?? 0) + tokens
  }
  if (buckets.some(v => v > 0)) lines.push(...charted(columnChart(buckets, Math.max(...buckets), 3, () => undefined, 1), t(L, 'detail.pace.hourAgo'), t(L, 'detail.now'), width))
  else lines.push(...para(t(L, 'detail.pace.none'), width))
  lines.push([{ text: t(L, 'detail.pace.hour', { tokens: formatTokens(p.hourSum) }) }])
  if (!p.hasData) lines.push(...para(t(L, 'detail.pace.warming'), width))
  // Against what: your last days, or this session's own average until 3 days are kept.
  const usual = p.usual !== undefined ? t(L, 'pace.perHour', { tokens: formatTokens(p.usual) }) : undefined
  const days = ctx.days.filter(d => d.day < ctx.today && d.activeMin > 0 && d.tokens > 0).slice(-14)
  const activeMin = Math.floor(c.activeMs / MINUTE)
  if (p.ratio !== undefined && usual !== undefined) {
    const ratio = p.usualBasis === 'session' ? t(L, 'detail.pace.ratioSession', { x: p.ratio.toFixed(1), usual }) : t(L, 'detail.pace.ratio', { x: p.ratio.toFixed(1), usual })
    lines.push(...wrapLine([{ text: ratio, ...(tone ? { tone } : {}) }], width, 2))
  } else lines.push([muted(t(L, 'dial.noUsual'))])
  lines.push(...para(days.length >= 3 ? t(L, 'detail.pace.usualDays', { n: days.length }) : activeMin >= 10 ? t(L, 'detail.pace.usualSession', { n: activeMin }) : t(L, 'detail.pace.usualNone'), width))
  if (p.idleMs !== undefined && p.idleMs >= MINUTE) lines.push(...para(t(L, 'detail.pace.idle', { time: formatMinutes(p.idleMs) }), width))
  // The scale's two ends and its marks, which no longer sit under the dial.
  if (usual !== undefined && p.usual !== undefined) lines.push(...para(t(L, 'detail.pace.scale', { max: t(L, 'pace.perHour', { tokens: formatTokens(2 * p.usual) }), usual }), width))
  const hits = hitRatio(c.cache)
  if (hits !== undefined) lines.push(...para(t(L, 'detail.pace.cache', { pct: formatPercent(100 * hits) }), width))
  if (c.lastStep) lines.push(...para(t(L, 'detail.pace.latest', { age: formatAge(ctx.now - c.lastStep.at, L) }), width))
  return { id: 'pace', title, lines }
}

function windowDetail(r: Readings, width: number): Detail {
  const L = r.ctx.locale
  const { c, ctx } = r
  const now = ctx.now
  const five = c.reading?.fiveHour
  const g = fuelGauge(c, now)
  if (!five || !g) return { id: 'limits', title: [muted('—')], lines: para(t(L, 'detail.window.none'), width) }
  const title: Line = [{ text: t(L, 'dial.used', { pct: formatPercent(g.pct) }), bold: true, ...(toneOf(g.level) ? { tone: toneOf(g.level) } : {}) }, muted(` · ${t(L, 'dial.fiveWhat')}`)]
  const lines: Line[] = []
  if (g.isReset) lines.push(...para(t(L, 'detail.window.reset'), width))
  else {
    if (g.resetsAt !== undefined) lines.push([{ text: t(L, 'detail.window.resets', { time: clockText(g.resetsAt), in: formatCountdown(g.resetsAt - now) }) }])
    if (g.elapsed !== undefined) lines.push(...para(t(L, 'detail.window.elapsed', { gone: hm(g.elapsed * FIVE_HOUR_MS) }), width))
    if (g.isUsedUp && g.resetsAt !== undefined) lines.push([{ text: t(L, 'dial.usedUp', { time: clockText(g.resetsAt) }), tone: 'bad' }])
    else if (g.emptiesAt !== undefined && g.resetsAt !== undefined) lines.push(...wrapLine([{ text: t(L, 'detail.window.runsOut', { time: clockText(g.emptiesAt), left: formatCountdown(g.resetsAt - g.emptiesAt), reset: clockText(g.resetsAt) }), tone: toneOf(g.level) ?? 'warn' }], width, 2))
    else if (g.atReset !== undefined) lines.push(...para(t(L, 'detail.window.atReset', { pct: formatPercent(Math.min(100, g.atReset)) }), width))
    // The rate, here alone, in plain words.
    const readAt = c.reading?.at ?? now
    const fitted = c.fiveSamples.filter(([at]) => at > readAt - FIT_SPAN_MS && at <= readAt).length
    if (g.rate !== undefined) {
      const points = g.rate < 10 ? (Math.round(g.rate * 10) / 10).toString() : Math.round(g.rate).toString()
      // Both wrap whole: found cut at 56 to 64 columns while the rate was still the window's average.
      lines.push(...wrapLine([{ text: t(L, g.how === 'fit' ? 'detail.window.rate' : 'detail.window.rateAverage', { points }) }], width, 2))
      lines.push(...wrapLine([muted(t(L, g.how === 'fit' ? 'detail.window.rateWhat' : 'detail.window.rateWhatAverage', { n: fitted, points }))], width, 5))
    } else lines.push([muted(t(L, 'dial.measuring'))])
  }
  // The readings the trend goes through, oldest first: the last six, a minute's same reading once.
  const samples = c.fiveSamples.map(([at, pct]) => `${clockText(at)} ${formatPercent(pct)}`).filter((label, i, all) => label !== all[i - 1]).slice(-6)
  if (samples.length > 0) lines.push(...wrapLine([muted(`${t(L, 'detail.window.readings')} ${samples.join(' · ')}`)], width, 2))
  const seven = c.reading?.sevenDay
  if (seven) {
    // Where the week is heading: `→ ~61%`, or when it runs out before its own reset.
    const parts = [t(L, 'detail.window.seven', { pct: formatPercent(seven.pct) }), ...(seven.resetsAt !== undefined ? [t(L, 'detail.window.sevenResets', { in: formatCountdown(seven.resetsAt - now) })] : [])]
    lines.push([{ text: parts.join(' · ') }, ...projectionSpans(seven, sevenDayForecast(c), L, now)])
  }
  lines.push(...para(t(L, 'detail.window.scale'), width))
  lines.push(...para(t(L, 'detail.window.age', { age: formatAge(now - g.asOf, L) }), width))
  return { id: 'limits', title, lines }
}

// ------------------------------------------------------------------ the cells

/** The context's chart is drawn against its auto-compact point once a turn came this near it; before, against the turns. */
const CHART_NEAR = 0.5

/** A row of the sources' table: a swatch, a name padded to `nameW`, the tokens right-aligned, the share. */
function sourceRow(swatch: Span | undefined, name: string, nameW: number, tokens: string, share: string | undefined, indent = 0): Line {
  return [
    { text: ' '.repeat(indent) },
    ...(swatch ? [swatch, { text: ' ' }] : [{ text: '  ' }]),
    { text: pad(name, nameW) },
    { text: tokens.padStart(7) },
    ...(share !== undefined ? [muted(share.padStart(5))] : []),
  ]
}

/**
 * What fills the context, at length: every source with its tokens and share,
 * the largest first, setup's own rows under it (with the MCP servers and the
 * memory files), and the largest single parts. The setup rows and the
 * Messages row are /context's own figures; the split of Messages is
 * quackpit's, with `~`.
 */
function contextSplitLines(r: Readings, width: number): Line[] {
  const L = r.ctx.locale
  const split = r.c.ctx
  if (!split || sourceTokens(split).length === 0) return para(t(L, 'detail.context.noSplit'), width)
  const lines: Line[] = []
  lines.push(...para(t(L, 'detail.context.split', { time: clockText(split.at) }), width))
  const sources = sourceTokens(split)
  const total = sources.reduce((sum, s) => sum + s.tokens, 0)
  const name = (id: SourceId) => t(L, `ctx.src.${id}`)
  const setupName = (key: string) => ((SETUP_KEYS as readonly string[]).includes(key) ? t(L, `ctx.setup.${key as SetupKey}`) : key)
  const nameW = Math.min(Math.max(...sources.map(s => displayWidth(name(s.id))), ...split.setup.map(row => displayWidth(setupName(row.key)) + 2), 8) + 2, Math.max(10, width - 16))
  const share = (tokens: number) => (total > 0 ? `${Math.round((100 * tokens) / total)}%` : '')
  for (const s of sources) {
    const swatch: Span = { text: '■', color: SOURCE_COLORS[s.id] }
    // Setup's figure is /context's; the rest is quackpit's split of its Messages row.
    lines.push(sourceRow(swatch, name(s.id), nameW, s.id === 'setup' ? formatTokens(s.tokens) : `~${formatTokens(s.tokens)}`, share(s.tokens)))
    if (s.id !== 'setup') continue
    for (const row of [...split.setup].sort((a, b) => b.tokens - a.tokens)) {
      const extra =
        row.key === 'mcp' && split.mcp
          ? split.mcp.map(([server, tokens]) => `${server} ${formatTokens(tokens)}`).join(' · ')
          : row.key === 'agents' && split.agentCount
            ? t(L, split.agentCount === 1 ? 'detail.context.agent' : 'detail.context.agents', { n: split.agentCount })
            : row.key === 'skills' && split.skills
              ? t(L, 'detail.context.skills', { n: split.skills.included, total: split.skills.total })
              : row.key === 'memory' && split.memory
                ? split.memory.map(([path, tokens]) => `${path} ${formatTokens(tokens)}`).join(' · ')
                : ''
      const head = sourceRow(undefined, setupName(row.key), nameW - 2, formatTokens(row.tokens), undefined, 2)
      const room = width - lineWidth(head) - 2
      lines.push(extra !== '' && room >= 8 ? [...head, muted(`  ${fit(extra, room)}`)] : head)
    }
  }
  if (split.items.length > 0) {
    lines.push([muted(t(L, 'detail.context.largest'))])
    for (const item of split.items) {
      const what = item.tool ? [item.tool, item.what].filter(Boolean).join(' ') : item.note ? t(L, `ctx.note.${item.note}`) : t(L, `ctx.part.${item.kind ?? 'note'}`)
      const tokens = ` ~${formatTokens(item.tokens)}`
      lines.push([{ text: '  ' }, { text: '■', color: SOURCE_COLORS[item.source] }, { text: ` ${fit(what, Math.max(8, width - 4 - displayWidth(tokens)))}` }, muted(tokens)])
    }
  }
  return lines
}

/** After the chart: the tool schemas outside the window (never part of the bar), and how the split was measured. */
function contextAfterLines(r: Readings, width: number): Line[] {
  const L = r.ctx.locale
  const split = r.c.ctx
  if (!split || sourceTokens(split).length === 0) return []
  const lines: Line[] = []
  const deferred = split.deferred
  if (deferred && deferred.mcp + deferred.tools > 0) {
    const parts = [...(deferred.mcp > 0 ? [t(L, 'detail.context.deferredMcp', { tokens: formatTokens(deferred.mcp), n: deferred.mcpTools })] : []), ...(deferred.tools > 0 ? [t(L, 'detail.context.deferredTools', { tokens: formatTokens(deferred.tools) })] : [])]
    lines.push(...para(t(L, 'detail.context.deferred', { parts: parts.join(' · ') }), width))
  }
  lines.push(...wrapLine([muted(t(L, 'detail.context.how'))], width, 10))
  return lines
}

function contextDetail(r: Readings, width: number): Detail {
  const L = r.ctx.locale
  const { c } = r
  const fill = contextNow(c)
  const share = contextShare(fill)
  const level: Level = share === undefined ? 'none' : share >= 90 ? 'bad' : share >= 70 ? 'warn' : 'none'
  const tone = toneOf(level)
  const title: Line = [{ text: formatPercent(fill.pct), bold: true, ...(tone ? { tone } : {}) }, ...(fill.tokens !== undefined && fill.window ? [muted(` · ${t(L, 'ctx.of', { tokens: formatTokens(fill.tokens), window: formatTokens(fill.window) })}`)] : [])]
  const lines: Line[] = []
  if (fill.autoCompact !== undefined) lines.push([{ text: t(L, 'detail.context.at', { at: formatTokens(fill.autoCompact), ...(fill.tokens !== undefined ? { left: formatTokens(Math.max(0, fill.autoCompact - fill.tokens)) } : { left: '—' }) }) }])
  else if (c.autoCompact && !c.autoCompact.isOn) lines.push(...para(t(L, 'detail.context.off'), width))
  lines.push(...contextSplitLines(r, width))
  // Turn by turn, as each ended: against the point it compacts at (or the window) once the turns come
  // near it, else scaled to the turns themselves, so a session far from it still shows its shape.
  const turns = c.history.filter(h => h.ctx !== undefined)
  if (turns.length > 0) {
    const values = turns.map(h => h.ctx ?? 0)
    const point = fill.autoCompact ?? fill.window
    const largest = Math.max(...values)
    const isNear = point === undefined || largest >= CHART_NEAR * point
    const max = isNear ? (point ?? largest) : largest
    const per = turns.length * 2 <= width - 6 ? 2 : 1
    // Colour still reads against the point: amber from 70% of the way, red from 90%.
    const limit = point ?? largest
    const toneAt = (v: number): Tone | undefined => (v >= 0.9 * limit ? 'bad' : v >= 0.7 * limit ? 'warn' : undefined)
    const chart = columnChart(values, max, 3, toneAt, per)
    // A compaction marks the turn it came in or before.
    const marks = turns
      .map((h, i) => ((c.compactTimes ?? []).some(at => at <= h.endedAt && at > (turns[i - 1]?.endedAt ?? 0)) ? '⟲' : ' '))
      .map(mark => mark.padEnd(per))
      .join('')
    const first = turns[0]?.n ?? 0
    const last = turns.at(-1)?.n ?? 0
    lines.push(...charted([...chart, ...(marks.trim() !== '' ? [[muted(marks)]] : [])], t(L, 'detail.context.turn', { n: first }), first === last ? '' : t(L, 'detail.context.turn', { n: last }), width))
    lines.push(...para(isNear || point === undefined ? t(L, 'detail.context.scale', { max: formatTokens(max) }) : t(L, 'detail.context.scaleTurns', { max: formatTokens(largest), point: formatTokens(point) }), width))
  } else lines.push(...para(t(L, 'detail.context.noTurns'), width))
  const times = (c.compactTimes ?? []).map(clockText)
  lines.push(...para(c.compactions === 0 ? t(L, 'detail.context.noCompaction') : t(L, c.compactions === 1 ? 'detail.context.compaction' : 'detail.context.compactions', { n: c.compactions, times: times.join(t(L, 'sep.items')) || '—' }), width))
  lines.push(...contextAfterLines(r, width))
  return { id: 'context', title, lines }
}

function costDetail(r: Readings, width: number): Detail {
  const L = r.ctx.locale
  const { c } = r
  const priced = c.history.filter(h => h.costUsd !== undefined)
  const title: Line = [{ text: t(L, 'cost.session', { usd: formatUsd(c.reading?.costUsd) }), bold: true }]
  const lines: Line[] = [[muted(t(L, priced.length === 1 ? 'detail.cost.pricedOne' : 'detail.cost.priced', { n: priced.length }))]]
  const mid = median(c.turnUsd)
  lines.push(...para(mid !== undefined ? t(L, 'detail.cost.median', { usd: formatUsd(mid) }) : t(L, 'detail.cost.noMedian'), width))
  // The turns that cost most, most first: the ledger's figure where it priced them, else their tokens.
  const ranked = [...c.history].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.tokens - a.tokens).slice(0, 5)
  for (const h of ranked) {
    const amount = h.costUsd !== undefined ? formatUsd(h.costUsd) : formatTokens(h.tokens)
    const factor = mid !== undefined && mid > 0 && h.costUsd !== undefined ? `${(h.costUsd / mid).toFixed(1)}×` : ''
    const head = `#${h.n}`.padStart(4) + `  ${amount.padStart(7)}  ${factor.padStart(5)}  ${clockText(h.startedAt)}`
    const words = h.prompt ?? ''
    const room = width - displayWidth(head) - 2
    const tone: Tone | undefined = h.runaway ? 'warn' : undefined
    lines.push([{ text: head, ...(tone ? { tone } : {}) }, ...(words && room >= 8 ? [muted(`  ${fit(words, room)}`)] : [])])
  }
  if (ranked.length === 0) lines.push([muted(t(L, 'pane.history.none'))])
  const tokens = c.history.slice(-20).map(h => h.tokens)
  if (tokens.length > 1) lines.push([{ text: `  ${sparkline(tokens)}` }, muted(` ${t(L, 'detail.cost.spark', { n: tokens.length })}`)])
  return { id: 'cost', title, lines }
}

/** A run's verdict, its mark first: `✓ types+tests  175 passed · 9.1 s · 14:32 (2 min ago)`. */
function runLine(check: CheckResult, r: Readings): Line {
  const L = r.ctx.locale
  const mark = check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : check.status === 'running' || check.status === 'background' ? '◌' : check.status === 'hidden' ? '?' : '–'
  const tone: Tone | undefined = check.status === 'pass' ? 'ok' : check.status === 'fail' ? 'bad' : undefined
  const when = check.replayed ? t(L, 'resume.before') : `${clockText(check.endedAt ?? check.startedAt)} (${formatAge(r.ctx.now - (check.endedAt ?? check.startedAt), L)})`
  const facts = [checkSummary(check, L), ...(check.durationMs !== undefined && check.status !== 'running' ? [formatDuration(check.durationMs)] : []), when]
  return [{ text: `${mark} `, ...(tone ? { tone } : {}) }, { text: kindsText(check, L), bold: true, ...(tone ? { tone } : {}) }, { text: `  ${facts.join(' · ')}` }]
}

function checksDetail(r: Readings, width: number): Detail {
  const L = r.ctx.locale
  const { c } = r
  const runs = c.checks.filter(ch => ch.status !== 'running' || ch === c.checks.at(-1))
  const passed = runs.filter(ch => ch.status === 'pass').length
  const failed = runs.filter(ch => ch.status === 'fail').length
  const stopped = runs.filter(ch => ch.status === 'interrupted' || ch.status === 'hidden').length
  const title: Line = [{ text: t(L, runs.length === 1 ? 'detail.checks.run' : 'detail.checks.runs', { n: runs.length }), bold: true }]
  if (runs.length === 0) return { id: 'checks', title: [muted('—')], lines: [[muted(t(L, 'checks.none'))]] }
  const lines: Line[] = [[muted([t(L, 'checks.passed', { n: passed }), t(L, 'checks.failed', { n: failed }), ...(stopped > 0 ? [t(L, 'detail.checks.stopped', { n: stopped })] : [])].join(t(L, 'sep.clause')))]]
  const open = unverified(c)
  lines.push(...para(open === undefined ? t(L, 'ho.noPass') : open.count === 0 ? t(L, 'detail.checks.noneSince') : t(L, open.count === 1 ? 'detail.checks.editSince' : 'detail.checks.editsSince', { n: open.count }), width))
  const failing = c.failures.map(f => t(L, `kind.${f.kind}`))
  if (failing.length > 0) lines.push([{ text: t(L, 'detail.checks.failing', { kinds: failing.join(t(L, 'sep.items')) }), tone: 'bad' }])
  const shown = [...runs].reverse().slice(0, 5)
  for (const check of shown) {
    lines.push(runLine(check, r))
    lines.push([muted(`  ${fit(check.command, width - 2)}`)])
    // What failed, in the run's own words: its first failing lines.
    if (check.status === 'fail' && check.tail) for (const text of check.tail.split('\n').slice(0, 3)) lines.push([muted('  │ '), { text: fit(text, width - 4), tone: 'bad' }])
  }
  if (runs.length > shown.length) lines.push([muted(t(L, 'detail.checks.earlier', { n: runs.length - shown.length }))])
  // Kinds a chain ran together are one run of each.
  if (runs.some(ch => kindsOf(ch).length > 1 && judgedKinds(ch).length !== kindsOf(ch).length)) lines.push(...para(t(L, 'detail.checks.named'), width))
  return { id: 'checks', title, lines }
}

function filesDetail(r: Readings, width: number, extra: DetailExtra): Detail {
  const L = r.ctx.locale
  const { c } = r
  const edits = c.files.reduce((sum, f) => sum + f.edits, 0)
  if (c.files.length === 0) return { id: 'files', title: [muted('—')], lines: [[muted(t(L, 'files.none'))]] }
  const title: Line = [{ text: t(L, 'files.count', { files: t(L, c.files.length === 1 ? 'unit.file' : 'unit.files', { n: c.files.length }), edits: t(L, edits === 1 ? 'unit.edit' : 'unit.edits', { n: edits }) }), bold: true }]
  const open = unverified(c)
  const unseen = new Set(open?.paths ?? [])
  const lines: Line[] = para(open === undefined ? t(L, 'ho.noPass') : unseen.size === 0 ? t(L, 'ho.noUnverified') : t(L, 'detail.files.unverified', { n: unseen.size }), width)
  const files = [...c.files].sort((a, b) => b.edits - a.edits || b.lastAt - a.lastAt)
  const root = extra.root ?? c.meta.root
  const shown = files.slice(0, 10)
  for (const f of shown) {
    const marks = [...(f.created ? [t(L, 'detail.files.new')] : []), ...(unseen.has(f.path) ? [t(L, 'detail.files.unseen')] : [])]
    const tail = marks.length > 0 ? `  ${marks.join(' · ')}` : ''
    const count = `×${f.edits}`.padStart(4)
    const path = relativePath(f.path, root)
    const room = width - displayWidth(count) - 2 - displayWidth(tail)
    lines.push([{ text: count }, { text: `  ${displayWidth(path) <= room ? path : `…${path.slice(-(Math.max(4, room) - 1))}`}` }, muted(tail)])
  }
  if (files.length > shown.length) lines.push([muted(t(L, 'time.more', { n: files.length - shown.length }))])
  return { id: 'files', title, lines }
}

function agentsDetail(r: Readings, width: number): Detail {
  const L = r.ctx.locale
  const { c, ctx, work } = r
  const isOpen = (a: AgentRun) => a.status === 'running' || a.status === 'background'
  const isAlive = (a: AgentRun) => isOpen(a) || a.status === 'idle' || a.status === 'waiting'
  const done = c.agents.filter(a => a.status === 'done').length
  const failed = c.agents.filter(a => a.status === 'failed').length
  if (c.agents.length === 0) return { id: 'agents', title: [muted('—')], lines: [[muted(t(L, 'agents.none'))]] }
  const title: Line = [{ text: t(L, c.agents.length === 1 ? 'detail.agents.run' : 'detail.agents.runs', { n: c.agents.length }), bold: true }]
  // Running is Claude's agents at work, as the progress counts them; idle teammates and waiting agents are alive, not running.
  const quiet = [...(work.idle.length > 0 ? [t(L, work.idle.length === 1 ? 'work.idleOne' : 'work.idle', { n: work.idle.length })] : []), ...(work.waiting.length > 0 ? [t(L, 'work.waiting', { n: work.waiting.length })] : [])]
  const lines: Line[] = [[muted([t(L, 'agents.running', { n: work.agents.length }), ...quiet, t(L, 'agents.done', { n: done }), ...(failed > 0 ? [t(L, 'agents.failedCount', { n: failed })] : [])].join(' · '))]]
  for (const a of [...c.agents].sort((x, y) => y.startedAt - x.startedAt).slice(0, 8)) {
    const name = `${a.type === 'general-purpose' ? 'general' : a.type} · ${a.description}`
    const length = isAlive(a) ? `${hm(ctx.now - a.startedAt)}…` : a.replayed ? t(L, 'resume.before') : formatSpan(a.durationMs ?? (a.endedAt ?? ctx.now) - a.startedAt)
    const facts: string[] = []
    if (a.status === 'failed') facts.push(t(L, 'agents.failed'))
    else if (a.status === 'remote') facts.push(t(L, 'agents.remote'))
    else if (a.status === 'idle') facts.push(t(L, a.teammate ? 'detail.agents.teammateIdle' : 'agents.idle'))
    else if (a.status === 'waiting') facts.push(t(L, 'agents.waiting'))
    else if (a.teammate && isOpen(a)) facts.push(t(L, 'agents.teammate'))
    else if (a.isBackground) facts.push(t(L, 'agents.background'))
    else if (a.tokens !== undefined) facts.push(t(L, 'detail.agents.tokens', { tokens: formatTokens(a.tokens) }))
    if (a.toolUses !== undefined) facts.push(t(L, a.toolUses === 1 ? 'unit.tool' : 'unit.tools', { n: a.toolUses }))
    if (a.added !== undefined || a.removed !== undefined) facts.push(`+${a.added ?? 0} −${a.removed ?? 0}`)
    const mark: Span = a.status === 'failed' ? { text: '✗ ', tone: 'bad' } : isOpen(a) ? { text: '▸ ', bold: true } : a.status === 'idle' || a.status === 'waiting' ? muted('○ ') : a.status === 'remote' ? muted('↗ ') : muted('✓ ')
    const tail = `  ${length}${facts.length > 0 ? ` · ${facts.join(' · ')}` : ''}`
    lines.push([mark, { text: fit(name, Math.max(8, width - 2 - displayWidth(tail))), ...(a.status === 'failed' ? { tone: 'bad' as const } : {}) }, muted(tail)])
  }
  if (c.agents.length > 8) lines.push([muted(t(L, 'time.more', { n: c.agents.length - 8 }))])
  return { id: 'agents', title, lines }
}

function sessionDetail(r: Readings, width: number, extra: DetailExtra): Detail {
  const L = r.ctx.locale
  const { c, ctx } = r
  const meta = c.meta
  const model = modelOf(c)
  const title: Line = [{ text: [model, meta.effort].filter(Boolean).join(' · ') || '—', bold: true }]
  // 9 columns, or the longest head and two more where a language's words are longer (`プロジェクト` takes 12).
  const headW = Math.max(9, ...(['detail.session.model', 'detail.session.effort', 'detail.session.up', 'detail.session.project'] as const).map(key => displayWidth(t(L, key)) + 2))
  const head = (key: Parameters<typeof t>[1]) => ({ text: pad(t(L, key), headW), bold: true, tone: 'muted' as const })
  const lines: Line[] = []
  const raw = meta.model ?? c.lastStep?.model
  lines.push([head('detail.session.model'), { text: model ?? '—' }, ...(raw && raw !== model ? [muted(` (${raw})`)] : [])])
  lines.push([head('detail.session.effort'), { text: meta.effort ?? '—' }, muted(` · ${t(L, 'detail.session.mode')} `), { text: meta.mode ?? '—' }])
  const began = c.sessionStartedAt ?? c.startedAt
  const working = c.activeMs + (c.turn ? Math.max(0, ctx.now - c.turn.startedAt) : 0)
  const turns = c.turnCount + (c.turn ? 1 : 0)
  lines.push([head('detail.session.up'), { text: hm(ctx.now - began) }, muted(` · ${t(L, 'detail.session.since', { time: clockText(began) })} · ${t(L, 'time.working', { time: hm(working) })} · ${t(L, turns === 1 ? 'ho.turns.one' : 'ho.turns.many', { n: turns })}`)])
  if (c.joinedLate) lines.push(...wrapLine([muted(t(L, 'detail.session.joined', { time: clockText(c.startedAt) }))], width - headW, 2).map(line => [{ text: ' '.repeat(headW) }, ...line]))
  const root = extra.root ?? meta.root
  if (root) lines.push([head('detail.session.project'), { text: meta.repo ?? baseName(root) }, muted(`  ${fit(root, Math.max(8, width - headW - 2 - displayWidth(meta.repo ?? baseName(root))))}`)])
  return { id: 'session', title, lines }
}

function healthDetail(r: Readings, width: number): Detail {
  const L = r.ctx.locale
  const h = r.health
  const tone = toneOf(h.level)
  const title: Line = [{ text: `${h.score} ${wordText(h.word, L)}`, bold: true, ...(tone ? { tone } : {}) }]
  const lines: Line[] = [...para(t(L, 'detail.health.how'), width)]
  const nameW = Math.max(...h.parts.map(p => displayWidth(partName(p.id, L)))) + 2
  const offs = h.parts.map(p => `${p.off > 0 ? `−${p.off}` : '0'} / ${p.weight}`)
  const offW = Math.max(...offs.map(displayWidth))
  const values = h.parts.map(p => partValue(p, L, clockText))
  const room = width - nameW - offW - 2
  // One form for every part: each value beside its name where all of them fit, else each under its name.
  const isBeside = values.every(value => displayWidth(value) <= room)
  h.parts.forEach((p, i) => {
    const off: Span = { text: `  ${(offs[i] ?? '').padStart(offW)}`, ...(p.off === 0 ? { tone: 'muted' as const } : {}) }
    const value: Span = { text: values[i] ?? '', ...(p.reading ? {} : { tone: 'muted' as const }) }
    const name: Span = { text: partName(p.id, L), bold: true }
    if (isBeside) lines.push([{ ...name, text: pad(name.text, nameW) }, { ...value, text: pad(value.text, room) }, off])
    else {
      lines.push([{ ...name, text: pad(name.text, width - offW - 2) }, off])
      lines.push(...wrapLine([value], width - 2, 2).map(line => [{ text: '  ' }, ...line]))
    }
    const indent = isBeside ? nameW : 2
    lines.push(...wrapLine([muted(partRule(p.id, L))], width - indent, 2).map(line => [{ text: ' '.repeat(indent) }, ...line]))
  })
  lines.push([muted(t(L, 'detail.health.sum', { score: h.score, off: 100 - h.score }))])
  return { id: 'health', title, lines }
}
