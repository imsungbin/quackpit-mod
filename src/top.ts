// The pane's top section: progress, which is quackpit's ETA, across the
// pane's whole width above the pace dials. While work runs it is the task
// list's count in big digits, the duck crossing a pond to its flag, the time
// left and when the work should be done, and what that estimate rests on
// (the parts that end last first, the AI's guess named as the AI's); with
// nothing to estimate, what the turn is doing and how it compares with your
// turns. While the main loop waits on the person the time left gives way to
// how long it has waited, and nothing counts down. Work Claude comes back to
// keeps it working after the turn ends. Between turns it shrinks to a line or
// two. The estimate appears here once: the timeline tab draws the tasks on
// its axis without it. Host-neutral lines; the adapter draws them. Pure.

import type { AiPart, Eta } from './eta'
import { digitColumns } from './font'
import { clockText, formatAge, formatLeft, formatMinutes, formatSpan } from './format'
import { ordinal, t, type Locale } from './i18n'
import { jobName } from './jobs'
import { turnLength, type Cockpit } from './model'
import { MIN_BIG_POND_COLUMNS, MIN_POND_COLUMNS } from './pond'
import { isListLive, progressOf } from './progress'
import { displayWidth, fit, fitLine, lineWidth, plain, type Line, type Span, type Tone } from './text'
import { etaWords, factText, isAskingAgain, openWords, phaseText, quietLine, toolsText, waitWords, workItem, workName, type Readings, type WorkItem } from './tiles'
import { openWaits, type Wait } from './waits'

const muted = (text: string): Span => ({ text, tone: 'muted' })

/** The top section, ready to draw. */
export type TopSection = {
  /** Its first line: the lead mark and what is being done, the turn's count at the far end. */
  head: Line
  /**
   * While work runs with something to cross: the list's count in big digits,
   * the pond `columns` wide with the duck `fraction` across, and the two
   * words beside it (the time left and when it should be done, or how long
   * the work has waited on the person).
   */
  pond?: { digits?: { text: string; tone?: Tone }; columns: number; fraction: number; words: [Line, Line] }
  /** What the wait is, what the estimate rests on, what runs with no length known, the fact, the shift hint: a line each. */
  under: Line[]
}

/** The AI's part in words: `Haiku's guess at 14:02`, a revision's `Haiku's 2nd guess at 14:05 (1st ~2m)`. */
function aiBasis(ai: AiPart, L: Locale): string {
  if (ai.n > 1 && ai.first) return t(L, 'eta.aiAskedN', { nth: ordinal(ai.n, L), time: clockText(ai.askedAt), first: formatLeft(ai.first.leftMs) })
  return t(L, 'eta.aiAsked', { time: clockText(ai.askedAt) })
}

/**
 * What the estimate rests on, in one line: each part with an end, the one
 * that ends last first: the tasks open at their pace, a job's command's usual
 * length (or its kind of check's), an agent type's usual length (or every
 * type's), and the AI's guess, which says it is not measured.
 */
export function etaBasis(c: Cockpit, eta: Eta, L: Locale): Line {
  const parts: { to: number; text: string }[] = []
  if (eta.tasks) {
    const last = Math.max(...eta.tasks.stretches.map(s => s.to))
    parts.push({ to: last, text: `${t(L, 'eta.tasks', { n: eta.tasks.open, each: formatLeft(eta.tasks.pace.ms) })} · ${t(L, eta.tasks.pace.basis === 'list' ? 'eta.listPace' : 'eta.recentPace')}` })
  }
  for (const j of eta.jobs) {
    const job = c.jobs.find(x => x.id === j.id)
    const name = fit(job ? jobName(job) : j.id, 32)
    const each = formatLeft(j.typicalMs)
    const text = j.basis === 'kind' ? t(L, 'eta.jobKind', { kind: t(L, `kind.${j.kind ?? 'test'}`), each }) : j.samples === 1 ? t(L, 'eta.jobOnce', { name, each }) : t(L, 'eta.job', { name, each })
    parts.push({ to: j.to, text })
  }
  for (const a of eta.agents) {
    const run = c.agents.find(x => x.id === a.id)
    const type = run?.type === 'general-purpose' ? 'general' : (run?.type ?? '')
    parts.push({ to: a.to, text: a.basis === 'type' ? t(L, 'eta.agentType', { type, each: formatLeft(a.typicalMs) }) : t(L, 'eta.agentAny', { type, each: formatLeft(a.typicalMs) }) })
  }
  if (eta.ai) parts.push({ to: eta.ai.to, text: `${aiBasis(eta.ai, L)} · ${t(L, 'eta.aiGuess')}` })
  // Agents of one type say it once.
  const seen = new Set<string>()
  const texts = parts
    .sort((a, b) => b.to - a.to)
    .map(p => p.text)
    .filter(text => (seen.has(text) ? false : (seen.add(text), true)))
  return texts.length > 0 ? [muted(texts.join(' · '))] : []
}

