// The tiles: which exist, the default set, and each one's face in the band:
// a graphic (dial, ring, duck, or the hero's big digits) beside two lines of
// styled text, sized to its content. Faces are host-neutral; the adapter
// draws them with whatever its surface has. Pure.

import { judgedKinds, kindsOf, type CheckKind, type CheckResult } from './checks'
import {
  contextLevel,
  fiveHourForecast,
  fiveHourLevel,
  isReset,
  liveTurnUsd,
  paceReading,
  sevenDayForecast,
  sevenDayLevel,
  worse,
  type DayTotals,
  type Forecast,
  type Level,
  type PaceReading,
} from './derive'
import { cautionFit, cautionsOf, cautionText, duckState, type DuckState } from './duck'
import { AI_MAX_CALLS, overrunAfter } from './ai'
import { estimate, openItems, type Durations, type Eta, type OpenItem } from './eta'
import { jobName, type CommandLengths } from './jobs'
import { turnFact, turnLengths, type TurnFact } from './lengths'
import { digitColumns } from './font'
import { healthOf, weakestHint, wordText, type Health } from './health'
import { clockText, formatAge, formatCountdown, formatDuration, formatLeft, formatMinutes, formatPercent, formatSpan, formatTokens, formatUsd, baseName } from './format'
import type { Graphic } from './gauges'
import { t, type Key, type Locale, type Params } from './i18n'
import { contextNow, contextShare, turnLength, turnWorkSoFar, unverified, type Cockpit, type Phase, type Window } from './model'
import { isAtWork, workOf, type Work } from './work'
import { activeMs, waitingNow, type Wait } from './waits'
import { isListLive, progressOf } from './progress'
import { MIN_POND_COLUMNS } from './pond'
import { DUCK_COLUMNS } from './sprites'
import { displayWidth, fit, fitLine, lineWidth, projectedSegments, ringGlyph, segments, sparkline, type Line, type Span, type Tone } from './text'

export const TILE_IDS = ['progress', 'pace', 'context', 'limits', 'checks', 'cost', 'agents', 'files', 'session', 'health'] as const
export type TileId = (typeof TILE_IDS)[number]

export const DEFAULT_TILES: readonly TileId[] = ['progress', 'pace', 'context', 'limits', 'checks', 'cost']

/** A name a saved layout or a setting may still hold (an older build's `streak` placeholder) is no tile: it is dropped. */
export function isTileId(x: unknown): x is TileId {
  return typeof x === 'string' && (TILE_IDS as readonly string[]).includes(x)
}

/** The tiles there are to show, add or name in a setting. */
export function availableTiles(): TileId[] {
  return [...TILE_IDS]
}

/** The names in a tiles setting that are no tile there is (what `/config` refuses). */
export function unknownTiles(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/[\s,]+/)
    .map(name => name.trim())
    .filter(name => name !== '' && !isTileId(name.toLowerCase()))
}

/** A comma- or space-separated list of tile names, unknown and repeated ones dropped. */
export function parseTiles(text: string): TileId[] {
  const out: TileId[] = []
  for (const raw of text.split(/[\s,]+/)) {
    const name = raw.trim().toLowerCase()
    if (isTileId(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** What every face reads: the time, the language, and your usual days for pace. */
export type ViewContext = {
  now: number
  locale: Locale
  days: readonly DayTotals[]
  today: string
  /** What other sessions' finished tasks and subagents took: the estimate's stand-in. */
  priors?: Durations
  /** The AI ETA's setting: its answer is a part of the estimate only while it is on. */
  aiOn?: boolean
  /** The last runs of each command, by project: how long a background job usually takes. */
  lengths?: CommandLengths
}

/** The readings the faces share, computed once per draw. */
export type Readings = {
  c: Cockpit
  ctx: ViewContext
  pace: PaceReading
  duck: DuckState
  /** How long the work in hand will take, where anything has a measured pace (or the AI answered). */
  eta?: Eta
  /** How the turn running compares with your recorded turns, where it has no estimate to show. */
  fact?: TurnFact
  /** The judgement of how the work is going, from its measured parts. */
  health: Health
  /** The wait on the person that holds the main loop now: nothing counts down while it lasts. */
  wait?: Wait
  /** Claude's work running with no expected end (no length known for it): it adds nothing to the time. */
  open: OpenItem[]
  /** What runs now and what waits: the one answer the progress and AGENTS read. */
  work: Work
  /** Whether work is in hand: a turn, Claude's own agents at work, background jobs holding the headline. */
  isWorking: boolean
  /** Whether Claude's agents or background jobs still run, whatever the turn and the list say. */
  isWorkOpen: boolean
}

export function readingsOf(c: Cockpit, ctx: ViewContext): Readings {
  // One estimate for the work in hand: the parts measured and, while its setting is on, the AI's answer, ending at the latest.
  const eta = estimate(c, ctx.now, { ...(ctx.priors ? { priors: ctx.priors } : {}), ...(ctx.lengths ? { lengths: ctx.lengths } : {}), ...(ctx.aiOn ? { aiOn: true } : {}) })
  const fact = c.turn && !eta && !isListLive(c.tasks, c.turn.n) ? turnFact(turnLengths(c, ctx.priors), turnWorkSoFar(c, ctx.now)) : undefined
  const pace = paceReading(c, ctx.now, ctx.days, ctx.today)
  const wait = waitingNow(c.waits)
  const work = workOf(c, ctx.now, eta)
  return {
    c,
    ctx,
    pace,
    duck: duckState(c, cautionsOf(c, ctx.now)),
    health: healthOf(c, ctx.now, pace),
    ...(eta ? { eta } : {}),
    ...(fact ? { fact } : {}),
    ...(wait ? { wait } : {}),
    // Work with no length known, as the headline may name it: a job running aside is a quiet line instead.
    open: openItems(c, eta).filter(item => item.kind === 'agent' || work.jobs.some(j => j.id === item.id)),
    work,
    isWorking: c.turn !== undefined || isAtWork(work),
    isWorkOpen: isAtWork(work),
  }
}

/**
 * Whether the AI ETA is being asked again: a call in flight, or the turn far
 * enough past its latest answer (30 seconds, or half the answer) with a call
 * left this turn.
 */
export function isAskingAgain(c: Cockpit, now: number): boolean {
  const asks = c.turn?.asks ?? []
  if (asks.at(-1)?.state === 'asking') return asks.length > 1
  if (asks.length >= AI_MAX_CALLS) return false
  const answered = asks.findLast(a => a.state === 'answered' && a.leftMs !== undefined)
  return answered?.leftMs !== undefined && activeMs(c.waits, answered.askedAt, now) > overrunAfter(answered.leftMs)
}

/**
 * What is left in words: `~8m left`; the AI's when its answer ends last,
 * `~8m left (AI)` and a revision's `~8m left (AI, revised)`; `past the AI's
 * ~9m` once the turn outran it, with `asking again` while a re-ask is due.
 */
export function etaWords(eta: Eta, L: Locale, isAsking = false): string {
  const ai = eta.last === 'ai' ? eta.ai : undefined
  if (ai?.isOver) return t(L, isAsking ? 'hero.overAiAsking' : 'hero.overAi', { whole: formatLeft(ai.wholeMs) })
  if (ai) return t(L, ai.n > 1 ? 'hero.leftAiRevised' : 'hero.leftAi', { left: formatLeft(eta.leftMs) })
  return t(L, 'hero.left', { left: formatLeft(eta.leftMs) })
}

/** The wait on the person, in words: `⏸ waiting on you · 1m05`, or its short form within `room` columns. */
export function waitWords(w: Wait, now: number, L: Locale, room = Number.POSITIVE_INFINITY): string {
  const time = formatSpan(Math.max(0, now - w.from))
  const full = t(L, 'wait.on', { time })
  return displayWidth(full) <= room ? full : t(L, 'wait.short', { time })
}

/**
 * The fact in words: `longer than 90% of your turns`, or within `room`
 * columns its short form (`longer than 90% of turns`); undefined when not
 * even that fits.
 */
export function factText(fact: TurnFact, L: Locale, room = Number.POSITIVE_INFINITY): string | undefined {
  const forms: readonly Key[] = fact.kind === 'longest' ? ['fact.longest', 'fact.longestShort'] : fact.pct === 50 ? ['fact.half', 'fact.halfShort'] : ['fact.share', 'fact.shareShort']
  return forms.map(key => t(L, key, { n: fact.n, ...(fact.kind === 'share' ? { pct: fact.pct } : {}) })).find(text => displayWidth(text) <= room)
}

export type Face = {
  id: TileId | 'duck' | 'more'
  /** Columns the face takes, graphic and gaps included. */
  width: number
  graphic?: Graphic
  /** The hero's big number, drawn 2 rows tall. */
  digits?: { text: string; tone?: Tone }
  lines: [Line, Line]
  level: Level
  /**
   * The hero's second line as the swimming duck: a pond `columns` wide with the
   * duckling `fraction` of the way across, then `tail` (the time left). Where
   * a surface draws no pictures, `lines[1]` says the same in text.
   */
  pond?: Pond
}

export type Pond = { columns: number; fraction: number; tail: Line }

const toneOf = (level: Level): Tone | undefined => (level === 'bad' ? 'bad' : level === 'warn' ? 'warn' : level === 'ok' ? 'ok' : undefined)

/** A tile's dim name, on its second line. */
const band = (r: Readings, key: Key): Span => ({ text: t(r.ctx.locale, key), tone: 'muted' })

function face(id: Face['id'], lines: [Line, Line], level: Level, graphic?: Graphic, digits?: Face['digits'], textWidth?: number): Face {
  const textW = textWidth ?? Math.max(lineWidth(lines[0]), lineWidth(lines[1]))
  const graphicW = graphic ? graphic.cols + 1 : 0
  const digitsW = digits ? digitColumns(digits.text) + 1 : 0
  return { id, width: graphicW + digitsW + textW, lines, level, ...(graphic ? { graphic } : {}), ...(digits ? { digits } : {}) }
}

// ----------------------------------------------------------------- hero

/** The words for what the turn is doing. */
export function phaseText(phase: Phase, locale: Locale): string {
  if (phase.kind === 'idle') return t(locale, 'phase.idle')
  if (phase.kind === 'thinking') return t(locale, 'phase.thinking')
  const subject = phase.subject ?? ''
  switch (phase.tool) {
    case 'Bash':
      // Claude's own description is a sentence already ("Run the tests"): it is shown as written; a bare command runs.
      return /^\p{Lu}/u.test(subject) ? subject : t(locale, 'phase.Bash', { subject })
    case 'Read':
      return t(locale, 'phase.Read', { subject })
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return t(locale, 'phase.Edit', { subject })
    case 'Write':
      return t(locale, 'phase.Write', { subject })
    case 'Grep':
    case 'Glob':
      return t(locale, 'phase.Search', { subject })
    case 'Agent':
      return t(locale, 'phase.Agent', { subject })
    case 'WebFetch':
    case 'WebSearch':
      return t(locale, 'phase.Web', { subject })
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
      return t(locale, 'phase.Plan')
    case 'AskUserQuestion':
      return subject ? t(locale, 'phase.Ask', { subject }) : t(locale, 'phase.AskBare')
    case 'ExitPlanMode':
      return t(locale, 'phase.PlanShow')
    default:
      return subject ? `${phase.tool} · ${subject}` : t(locale, 'phase.tool', { tool: phase.tool })
  }
}

export const HERO_MIN = 20
export const HERO_MAX = 64

/** `3 tools`, `1 tool`. */
export function toolsText(n: number, L: Locale): string {
  return t(L, n === 1 ? 'unit.tool' : 'unit.tools', { n })
}

/** `1 error`, `3 errors`. */
function errorsText(n: number, L: Locale): string {
  return n === 1 ? t(L, 'checks.error') : t(L, 'checks.errors', { n })
}

/** `3 files · 1 edit`: how many files were edited, how many times. */
export function filesText(files: number, edits: number, L: Locale): string {
  return t(L, 'files.count', { files: t(L, files === 1 ? 'unit.file' : 'unit.files', { n: files }), edits: t(L, edits === 1 ? 'unit.edit' : 'unit.edits', { n: edits }) })
}

/** The longest progress meter: past it the rest of the line stays empty. */
const METER_MAX = 24

/** The background work the head names when no turn runs. */
export type WorkItem = { kind: 'job' | 'agent'; id: string; name: string; from: number }

/**
 * What runs when no turn does: the background work Claude will come back to,
 * named by the part expected to end last (else the first running): a job's
 * command or description, an agent's type and task.
 */
export function workItem(r: Readings): WorkItem | undefined {
  const { eta } = r
  const { jobs, agents } = r.work
  const lastJob = eta?.last === 'job' ? eta.jobs.reduce<(typeof eta.jobs)[number] | undefined>((x, j) => (!x || j.to > x.to ? j : x), undefined) : undefined
  const lastAgent = eta?.last === 'agent' ? eta.agents.reduce<(typeof eta.agents)[number] | undefined>((x, a) => (!x || a.to > x.to ? a : x), undefined) : undefined
  const job = jobs.find(j => j.id === lastJob?.id) ?? (lastAgent ? undefined : jobs[0])
  if (job) return { kind: 'job', id: job.id, name: jobName(job), from: job.startedAt }
  const agent = agents.find(a => a.id === lastAgent?.id) ?? agents[0]
  if (agent) return { kind: 'agent', id: agent.id, name: `${agent.type === 'general-purpose' ? 'general' : agent.type} · ${agent.description}`, from: agent.startedAt }
  return undefined
}

/** The fewest columns of a job's name worth its `· background` tag beside it. */
const NAME_WITH_TAG_MIN = 12

/**
 * {@link workItem}'s name within `room` columns: a job's with its
 * `· background` tag, the name cut first and never the tag; where that would
 * leave a stub of the name, the name alone.
 */
export function workName(r: Readings, room = Number.POSITIVE_INFINITY): string | undefined {
  const item = workItem(r)
  if (!item) return undefined
  if (item.kind === 'agent') return fit(item.name, room)
  const L = r.ctx.locale
  const around = displayWidth(t(L, 'job.background', { name: 'x' })) - 1
  if (displayWidth(item.name) + around <= room) return t(L, 'job.background', { name: item.name })
  return room - around >= NAME_WITH_TAG_MIN ? t(L, 'job.background', { name: fit(item.name, room - around) }) : fit(item.name, room)
}

/**
 * What is alive and not running, and what runs aside, as one quiet line: the
 * teammates idle between their turns (`3 teammates idle`), Claude's agents
 * waiting on their own work and jobs still queued (`1 waiting`), and a job
 * with no expected end past its first 30 minutes (`npm run dev · background
 * 2h05`). Undefined when there is none: it never takes the headline.
 */
export function quietLine(r: Readings, width: number): Line | undefined {
  const L = r.ctx.locale
  const { idle, waiting, queued, aside } = r.work
  const sep = ' · '
  const counts = [...(idle.length > 0 ? [t(L, idle.length === 1 ? 'work.idleOne' : 'work.idle', { n: idle.length })] : []), ...(waiting.length + queued.length > 0 ? [t(L, 'work.waiting', { n: waiting.length + queued.length })] : [])]
  // Each count whole where it fits; a job running aside after them, its name cut first and never its time.
  let out = ''
  for (const part of counts) {
    const next = out === '' ? part : `${out}${sep}${part}`
    if (displayWidth(next) > width) break
    out = next
  }
  const first = aside[0]
  if (first) {
    const time = formatMinutes(r.ctx.now - first.startedAt)
    const lead = out === '' ? '' : sep
    const room = width - displayWidth(out) - displayWidth(lead) - (displayWidth(t(L, 'work.aside', { name: 'x', time })) - 1)
    if (room >= 8) {
      out = `${out}${lead}${t(L, 'work.aside', { name: fit(jobName(first), room), time })}`
      const more = t(L, 'work.asideMore', { n: aside.length - 1 })
      if (aside.length > 1 && displayWidth(`${out}${sep}${more}`) <= width) out = `${out}${sep}${more}`
    }
  }
  return out === '' ? undefined : [{ text: out, tone: 'muted' }]
}

/** A part running with no expected end, in words: `make test-all · running 3m, no usual length yet`. */
export function openWords(r: Readings, item: OpenItem): string {
  const L = r.ctx.locale
  const job = item.kind === 'job' ? r.c.jobs.find(j => j.id === item.id) : undefined
  const agent = item.kind === 'agent' ? r.c.agents.find(a => a.id === item.id) : undefined
  const name = job ? jobName(job) : agent ? `${agent.type === 'general-purpose' ? 'general' : agent.type}` : item.id
  return t(L, 'eta.open', { name, time: formatMinutes(r.ctx.now - item.from) })
}

/**
 * The hero. With a live task list: its `done/total` in big digits, the
 * current task, and a meter with the time left at the list's own pace. With
 * none: no digits (Claude Code's spinner already shows the turn's clock just
 * above), what the turn is doing, and `turn N · M tools`; between turns the
 * last turn, at minute resolution, or the background work still running.
 * While the main loop waits on the person, the time left gives way to how
 * long it has waited: nothing counts down.
 */
export function heroFace(r: Readings, width = 48): Face {
  const { c, ctx } = r
  const L = ctx.locale
  const textW = Math.max(12, width)
  /** A sentence whole where it fits, else its short form: never a word cut in half. */
  const either = (key: Key, short: Key, params: Params = {}) => {
    const full = t(L, key, params)
    return displayWidth(full) <= textW ? full : t(L, short, params)
  }
  const shift = c.shift.state === 'showing'
  const list = isListLive(c.tasks, c.turn?.n ?? c.turnCount) ? progressOf(c.tasks) : undefined
  /** The words after the pond: how long the wait has lasted, else the time left. */
  const tailOf = (eta: Eta | undefined, room: number): string => (r.wait ? ` ${waitWords(r.wait, ctx.now, L, room - 1)}` : eta ? ` ${etaWords(eta, L, isAskingAgain(c, ctx.now))}` : '')
  if (list) {
    const title = list.isComplete
      ? t(L, 'hero.complete', { total: list.total })
      : (list.current?.title ?? t(L, 'hero.of', { done: list.done, total: list.total }))
    // The whole work's time left: the list and any part running beside it. A finished list with
    // Claude's agents or jobs still at work is no crossing made: never the flag before a running agent.
    const isAllDone = list.isComplete && !r.isWorkOpen
    const live = isAllDone || !r.eta || r.eta.isDone ? undefined : r.eta
    const tail = isAllDone ? '' : tailOf(live, textW - 4)
    const meter = Math.max(4, Math.min(METER_MAX, textW - displayWidth(tail)))
    const [lit, rest] = segments(list.done / list.total, meter)
    const line2: Line = shift
      ? [{ text: fit(either('hero.shift', 'hero.shiftShort'), textW), tone: 'warn' }]
      : [{ text: lit, ...(list.isComplete ? { tone: 'ok' as const } : {}) }, { text: rest, tone: 'muted' }, ...(tail ? [{ text: tail, ...(r.wait ? { tone: 'accent' as const } : { tone: 'muted' as const }) }] : [])]
    const lead: Span = list.isComplete ? { text: '✓ ', tone: 'ok' } : { text: list.isCurrentRunning ? '▸ ' : '· ', tone: list.isCurrentRunning ? 'accent' : 'muted' }
    // The duck crosses the time the work takes; with no pace measured yet, the tasks done.
    const fraction = isAllDone ? 1 : (r.eta && !r.eta.isDone ? r.eta.fraction : Math.min(list.done / list.total, 0.95))
    const pond = !shift && meter >= MIN_POND_COLUMNS ? { columns: meter, fraction, tail: tail ? [{ text: tail, ...(r.wait ? { tone: 'accent' as const } : { tone: 'muted' as const }) }] : [] } : undefined
    return {
      ...face(
        'progress',
        [[lead, { text: fit(title, textW - 2), bold: true }], line2],
        list.isComplete ? 'ok' : 'none',
        undefined,
        { text: `${list.done}/${list.total}`, ...(list.isComplete ? { tone: 'ok' as const } : {}) },
        textW,
      ),
      ...(pond ? { pond } : {}),
    }
  }
  // No list: what the turn is doing, and once it runs long with no estimate, how it compares with your turns.
  const turn = c.turn
  const last = c.history.at(-1)
  const background = !turn && r.isWorking ? workName(r, textW - 2) : undefined
  let line2: Line
  if (turn) {
    const count = t(L, 'hero.turn', { n: turn.n, tools: toolsText(turn.tools, L) })
    const both = r.fact ? `${count} · ${factText(r.fact, L)}` : count
    // The fact before the count when both do not fit (it is the news), short where it must be.
    line2 = [{ text: displayWidth(both) <= textW ? both : ((r.fact ? factText(r.fact, L, textW) : undefined) ?? count), tone: 'muted' }]
  } else if (background) {
    // Its name is the first line's: the second says how long it has run, and that no end is known
    // (where nothing has one), or in a narrow tile that it runs in the background, or that it runs.
    const item = workItem(r)
    const time = formatMinutes(ctx.now - (item?.from ?? ctx.now))
    const said = [...(r.eta ? [] : [t(L, 'eta.openShort', { time })]), t(L, 'job.running', { time }), t(L, 'inst.agentFor', { time })]
    line2 = [{ text: said.find(text => displayWidth(text) <= textW) ?? t(L, 'inst.agentFor', { time }), tone: 'muted' }]
  } else if (last) {
    const parts = { elapsed: formatMinutes(turnLength(last)), tools: toolsText(last.tools, L), age: formatAge(ctx.now - last.endedAt, L) }
    // In a narrow tile the age goes whole, then the tools: a word cut in half reads worse than none.
    const text = [t(L, 'hero.last', parts), t(L, 'hero.lastShort', parts)].find(line => displayWidth(line) <= textW) ?? t(L, 'hero.lastShortest', parts)
    line2 = [{ text, tone: 'muted' }]
  } else line2 = [{ text: c.joinedLate ? either('hero.watching', 'hero.watchingShort', { time: clockText(c.startedAt) }) : either('hero.fresh', 'hero.freshShort'), tone: 'muted' }]
  if (r.wait && !r.eta) line2 = [{ text: waitWords(r.wait, ctx.now, L, textW), tone: 'accent' }]
  if (shift) line2 = [{ text: either('hero.shift', 'hero.shiftShort'), tone: 'warn' }]
  const idle = c.phase.kind === 'idle' && !background
  const lead: Span = idle ? { text: '○ ', tone: 'muted' } : { text: '▸ ', tone: 'accent' }
  const head = background ?? phaseText(c.phase, L)
  const base = face('progress', [[lead, { text: fit(head, textW - 2), bold: !idle }], line2.map(s => ({ ...s, text: fit(s.text, textW) }))], 'none', undefined, undefined, textW)
  // Agents or jobs of a known length, or the AI's answer, with no list: the duck crosses their time instead.
  const eta = r.eta && !r.eta.isDone && !shift ? r.eta : undefined
  if (!eta) return base
  const tail = tailOf(eta, textW - MIN_POND_COLUMNS)
  const columns = Math.min(METER_MAX, textW - displayWidth(tail))
  const tailSpan: Span = { text: tail, ...(r.wait ? { tone: 'accent' as const } : { tone: 'muted' as const }) }
  // No room for the pond: the time left alone where it fits, which says more than the turn's count.
  if (columns < MIN_POND_COLUMNS) return displayWidth(tail.trim()) <= textW ? { ...base, lines: [base.lines[0], [{ ...tailSpan, text: tail.trim() }]] } : base
  return { ...base, lines: [base.lines[0], [{ text: '~'.repeat(columns), tone: 'muted' }, tailSpan]], pond: { columns, fraction: eta.fraction, tail: [tailSpan] } }
}

// ----------------------------------------------------------------- gauges

export function paceFace(r: Readings): Face {
  const L = r.ctx.locale
  const p = r.pace
  const tone = toneOf(p.level)
  const line1: Line = [{ text: t(L, 'pace.perHour', { tokens: formatTokens(p.perHour) }), bold: true, ...(tone ? { tone } : {}) }]
  if (p.hasData && p.ratio !== undefined) line1.push({ text: ` ${p.ratio.toFixed(1)}×`, tone: 'muted' })
  let line2: Line = [band(r, 'band.pace')]
  if (p.hasData && p.eta?.kind === 'empties') line2 = [{ text: t(L, 'band.empties', { time: clockText(p.eta.at) }), tone: 'warn' }]
  else if (p.hasData && p.eta?.kind === 'holds') line2 = [band(r, 'band.pace'), { text: ` · ${t(L, 'band.holds')}`, tone: 'muted' }]
  const graphic: Graphic = {
    kind: 'dial',
    cols: 9,
    rows: 2,
    isGrey: !p.hasData || p.needle === undefined,
    warnFrom: 0.75,
    badFrom: 0.9,
    ...(p.needle !== undefined ? { needle: p.needle } : {}),
  }
  return face('pace', [line1, line2], p.level, graphic)
}

/**
 * Context: the ring is the window's fill; its colour, and the second line,
 * how near the context is to the point Claude Code compacts it by itself.
 */
export function contextFace(r: Readings): Face {
  const fill = contextNow(r.c)
  const pct = fill.pct
  const level = contextLevel(contextShare(fill))
  const tone = toneOf(level)
  let line2: Line
  if (fill.autoCompact !== undefined && fill.tokens !== undefined) {
    line2 = [{ text: t(r.ctx.locale, 'ctx.toCompact', { left: formatTokens(Math.max(0, fill.autoCompact - fill.tokens)) }), tone: 'muted' }]
  } else {
    line2 = [band(r, 'band.ctx')]
    if (fill.tokens !== undefined) line2.push({ text: ` ${formatTokens(fill.tokens)}`, tone: 'muted' })
  }
  if (r.c.compactions > 0) line2.push({ text: ` ${t(r.ctx.locale, 'ctx.compactions', { n: r.c.compactions })}`, tone: 'muted' })
  const graphic: Graphic = { kind: 'ring', cols: 6, rows: 2, level, ...(pct !== undefined ? { pct } : {}) }
  return face('context', [[{ text: formatPercent(pct), bold: true, ...(tone ? { tone } : {}) }], line2], level, graphic)
}

/**
 * Where a window is heading, after its percent: `→ ~31%` at its reset, or
 * `→ full ~16:43` when it runs out first (`→ full in ~2d19h` when that is
 * more than 12 hours off, as the 7-day window's can be); nothing while the
 * forecast says no more than a point.
 */
export function projectionSpans(w: Window, f: Forecast | undefined, L: Locale, now: number): Span[] {
  if (!f || f.atReset === undefined) return []
  if (f.emptiesAt !== undefined) {
    const words = f.emptiesAt - now >= 12 * 60 * 60_000 ? t(L, 'limits.fullIn', { in: formatCountdown(f.emptiesAt - now) }) : t(L, 'limits.full', { time: clockText(f.emptiesAt) })
    return [{ text: ` → ${words}`, tone: 'warn' }]
  }
  if (f.atReset - w.pct < 1) return []
  return [{ text: ` → ~${formatPercent(Math.min(100, f.atReset))}`, tone: 'muted' }]
}

export function windowLine(name: string, w: Window | undefined, f: Forecast | undefined, level: Level, now: number, L: Locale, meter = 5): Line {
  const empty = '▱'.repeat(meter)
  if (!w) return [{ text: `${name} `, tone: 'muted' }, { text: `${empty}    —`, tone: 'muted' }]
  // Its reset has come: the reading is about a window that is over.
  if (isReset(w, now)) return [{ text: `${name} `, tone: 'muted' }, { text: `${empty} ${t(L, 'limits.reset')}`, tone: 'muted' }]
  const [lit, ahead, left] = projectedSegments(w.pct / 100, (f?.atReset ?? w.pct) / 100, meter)
  const tone = toneOf(level)
  const line: Line = [
    { text: `${name} `, tone: 'muted' },
    { text: lit, ...(tone ? { tone } : {}) },
    { text: ahead + left, tone: 'muted' },
    { text: ` ${formatPercent(w.pct).padStart(4)}`, bold: true, ...(tone ? { tone } : {}) },
    ...projectionSpans(w, f, L, now),
  ]
  if (w.resetsAt !== undefined) line.push({ text: ` ↻${formatCountdown(w.resetsAt - now)}`, tone: 'muted' })
  return line
}

export function limitsFace(r: Readings): Face {
  const five = r.c.reading?.fiveHour
  const seven = r.c.reading?.sevenDay
  const now = r.ctx.now
  const fiveL = fiveHourLevel(five, now)
  const sevenL = sevenDayLevel(seven, now)
  if (!five && !seven) {
    return face('limits', [[{ text: '—', tone: 'muted' }], [band(r, 'band.limits'), { text: ` · ${t(r.ctx.locale, 'limits.none')}`, tone: 'muted' }]], 'none')
  }
  return face(
    'limits',
    [windowLine('5h', five, fiveHourForecast(r.c), fiveL, now, r.ctx.locale), windowLine('7d', seven, sevenDayForecast(r.c), sevenL, now, r.ctx.locale)],
    worse(fiveL, sevenL),
  )
}

/** The latest check that finished, else the one running. */
export function latestCheck(c: Cockpit): CheckResult | undefined {
  return c.checks.at(-1)
}

/**
 * The check the band and the pane show: one running, as it runs; else, while
 * a kind of check is failing, the run that failed it (so the cell says what
 * the duck says, with its age); else the latest run.
 */
export function shownCheck(c: Cockpit): CheckResult | undefined {
  const latest = c.checks.at(-1)
  if (!latest || latest.status === 'running') return latest
  // A check running in the background shows first too: it is the run that decides whether a failure stands.
  if (latest.status === 'background' && c.jobs.some(j => j.toolUseId === latest.id && j.status === 'running')) return latest
  const failure = c.failures.at(-1)
  if (!failure) return latest
  // The run that failed it, while the session still keeps it; else its record stands in.
  const run = c.checks.findLast(ch => ch.status === 'fail' && ch.endedAt === failure.at && judgedKinds(ch).includes(failure.kind))
  return run ?? { id: `failure-${failure.kind}`, kind: failure.kind, command: failure.command, status: 'fail', startedAt: failure.at, endedAt: failure.at, turn: 0, ...(failure.replayed ? { replayed: true as const } : {}) }
}

/** The kinds a check names, `types+tests` for a chain (those it failed, when its output said). */
export function kindsText(check: CheckResult, L: Locale): string {
  const kinds = check.status === 'fail' ? judgedKinds(check) : kindsOf(check)
  return kinds.map(kind => t(L, `kind.${kind}`)).join('+')
}

export function checkSummary(check: CheckResult, L: Locale): string {
  if (check.status === 'running') return t(L, 'checks.running')
  if (check.status === 'interrupted') return t(L, 'checks.interrupted')
  if (check.status === 'hidden') return t(L, 'checks.hidden')
  if (check.status === 'background') return t(L, 'checks.background')
  const parts: string[] = []
  if (check.failed !== undefined && check.failed > 0) parts.push(t(L, 'checks.failed', { n: check.failed }))
  if (check.passed !== undefined) parts.push(t(L, 'checks.passed', { n: check.passed }))
  if (parts.length === 0 && check.errors !== undefined) parts.push(check.errors > 0 ? errorsText(check.errors, L) : t(L, 'checks.clean'))
  // A typecheck or lint that passes quietly is clean; a test run without a summary passed.
  if (parts.length === 0) parts.push(check.status === 'pass' ? t(L, check.kind === 'typecheck' || check.kind === 'lint' ? 'checks.clean' : 'checks.ok') : t(L, 'checks.fail'))
  return parts.join(t(L, 'sep.clause'))
}

/** `2 edits since`: edits no passing check has seen, when there are any. */
export function editsSinceText(c: Cockpit, L: Locale): string | undefined {
  const open = unverified(c)
  if (!open || open.count === 0) return undefined
  return open.count === 1 ? t(L, 'checks.editSince') : t(L, 'checks.editsSince', { n: open.count })
}

/** How long ago a check ended; a check rebuilt from a transcript ran "earlier". */
export function checkAge(check: CheckResult, now: number, L: Locale): string {
  return check.replayed ? t(L, 'resume.before') : formatAge(now - (check.endedAt ?? check.startedAt), L)
}

/** What the band says of a check: the failures when there are, else the passes. */
function checkHeadline(check: CheckResult, L: Locale): string {
  if (check.status === 'fail' && check.failed !== undefined && check.failed > 0) return t(L, 'checks.failed', { n: check.failed })
  if (check.status === 'fail' && check.errors !== undefined && check.errors > 0) return errorsText(check.errors, L)
  return checkSummary(check, L).split(', ')[0] ?? ''
}

/**
 * A check running in the background, in words: `background tests · 2m`, and
 * where `room` allows, how long its command (or its kind) usually takes:
 * `background tests · 2m (usually ~4m)`. Undefined for any other check.
 */
export function backgroundCheckText(r: Readings, check: CheckResult, room = Number.POSITIVE_INFINITY): string | undefined {
  if (check.status !== 'background') return undefined
  const L = r.ctx.locale
  const job = r.c.jobs.find(j => j.toolUseId === check.id)
  const time = formatMinutes(r.ctx.now - (job?.startedAt ?? check.startedAt))
  const head = t(L, 'checks.backgroundRun', { kind: kindsText(check, L), time })
  const expected = job ? r.eta?.jobs.find(j => j.id === job.id) : undefined
  if (job && job.status !== 'running') return head
  const usually = expected ? ` ${t(L, 'checks.usually', { each: formatLeft(expected.typicalMs) })}` : ''
  return displayWidth(head + usually) <= room ? head + usually : head
}

export function checksFace(r: Readings): Face {
  const L = r.ctx.locale
  const check = shownCheck(r.c)
  if (!check) return face('checks', [[{ text: '—', tone: 'muted' }], [band(r, 'band.checks'), { text: ` · ${t(L, 'checks.none')}`, tone: 'muted' }]], 'none')
  const level: Level = check.status === 'fail' ? 'bad' : check.status === 'pass' ? 'ok' : 'none'
  const mark = check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : check.status === 'running' || check.status === 'background' ? '◌' : check.status === 'hidden' ? '?' : '–'
  const tone = toneOf(level)
  // A check in the background: how long it has run, and how long its command usually takes.
  const background = backgroundCheckText(r, check, 30)
  if (background) {
    const job = r.c.jobs.find(j => j.toolUseId === check.id)
    const expected = job ? r.eta?.jobs.find(j => j.id === job.id) : undefined
    // Its job is known once its call comes back; until then nothing is said of its length.
    const line2: Line = !job ? [] : [{ text: expected ? t(L, 'hero.left', { left: formatLeft(Math.max(0, expected.to - r.ctx.now)) }) : t(L, 'agents.noUsual'), tone: 'muted' }]
    return face('checks', [[{ text: `${mark} ${background}`, bold: true }], line2], level)
  }
  const line1: Line = [{ text: `${mark} ${checkHeadline(check, L)}`, bold: true, ...(tone ? { tone } : {}) }]
  if (check.durationMs !== undefined && check.status !== 'running') line1.push({ text: ` ${formatDuration(check.durationMs)}`, tone: 'muted' })
  return face('checks', [line1, [{ text: `${kindsText(check, L)} · ${checkWhen(r, check)}`, tone: 'muted' }]], level)
}

/** When the check shown ran: its time so far while it runs; after a pass, the edits made since (if any); else its age. */
export function checkWhen(r: Readings, check: CheckResult): string {
  const L = r.ctx.locale
  if (check.status === 'running') return formatMinutes(r.ctx.now - check.startedAt)
  // After a pass, what was edited since matters more than how long ago it was.
  const since = check.status === 'pass' ? editsSinceText(r.c, L) : undefined
  return since ?? checkAge(check, r.ctx.now, L)
}

export function costFace(r: Readings): Face {
  const L = r.ctx.locale
  const c = r.c
  const session = c.reading?.costUsd
  const last = c.history.at(-1)
  const turnUsd = c.turn ? liveTurnUsd(c) : last?.costUsd
  const runaway = !c.turn && last?.runaway === true
  const level: Level = runaway ? 'warn' : 'none'
  const line1: Line = [{ text: formatUsd(session), bold: true }]
  // A turn with no figure yet (the ledger has not moved since it began) says "—", never "$0".
  if (turnUsd !== undefined || c.turn || last) line1.push({ text: ` · ${t(L, 'band.turn', { usd: formatUsd(turnUsd) })}`, ...(runaway ? { tone: 'warn' as const } : { tone: 'muted' as const }) })
  const values = c.history.slice(-10).map(h => h.tokens)
  const line2: Line = values.length > 0 ? [{ text: sparkline(values), ...(runaway ? { tone: 'warn' as const } : {}) }, { text: ` ${t(L, 'band.perTurn')}`, tone: 'muted' }] : [band(r, 'band.cost')]
  return face('cost', [line1, line2], level)
}

export function agentsFace(r: Readings): Face {
  const L = r.ctx.locale
  const running = r.c.agents.filter(a => a.status === 'running' || a.status === 'background')
  const done = r.c.agents.filter(a => a.status === 'done').length
  const line1: Line = [{ text: running.length > 0 ? t(L, 'agents.running', { n: running.length }) : t(L, 'agents.none'), bold: running.length > 0, ...(running.length > 0 ? {} : { tone: 'muted' as const }) }]
  const first = running[0]
  const line2: Line = first
    ? [{ text: fit(`${first.description} ${formatMinutes(r.ctx.now - first.startedAt)}`, 26), tone: 'muted' }]
    : [band(r, 'band.agents'), { text: done > 0 ? ` · ${t(L, 'agents.done', { n: done })}` : '', tone: 'muted' }]
  return face('agents', [line1, line2], 'none')
}

export function filesFace(r: Readings): Face {
  const L = r.ctx.locale
  const files = [...r.c.files].sort((a, b) => b.edits - a.edits || b.lastAt - a.lastAt)
  if (files.length === 0) return face('files', [[{ text: '—', tone: 'muted' }], [band(r, 'band.files'), { text: ` · ${t(L, 'files.none')}`, tone: 'muted' }]], 'none')
  const edits = files.reduce((sum, f) => sum + f.edits, 0)
  const line1: Line = [{ text: filesText(files.length, edits, L), bold: true }]
  const line2: Line = [{ text: fit(files.slice(0, 2).map(f => `${baseName(f.path)} ×${f.edits}`).join(' · '), 28), tone: 'muted' }]
  return face('files', [line1, line2], 'none')
}

/**
 * A model as the status line names it: `claude-opus-5-5` is `Opus 5.5`,
 * `claude-haiku-4-5-20251001` is `Haiku 4.5`, a 1M context `[1m]` is ` 1M`;
 * any other name loses only its `claude-`.
 */
export function prettyModel(model: string | undefined): string | undefined {
  if (!model || model.trim() === '') return undefined
  const wide = /\[1m\]$/i.test(model) ? ' 1M' : ''
  const id = model.replace(/\[1m\]$/i, '').trim().replace(/^claude-/, '')
  const named = /^(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id)
  if (!named) return `${id}${wide}`
  const [, family = '', major, minor] = named
  return `${family[0]?.toUpperCase() ?? ''}${family.slice(1)} ${major}${minor !== undefined ? `.${minor}` : ''}${wide}`
}

/** The session's model: as `$.session.model()` last said it, else as the main loop's last response named it. */
export function modelOf(c: Cockpit): string | undefined {
  return prettyModel(c.meta.model) ?? prettyModel(c.lastStep?.model)
}

export function sessionFace(r: Readings): Face {
  const L = r.ctx.locale
  const meta = r.c.meta
  const line1: Line = [{ text: fit([modelOf(r.c), meta.effort].filter(Boolean).join(' · ') || '—', 26), bold: true }]
  const bits = [meta.mode, t(L, 'session.elapsed', { elapsed: formatMinutes(r.ctx.now - r.c.startedAt) })].filter((x): x is string => typeof x === 'string' && x !== '')
  return face('session', [line1, [{ text: fit(bits.join(' · '), 26), tone: 'muted' }]], 'none')
}

/**
 * Health: the score and its word, coloured only past a threshold (amber under
 * 70, red under 50), and its weakest part in a few words. A judgement from
 * measured parts: the pane lists them, one press away.
 */
export function healthFace(r: Readings): Face {
  const L = r.ctx.locale
  const h = r.health
  const head = band(r, 'band.health')
  if (!h.isMeasuring) return face('health', [[{ text: '—', tone: 'muted' }], [head, { text: ` · ${t(L, 'health.hint.none')}`, tone: 'muted' }]], 'none')
  const tone = toneOf(h.level)
  return face('health', [[{ text: `${h.score} ${wordText(h.word, L)}`, bold: true, ...(tone ? { tone } : {}) }], [head, { text: ` · ${fit(weakestHint(h, L), 24)}`, tone: 'muted' }]], h.level)
}

export function tileFace(r: Readings, id: TileId, heroWidth?: number): Face {
  switch (id) {
    case 'progress':
      return heroFace(r, heroWidth)
    case 'pace':
      return paceFace(r)
    case 'context':
      return contextFace(r)
    case 'limits':
      return limitsFace(r)
    case 'checks':
      return checksFace(r)
    case 'cost':
      return costFace(r)
    case 'agents':
      return agentsFace(r)
    case 'files':
      return filesFace(r)
    case 'session':
      return sessionFace(r)
    case 'health':
      return healthFace(r)
  }
}

/** A one-row tachometer of `n` bars, lit up to the needle: the compact pace gauge. */
function miniRamp(p: PaceReading, n = 4): Span[] {
  const bars = '▂▄▆█'
  const lit = p.needle === undefined ? 0 : Math.max(p.needle > 0 ? 1 : 0, Math.round(p.needle * n))
  return Array.from({ length: n }, (_, i): Span => {
    const f = (i + 0.5) / n
    const tone: Tone | undefined = i >= lit ? 'track' : !p.hasData ? 'grey' : f >= 0.9 ? 'bad' : f >= 0.75 ? 'warn' : undefined
    return { text: bars[Math.min(bars.length - 1, Math.floor((i * bars.length) / n))] ?? '█', ...(tone ? { tone } : {}) }
  })
}

/**
 * A tile's face when the band is short of room: no picture, the ring as one
 * glyph (◔◑◕●), the tachometer as one row, the limits without their meters.
 * Tiles that are text already keep their face.
 */
export function compactFace(r: Readings, id: TileId): Face {
  const L = r.ctx.locale
  const full = tileFace(r, id)
  switch (id) {
    case 'pace': {
      const [value, ...rest] = full.lines[0]
      const line1: Line = [...miniRamp(r.pace), { text: ' ' }, ...(value ? [value] : []), ...rest]
      return face('pace', [line1, full.lines[1]], full.level)
    }
    case 'context': {
      const fill = contextNow(r.c)
      const pct = fill.pct
      const tone = toneOf(contextLevel(contextShare(fill)))
      const line1: Line = [{ text: `${ringGlyph(pct)} `, ...(tone ? { tone } : {}) }, ...full.lines[0]]
      return face('context', [line1, full.lines[1]], full.level)
    }
    case 'limits': {
      const five = r.c.reading?.fiveHour
      const seven = r.c.reading?.sevenDay
      if (!five && !seven) return full
      const short = (name: string, w: Window | undefined, level: Level): Line => {
        if (!w) return [{ text: `${name} —`, tone: 'muted' }]
        if (isReset(w, r.ctx.now)) return [{ text: `${name} ${t(L, 'limits.reset')}`, tone: 'muted' }]
        const tone = toneOf(level)
        return [{ text: `${name} `, tone: 'muted' }, { text: formatPercent(w.pct), bold: true, ...(tone ? { tone } : {}) }, ...(w.resetsAt !== undefined ? [{ text: ` ↻${formatCountdown(w.resetsAt - r.ctx.now)}`, tone: 'muted' as const }] : [])]
      }
      return face('limits', [short('5h', five, fiveHourLevel(five, r.ctx.now)), short('7d', seven, sevenDayLevel(seven, r.ctx.now))], full.level)
    }
    case 'checks': {
      const check = shownCheck(r.c)
      if (!check) return full
      return face('checks', [[...full.lines[0].slice(0, 1)], [{ text: `${kindsText(check, L)} · ${checkWhen(r, check)}`, tone: 'muted' }]], full.level)
    }
    case 'cost': {
      const values = r.c.history.slice(-6).map(h => h.tokens)
      return face('cost', [[...full.lines[0].slice(0, 1)], values.length > 0 ? [{ text: sparkline(values) }] : full.lines[1]], full.level)
    }
    default:
      return full
  }
}

// ----------------------------------------------------------------- the duck

/** The columns the duck's caution may take beside it in the band: `5h window at 84%` whole. */
export const DUCK_WORDS = 16

/** The Master Caution cell: the duck alone while idle; raised, with "Quack:", on a caution. */
export function duckFace(r: Readings): Face {
  const L = r.ctx.locale
  const { duck } = r
  const graphic: Graphic = { kind: 'duck', cols: DUCK_COLUMNS, rows: 2, pose: duck.pose }
  if (duck.pose === 'idle' || !duck.caution) return face('duck', [[], []], 'none', graphic, undefined, 0)
  const tone: Tone = duck.caution.level === 'bad' ? 'bad' : 'warn'
  return face('duck', [[{ text: t(L, 'duck.quack'), tone, bold: true }], [{ text: cautionFit(duck.caution, L, DUCK_WORDS), tone }]], duck.caution.level, graphic)
}

// ----------------------------------------------------------------- one dense row

/** One tile's words for the dense row: the reading alone. */
export function compactOf(r: Readings, id: TileId): Line {
  const L = r.ctx.locale
  const c = r.c
  switch (id) {
    case 'progress': {
      const list = isListLive(c.tasks, c.turn?.n ?? c.turnCount) ? progressOf(c.tasks) : undefined
      if (list) {
        return [{ text: `${list.done}/${list.total}`, bold: true, ...(list.isComplete ? { tone: 'ok' as const } : {}) }, { text: ` ${fit(list.current?.title ?? '', 28)}` }]
      }
      return [{ text: fit(phaseText(c.phase, L), 30), ...(c.phase.kind === 'idle' ? { tone: 'muted' as const } : {}) }]
    }
    case 'pace': {
      const tone = toneOf(r.pace.level)
      return [{ text: t(L, 'pace.perHour', { tokens: formatTokens(r.pace.perHour) }), ...(tone ? { tone } : {}) }]
    }
    case 'context': {
      const fill = contextNow(c)
      const pct = fill.pct
      const tone = toneOf(contextLevel(contextShare(fill)))
      return [{ text: `${ringGlyph(pct)} ${formatPercent(pct)}`, ...(tone ? { tone } : {}) }]
    }
    case 'limits': {
      const five = c.reading?.fiveHour
      if (!five) return [{ text: '5h —', tone: 'muted' }]
      if (isReset(five, r.ctx.now)) return [{ text: `5h ${t(L, 'limits.reset')}`, tone: 'muted' }]
      const tone = toneOf(fiveHourLevel(five, r.ctx.now))
      return [{ text: `5h ${formatPercent(five.pct)}`, ...(tone ? { tone } : {}) }, ...(five.resetsAt !== undefined ? [{ text: ` ↻${formatCountdown(five.resetsAt - r.ctx.now)}`, tone: 'muted' as const }] : [])]
    }
    case 'checks': {
      const check = shownCheck(c)
      if (!check) return [{ text: `${t(L, 'tile.checks').toLowerCase()} —`, tone: 'muted' }]
      const mark = check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : check.status === 'hidden' ? '?' : '◌'
      const tone: Tone | undefined = check.status === 'pass' ? 'ok' : check.status === 'fail' ? 'bad' : undefined
      return [{ text: `${mark} ${kindsText(check, L)}`, ...(tone ? { tone } : {}) }]
    }
    case 'cost':
      return [{ text: formatUsd(c.reading?.costUsd) }]
    case 'agents': {
      const n = c.agents.filter(a => a.status === 'running' || a.status === 'background').length
      return [{ text: t(L, 'agents.running', { n }), tone: n > 0 ? 'accent' : 'muted' }]
    }
    case 'files':
      return [{ text: filesText(c.files.length, c.files.reduce((s, f) => s + f.edits, 0), L), tone: 'muted' }]
    case 'session':
      return [{ text: modelOf(c) ?? '—', tone: 'muted' }]
    case 'health': {
      if (!r.health.isMeasuring) return [{ text: `${t(L, 'band.health')} —`, tone: 'muted' }]
      const tone = toneOf(r.health.level)
      return [{ text: `${r.health.score} ${wordText(r.health.word, L)}`, ...(tone ? { tone } : {}) }]
    }
  }
}

/**
 * The whole band as one row: the duck's caution first, then each tile's
 * reading in order. The hero's title takes the room the others leave; when
 * even that is short, tiles drop from the end.
 */
export function denseLine(r: Readings, tiles: readonly TileId[], width: number, withDuck: boolean): Line {
  const L = r.ctx.locale
  const head: Line = []
  if (withDuck && r.duck.pose === 'alert' && r.duck.caution) {
    const tone: Tone = r.duck.caution.level === 'bad' ? 'bad' : 'warn'
    head.push({ text: `${t(L, 'duck.quack')} ${cautionText(r.duck.caution, L)}`, tone, bold: true })
  }
  const sep: Span = { text: ' · ', tone: 'muted' }
  const parts = tiles.map(id => ({ id, line: compactOf(r, id) })).filter(p => p.line.length > 0)
  const sepW = lineWidth([sep])
  const used = (list: typeof parts, heroText: number) =>
    lineWidth(head) +
    list.reduce((sum, p, i) => sum + (i > 0 || head.length > 0 ? sepW : 0) + (p.id === 'progress' ? heroText : lineWidth(p.line)), 0)
  // The hero's reading is its count and as much of its title as fits.
  const heroLine = (room: number): Line => {
    const hero = parts.find(p => p.id === 'progress')?.line ?? []
    const [count, title] = hero
    if (!count) return hero
    if (!title) return [count]
    const left = room - displayWidth(count.text)
    return left >= 6 ? [count, { ...title, text: fit(title.text, left) }] : [count]
  }
  let kept = parts
  const heroBase = (line: Line) => displayWidth(line[0]?.text ?? '')
  while (kept.length > 1 && used(kept, heroBase(heroLine(0))) > width) kept = kept.slice(0, -1)
  const room = width - used(kept, 0)
  const out: Line = [...head]
  kept.forEach((p, i) => {
    if (i > 0 || head.length > 0) out.push(sep)
    out.push(...(p.id === 'progress' ? heroLine(Math.min(room, 40)) : p.line))
  })
  return fitLine(out, width)
}

// ----------------------------------------------------------------- the turn's receipt

/**
 * A main turn's receipt, after Claude Code's own `Baked for 1m 4s`: its new
 * tokens, its cost when the ledger priced it, and how each kind of check it
 * ran last came out (`48k · $0.41 · tests ✓`). The turn is the one whose end
 * reported this duration; none matches a turn quackpit did not see.
 */
export function receiptText(c: Cockpit, durationMs: number, L: Locale): string | undefined {
  const record = c.history.findLast(h => h.durationMs === durationMs)
  if (!record) return undefined
  const parts = [t(L, 'receipt.tokens', { tokens: formatTokens(record.tokens) })]
  if (record.costUsd !== undefined) parts.push(formatUsd(record.costUsd))
  // Each kind the turn checked, as its last run of that kind came out: a chain is a run of each.
  const latest = new Map<string, CheckResult['status']>()
  for (const check of c.checks) if (check.turn === record.n && (check.status === 'pass' || check.status === 'fail')) for (const kind of judgedKinds(check)) latest.set(kind, check.status)
  const verdicts = [...latest.entries()].map(([kind, status]) => `${t(L, `kind.${kind as CheckKind}`)} ${status === 'pass' ? '✓' : '✗'}`)
  if (verdicts.length > 0) parts.push(verdicts.join(' '))
  return parts.join(' · ')
}