/** A line with `right` set at its far end, the left part cut first; `right` goes where both do not fit. */
function spread(left: Line, right: Line, width: number): Line {
  const room = width - lineWidth(right) - 2
  if (right.length === 0 || room < 12) return fitLine(left, width)
  const head = fitLine(left, room)
  return [...head, { text: ' '.repeat(Math.max(2, width - lineWidth(head) - lineWidth(right))) }, ...right]
}

/** The AI's own end, as a clock time: when the end it said falls, the turn's waits on the person since moving it on. */
function aiSaidAt(eta: Eta): number | undefined {
  const ai = eta.ai
  return ai ? ai.saidAt : undefined
}

/** The time left and when it should be done, beside the pond; the AI's own end once the turn ran past it. */
function etaPair(eta: Eta, L: Locale, c: Cockpit, now: number): [Line, Line] {
  const said = eta.last === 'ai' && eta.ai?.isOver ? aiSaidAt(eta) : undefined
  const done = said !== undefined ? t(L, 'eta.aiSaid', { time: clockText(said) }) : t(L, 'eta.done', { time: clockText(eta.endsAt) })
  return [[{ text: etaWords(eta, L, isAskingAgain(c, now)), bold: true }], [muted(done)]]
}

/** How long the work has waited on the person, beside the pond: nothing counts down meanwhile. */
function waitPair(r: Readings, wait: Wait, eta: Eta | undefined, room: number): [Line, Line] {
  const L = r.ctx.locale
  // Paused only where the wait holds the part that ends last: a background job or agent runs on meanwhile.
  const second = !eta
    ? t(L, 'eta.waitSince', { time: clockText(wait.from) })
    : isHeldBy(r, eta, wait)
      ? t(L, 'wait.paused', { left: formatLeft(eta.leftMs) })
      : etaWords(eta, L, isAskingAgain(r.c, r.ctx.now))
  return [[{ text: waitWords(wait, r.ctx.now, L, room), bold: true, tone: 'accent' }], [muted(second)]]
}

/** Whether a wait holds the part of the estimate that ends last: the main loop's own tasks and the AI's answer, or that agent's run. */
function isHeldBy(r: Readings, eta: Eta, wait: Wait): boolean {
  if (eta.last === 'tasks' || eta.last === 'ai') return wait.main
  if (eta.last !== 'agent') return false
  const last = eta.agents.reduce<(typeof eta.agents)[number] | undefined>((x, a) => (!x || a.to > x.to ? a : x), undefined)
  const run = r.c.agents.find(a => a.id === last?.id)
  return run?.agentId !== undefined && run.agentId === wait.agentId
}

/** What the wait is, in a line: a question, a plan to approve, a permission dialog (and whose). */
export function waitLine(wait: Wait, L: Locale, width: number): Line {
  const tool = wait.tool ?? '—'
  const text =
    wait.kind === 'question'
      ? t(L, 'wait.question')
      : wait.kind === 'plan'
        ? t(L, 'wait.plan')
        : wait.agentId !== undefined
          ? t(L, 'wait.agentPermission', { agent: wait.agentType ?? 'subagent', tool })
          : t(L, 'wait.permission', { tool })
  return [{ text: fit(text, width), tone: 'muted' }]
}

/** A subagent's dialog that does not hold the main loop: it waits, the rest goes on. */
function asideLines(r: Readings, width: number): Line[] {
  const L = r.ctx.locale
  return openWaits(r.c.waits)
    .filter(w => !w.main)
    .slice(0, 1)
    .map(w => [{ text: fit(t(L, 'wait.agentAside', { agent: w.agentType ?? 'subagent', time: formatSpan(Math.max(0, r.ctx.now - w.from)) }), width), tone: 'accent' as const }])
}

/**
 * Parts running with no expected end, a line each (two at most, the rest
 * counted); the one the head names already says only how long it has run.
 */
function openLines(r: Readings, width: number, named?: WorkItem): Line[] {
  const L = r.ctx.locale
  const shown = r.open.slice(0, 2).map(item => [muted(fit(item.id === named?.id ? t(L, 'eta.openShort', { time: formatMinutes(r.ctx.now - item.from) }) : openWords(r, item), width))])
  const more = r.open.length - shown.length
  return more > 0 ? [...shown, [muted(fit(t(L, 'eta.openMore', { n: more }), width))]] : shown
}

/**
 * The top section `width` columns wide. Working (a turn runs, or Claude's
 * agents or background jobs do): the full section. Between turns: a line or two.
 */
export function topSection(r: Readings, width: number): TopSection {
  const { c, ctx } = r
  const L = ctx.locale
  const w = Math.max(20, width)
  const shift = c.shift.state === 'showing'
  const shiftLine: Line[] = shift ? [[{ text: fit(displayWidth(t(L, 'hero.shift')) <= w ? t(L, 'hero.shift') : t(L, 'hero.shiftShort'), w), tone: 'warn' }]] : []
  const list = isListLive(c.tasks, c.turn?.n ?? c.turnCount) ? progressOf(c.tasks) : undefined
  const count: Line = c.turn ? [muted(t(L, 'hero.turn', { n: c.turn.n, tools: toolsText(c.turn.tools, L) }))] : []
  const eta = r.eta && !r.eta.isDone ? r.eta : undefined
  // Teammates idle, agents waiting, a job running aside: one quiet line, never the headline.
  const quiet = quietLine(r, w)
  const quietLines: Line[] = quiet ? [quiet] : []

  if (!r.isWorking) {
    const [first = [], ...rest] = idleLines(r, w)
    return { head: first, under: [...rest, ...quietLines, ...shiftLine] }
  }

  // While the main loop waits on the person: how long, and what it waits for, in place of the time left.
  const wait = r.wait
  const words = (room: number): [Line, Line] => (wait ? waitPair(r, wait, eta, room) : eta ? etaPair(eta, L, c, ctx.now) : [[], []])
  // Between turns with no list, the head names a part of the work: its own line says only how long it has run.
  const named = c.turn || list ? undefined : workItem(r)
  const notes: Line[] = [...(wait ? [waitLine(wait, L, w)] : []), ...asideLines(r, w), ...(eta ? [fitLine(etaBasis(c, eta, L), w)] : []), ...openLines(r, w, named)]

  if (list) {
    const title = list.isComplete ? t(L, 'hero.complete', { total: list.total }) : (list.current?.title ?? t(L, 'hero.of', { done: list.done, total: list.total }))
    const lead: Span = list.isComplete ? { text: '✓ ', tone: 'ok' } : { text: list.isCurrentRunning ? '▸ ' : '· ', tone: list.isCurrentRunning ? 'accent' : 'muted' }
    const digits = { text: `${list.done}/${list.total}`, ...(list.isComplete ? { tone: 'ok' as const } : {}) }
    // The duck crosses the time the work takes; with no pace measured yet, the tasks done. A finished
    // list with Claude's agents or jobs still at work is no crossing made: never the flag before them.
    const fraction = list.isComplete && !r.isWorkOpen ? 1 : eta ? eta.fraction : Math.min(list.done / list.total, 0.95)
    return {
      head: spread([lead, { text: title, bold: true }], count, w),
      ...pondOf(w, fraction, words(Math.floor(w / 2)), digits),
      under: [...notes, ...quietLines, ...shiftLine],
    }
  }

  const lead: Span = { text: '▸ ', tone: 'accent' }
  const doing = c.turn ? phaseText(c.phase, L) : (workName(r, w - 2 - (count.length > 0 ? lineWidth(count) + 2 : 0)) ?? phaseText(c.phase, L))
  const head = spread([lead, { text: doing, bold: true }], count, w)
  if (eta || wait) return { head, ...(eta ? pondOf(w, eta.fraction, words(Math.floor(w / 2))) : {}), under: [...(eta ? [] : [words(w)[0]]), ...notes, ...quietLines, ...shiftLine] }
  // Nothing to estimate: how this turn compares with yours, once it runs long; never a guessed time.
  const fact = r.fact ? factText(r.fact, L, w) : undefined
  return { head, under: [...(fact ? [[muted(fact)]] : []), ...notes, ...quietLines, ...shiftLine] }
}

/** The pond with its words, where it fits beside them; else the words alone, under the head. */
function pondOf(width: number, fraction: number, words: [Line, Line], digits?: { text: string; tone?: Tone }): Pick<TopSection, 'pond'> {
  const digitsW = digits ? digitColumns(digits.text) + 1 : 0
  const wordsW = Math.max(lineWidth(words[0]), lineWidth(words[1]))
  const columns = Math.min(64, width - digitsW - (wordsW > 0 ? wordsW + 1 : 0))
  return { pond: { ...(digits ? { digits } : {}), columns: columns >= MIN_BIG_POND_COLUMNS ? columns : 0, fraction, words } }
}

/**
 * Between turns, a line or two: what stands (the list as it was left, or
 * standing by) and the last turn, on one line where both fit.
 */
function idleLines(r: Readings, width: number): Line[] {
  const { c, ctx } = r
  const L = ctx.locale
  const list = isListLive(c.tasks, c.turnCount) ? progressOf(c.tasks) : undefined
  const first: Line = list
    ? list.isComplete
      ? [{ text: '✓ ', tone: 'ok' }, { text: t(L, 'hero.complete', { total: list.total }), tone: 'ok' }]
      : [{ text: '· ', tone: 'muted' }, { text: `${list.done}/${list.total}`, bold: true }, muted(' · '), { text: list.current?.title ?? '' }]
    : [muted('○ '), { text: t(L, 'phase.idle') }]
  const last = c.history.at(-1)
  const second = last
    ? t(L, 'hero.last', { elapsed: formatMinutes(turnLength(last)), tools: toolsText(last.tools, L), age: formatAge(ctx.now - last.endedAt, L) })
    : c.joinedLate
      ? t(L, 'hero.watching', { time: clockText(c.startedAt) })
      : t(L, 'hero.fresh')
  const both: Line = [...first, muted(` · ${second}`)]
  if (lineWidth(both) <= width) return [both]
  return [fitLine(first, width), [muted(fit(second, width))]]
}

/**
 * The progress in one line, pinned under the view bar outside the overview:
 * the lead mark, the list's count, the band's one-row pond where there is an
 * estimate and room for it, then the time left (or the wait), when it should
 * be done and what is being done. Between turns, what stands and the last
 * turn. The pond gives way first, then the line is cut at its end.
 */
export type Summary = { head: Line; pond?: { columns: number; fraction: number }; tail: Line }

/** The one-row pond's widest and narrowest in the summary. */
const SUMMARY_POND_MAX = 18

export function summaryLine(r: Readings, width: number): Summary {
  const { c, ctx } = r
  const L = ctx.locale
  const w = Math.max(20, width)
  if (!r.isWorking) {
    const [first = []] = idleLines(r, Number.POSITIVE_INFINITY)
    return { head: fitLine(first, w), tail: [] }
  }
  const list = isListLive(c.tasks, c.turn?.n ?? c.turnCount) ? progressOf(c.tasks) : undefined
  const eta = r.eta && !r.eta.isDone ? r.eta : undefined
  const wait = r.wait
  const doing = list ? (list.isComplete ? t(L, 'hero.complete', { total: list.total }) : list.current?.title) : c.turn ? phaseText(c.phase, L) : (workName(r, w) ?? phaseText(c.phase, L))
  const head: Line = wait
    ? [{ text: waitWords(wait, ctx.now, L), bold: true, tone: 'accent' }]
    : list
      ? [{ text: list.isComplete ? '✓ ' : list.isCurrentRunning ? '▸ ' : '· ', tone: list.isComplete ? 'ok' : list.isCurrentRunning ? 'accent' : 'muted' }, { text: `${list.done}/${list.total}`, bold: true, ...(list.isComplete ? { tone: 'ok' as const } : {}) }]
      : [{ text: '▸ ', tone: 'accent' }]
  const left: Span[] = wait
    ? eta
      ? [muted(` · ${isHeldBy(r, eta, wait) ? t(L, 'wait.paused', { left: formatLeft(eta.leftMs) }) : etaWords(eta, L, isAskingAgain(c, ctx.now))}`)]
      : []
    : eta
      ? [{ text: etaWords(eta, L, isAskingAgain(c, ctx.now)), bold: true }, muted(` · ${t(L, 'eta.done', { time: clockText(eta.endsAt) })}`)]
      : []
  const what: Span[] = doing ? [{ text: `${left.length > 0 || list || wait ? ' · ' : ''}${doing}`, ...(list || wait ? {} : { bold: left.length === 0 }) }] : []
  const turn: Span[] = !eta && !wait && c.turn ? [muted(` · ${t(L, 'hero.turn', { n: c.turn.n, tools: toolsText(c.turn.tools, L) })}`)] : []
  const tail: Line = [...left, ...what, ...turn]
  // The pond where an estimate (or the list's count) gives the duck its place, and the line still has room.
  const fraction = list && list.isComplete && !r.isWorkOpen ? 1 : eta ? eta.fraction : list ? Math.min(list.done / list.total, 0.95) : undefined
  const headW = lineWidth(head) + 1
  const room = w - headW - Math.min(lineWidth(left) + 1, 24)
  const columns = Math.min(SUMMARY_POND_MAX, room)
  if (fraction !== undefined && !wait && columns >= MIN_POND_COLUMNS) {
    const pondHead: Line = plain(head).endsWith(' ') ? head : [...head, { text: ' ' }]
    const tailRoom = w - lineWidth(pondHead) - columns - 1
    return { head: pondHead, pond: { columns, fraction }, tail: fitLine([{ text: ' ' }, ...tail.map((s, i) => (i === 0 ? { ...s, text: s.text.replace(/^ · /, '') } : s))], tailRoom) }
  }
  return { head, tail: fitLine(list ? [{ text: ' ' }, ...tail.map((s, i) => (i === 0 ? { ...s, text: s.text.replace(/^ · /, '') } : s))] : tail, w - lineWidth(head)) }
}
