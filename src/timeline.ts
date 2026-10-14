// The pane's timeline tab: TIME (how long the session has run, how long it
// worked, its turns and cost), the prompt cache's clock, then TASKS, the
// waits on the person, AGENTS and BACKGROUND jobs (the AI ETA's tally,
// `aiLines`, sits over the turns tab's table). Each task, agent and job is a
// row with a bar on one shared time axis, in eighth blocks like the pace
// dial, so what ran at once shows at once; the tasks still to come are drawn
// where the estimate expects them, whose time left is the top section's.
// Every agent of the session is listed with who started it, so a count
// elsewhere ("1 agent") explains itself; only Claude's own are in the
// estimate. Everything is in whole minutes or finished lengths: the pane
// redraws every 30 seconds, like the band. Colour is for state alone; green
// only when every task is done. Host-neutral lines of styled spans. Pure.

import { emptyTally, MIN_SCORED, sumTallies, tallyTokens, type AiScore, type AiScores, type AiTally } from './ai'
import { cacheClock, type CacheClock, type Ttl } from './cache'
import { clockText, formatLeft, formatMinutes, formatSpan, formatTokens, formatUsd } from './format'
import { t, type Locale } from './i18n'
import { median } from './metrics'
import { isAgentOpen, isCounted, turnWorkSoFar, type AgentRun, type Cockpit } from './model'
import type { Eta } from './eta'
import { isJobRunning, jobName, type Job } from './jobs'
import type { Wait } from './waits'
import type { Task } from './progress'
import { displayWidth, fit, pad, wrap, type Line, type Span, type Tone } from './text'
import { workOf } from './work'

const muted = (text: string): Span => ({ text, tone: 'muted' })

/** Rows a list shows before the rest fold into one line. */
export const MAX_TASK_ROWS = 6
export const MAX_AGENT_ROWS = 6
/** Below this many columns for the bars, the rows keep their names and lengths and drop the axis. */
const MIN_AXIS = 16

/** 45m, 3h12: the TIME line's lengths. */
export function formatHm(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000))
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`
}

/** One row: a mark, a name, a length, a stretch of time (with a projected part), and words after the axis. */
type Row = { mark: Span; name: string; nameTone?: Tone; length: string; from?: number; to?: number; ahead?: number; barTone?: Tone; detail: Span[] }

/** The axis: where it starts and ends, and how wide its bars are. */
export type Axis = { from: number; to: number; width: number }

const RIGHT = ['', '▕', '▐', '█'] as const
const LEFT = ' ▏▎▍▌▋▊▉█'

/**
 * A stretch of time as a bar on the axis: eighth blocks where it ends inside
 * a cell, a right-hand quarter or half where it starts inside one, and from
 * `ahead` on the projected rest in a light shade.
 */
export function barSpans(axis: Axis, from: number, to: number, tone: Tone | undefined, ahead?: number): Span[] {
  const span = Math.max(1, axis.to - axis.from)
  const x = (at: number) => Math.max(0, Math.min(axis.width, ((at - axis.from) / span) * axis.width))
  const x0 = x(from)
  const x1 = Math.max(x0, x(to))
  const xa = ahead !== undefined ? Math.max(x1, x(ahead)) : x1
  const cells: Span[] = []
  for (let i = 0; i < axis.width; i++) {
    let ch = ' '
    let cellTone: Tone | undefined = tone
    // A stretch still to come has no solid part: it is all projection.
    if (x1 > x0 && x1 > i && x0 < i + 1) {
      if (x0 <= i && x1 >= i + 1) ch = '█'
      else if (x0 > i && x1 >= i + 1) ch = RIGHT[Math.max(1, Math.round((i + 1 - x0) * 3))] ?? '▐'
      else ch = LEFT[Math.max(1, Math.round((x1 - Math.max(i, x0)) * 8))] ?? '▏'
    } else if (x1 === x0 && Math.floor(x0) === i && ahead === undefined) {
      ch = '▏'
    } else if (xa > i && x1 < i + 1 && xa > x1) {
      ch = '░'
      cellTone = 'muted'
    }
    const last = cells.at(-1)
    if (last && last.tone === cellTone) last.text += ch
    else cells.push({ text: ch, ...(cellTone ? { tone: cellTone } : {}) })
  }
  return cells
}

/** Where rows start and end, the time of the axis; undefined when nothing on it has a time. */
export function axisOf(rows: readonly { from?: number; to?: number; ahead?: number }[], width: number): Axis | undefined {
  const timed = rows.filter((row): row is { from: number; to: number; ahead?: number } => row.from !== undefined && row.to !== undefined)
  if (timed.length === 0 || width < MIN_AXIS) return undefined
  const from = Math.min(...timed.map(row => row.from))
  const to = Math.max(...timed.map(row => Math.max(row.to, row.ahead ?? row.to)))
  return { from, to: Math.max(to, from + 60_000), width }
}

/**
 * The axis's clock times over its bars: start, middle and end, `│16:02
 * 16:22   16:42│`; a time that repeats the one before it (an axis of a
 * few minutes) is left out rather than said twice.
 */
export function axisLabels(axis: Axis): string {
  const start = clockText(axis.from)
  const end = clockText(axis.to)
  const middle = clockText((axis.from + axis.to) / 2)
  const inner = axis.width
  if (end === start) return `│${start}${' '.repeat(Math.max(1, inner - start.length))}│`
  if (middle === start || middle === end || inner < start.length + end.length + middle.length + 4) return `│${start}${' '.repeat(Math.max(1, inner - start.length - end.length))}${end}│`
  const left = Math.floor((inner - middle.length) / 2)
  const gap1 = Math.max(1, left - start.length)
  const gap2 = Math.max(1, inner - start.length - gap1 - middle.length - end.length)
  return `│${start}${' '.repeat(gap1)}${middle}${' '.repeat(gap2)}${end}│`
}

/** The longest words after the axis that are kept whole: past it they are cut. */
const MAX_DETAIL = 34

/**
 * Column widths: the name's, and the axis's, which takes what the name, the
 * length and the longest words after it leave (60 at most); short of 16, the
 * words give way, and with no room for even that the axis goes (a narrow pane).
 */
function columns(width: number, detail: number): { name: number; axis: number } {
  const name = Math.max(14, Math.min(30, Math.floor(width * 0.28)))
  // ' ✓ ' + name + the length (7) and its gap (2) + the axis's two '│' + the space before the words.
  const fixed = 3 + name + 9 + 3
  const axis = Math.min(60, width - fixed - Math.min(MAX_DETAIL, detail))
  if (axis >= MIN_AXIS) return { name, axis }
  return { name, axis: width - fixed - 8 >= MIN_AXIS ? MIN_AXIS : 0 }
}

function rowLine(row: Row, cols: { name: number }, axis: Axis | undefined): Line {
  const line: Line = [{ text: ' ' }, row.mark, { text: ' ' }, { text: pad(fit(row.name, cols.name), cols.name), ...(row.nameTone ? { tone: row.nameTone } : {}) }]
  line.push({ text: `${row.length.padStart(7)}  `, tone: 'muted' })
  if (axis) {
    line.push(muted('│'))
    line.push(...(row.from !== undefined && row.to !== undefined ? barSpans(axis, row.from, row.to, row.barTone, row.ahead) : [{ text: ' '.repeat(axis.width) }]))
    line.push(muted('│'))
  }
  if (row.detail.length > 0) line.push({ text: ' ' }, ...row.detail)
  return line
}

/** Where the list's open tasks begin and end on screen: the current one with its neighbours, the rest folded. */
function shownTasks(items: readonly Task[]): { shown: Task[]; hidden: number } {
  if (items.length <= MAX_TASK_ROWS + 1) return { shown: [...items], hidden: 0 }
  const current = Math.max(0, items.findIndex(item => item.status === 'in_progress'))
  const first = Math.max(0, Math.min(current - 2, items.length - MAX_TASK_ROWS))
  const shown = items.slice(first, first + MAX_TASK_ROWS)
  return { shown, hidden: items.length - shown.length }
}

function taskRows(c: Cockpit, now: number, eta: Eta | undefined): { rows: Row[]; hidden: number } {
  const items = c.tasks?.items ?? []
  // Where each open task is expected to run, one after another at the estimate's pace.
  const expected = new Map((eta?.tasks?.stretches ?? []).map(s => [s.id, s]))
  const { shown, hidden } = shownTasks(items)
  const rows = shown.map((task): Row => {
    if (task.status === 'completed') {
      const length = task.startedAt !== undefined && task.doneAt !== undefined ? formatSpan(task.doneAt - task.startedAt) : ''
      return { mark: muted('✓'), name: task.title, nameTone: 'muted', length, ...(task.startedAt !== undefined && task.doneAt !== undefined ? { from: task.startedAt, to: task.doneAt } : {}), barTone: 'muted', detail: [] }
    }
    const stretch = expected.get(task.id)
    if (task.status === 'in_progress') {
      const started = task.startedAt
      // Its expected end, drawn ahead of now in a light shade.
      const ahead = stretch && stretch.to > now ? stretch.to : undefined
      return {
        mark: { text: '▸', bold: true },
        name: task.title,
        length: started !== undefined ? `${formatMinutes(now - started)}…` : '',
        ...(started !== undefined ? { from: started, to: now } : {}),
        ...(ahead !== undefined ? { ahead } : {}),
        detail: [],
      }
    }
    // A task still to come: where it is expected to run, all of it in the light shade.
    if (stretch) return { mark: muted('·'), name: task.title, length: `~${formatLeft(stretch.to - stretch.from)}`, from: stretch.from, to: stretch.from, ahead: stretch.to, detail: [] }
    return { mark: muted('·'), name: task.title, length: '', detail: [] }
  })
  return { rows, hidden }
}

/** Who started an agent, in a word or two; nothing for Claude's own main loop. */
function startedBy(a: AgentRun, L: Locale): string | undefined {
  if (a.by === 'workflow') return t(L, 'agents.by.workflow')
  if (a.by === 'plugin') return t(L, 'agents.by.plugin', { name: a.byName ?? '?' })
  if (a.by === 'agent') return t(L, 'agents.by.agent', { name: a.byName ?? 'subagent' })
  return undefined
}

function agentRows(c: Cockpit, now: number, L: Locale, eta: Eta | undefined): { rows: Row[]; folded: number } {
  const expected = new Map((eta?.agents ?? []).map(a => [a.id, a]))
  const runs = [...c.agents].sort((a, b) => a.startedAt - b.startedAt)
  const isOpen = (a: AgentRun) => isAgentOpen(a) || a.status === 'idle' || a.status === 'waiting'
  // Finished runs fold first, the oldest of them, when the list is long.
  const finished = runs.filter(a => !isOpen(a))
  const fold = Math.max(0, runs.length - MAX_AGENT_ROWS)
  const folded = new Set(finished.slice(0, Math.min(fold, finished.length)))
  const rows = runs
    .filter(a => !folded.has(a))
    .map((a): Row => {
      // The type as the rows can afford it: `general-purpose`, the default, reads `general`.
      const name = `${a.type === 'general-purpose' ? 'general' : a.type} · ${a.description}`
      const end = a.endedAt ?? now
      const bar = a.status === 'remote' ? {} : { from: a.startedAt, to: isOpen(a) ? now : end }
      // Who started it, and whether it counts: another's agent is listed, never estimated.
      const by = startedBy(a, L)
      const who = [...(by ? [by] : []), ...(isCounted(a) ? [] : [t(L, 'agents.notCounted')])]
      const tags = a.teammate ? [t(L, 'agents.teammate')] : []
      if (a.status === 'failed') return { mark: { text: '✗', tone: 'bad' }, name, nameTone: 'bad', length: formatSpan(end - a.startedAt), ...bar, barTone: 'bad', detail: [{ text: [t(L, 'agents.failed'), ...who, ...tags].join(' · '), tone: 'bad' }] }
      if (a.status === 'remote') return { mark: muted('↗'), name, length: '', detail: [muted([t(L, 'agents.remote'), ...who, ...tags].join(' · '))] }
      if (a.status === 'idle') return { mark: muted('◦'), name, length: '', detail: [muted([t(L, 'agents.idle'), ...who, ...tags].join(' · '))] }
      // Alive and not at work (on its own background work, a plan, an agent it started, or queued): not running, no bar of work.
      if (a.status === 'waiting') return { mark: muted('◦'), name, length: '', detail: [muted([t(L, 'agents.waiting'), ...who, ...tags].join(' · '))] }
      if (isOpen(a)) {
        // A background run's tokens never reach the main loop: it says so, never a guess.
        // Its expected end, from its type's usual length, is drawn ahead in the light shade.
        const end = expected.get(a.id)
        // Its time left first; with none known, where it runs and who started it come before saying so.
        const left = end ? [t(L, 'hero.left', { left: formatLeft(end.to - now) })] : []
        const unknown = !end && isCounted(a) ? [t(L, 'agents.noUsual')] : []
        // Another's agent says whose it is first: that is what explains it.
        const facts = isCounted(a) ? [...left, ...who, ...(a.isBackground ? [t(L, 'agents.background')] : []), ...tags, ...unknown] : [...who, ...tags]
        return { mark: { text: '▸', bold: true }, name, length: runningFor(now - a.startedAt, a.seenLate === true), ...bar, ...(end && end.to > now ? { ahead: end.to } : {}), detail: facts.length > 0 ? [muted(facts.join(' · '))] : [] }
      }
      const facts: string[] = []
      if (a.status === 'stopped') facts.push(t(L, 'agents.stopped'))
      if (a.isBackground) facts.push(t(L, 'agents.background'))
      else if (a.tokens !== undefined) facts.push(formatTokens(a.tokens))
      if (a.toolUses !== undefined) facts.push(t(L, a.toolUses === 1 ? 'unit.tool' : 'unit.tools', { n: a.toolUses }))
      if (a.added !== undefined || a.removed !== undefined) facts.push(`+${a.added ?? 0} −${a.removed ?? 0}`)
      facts.push(...who, ...tags)
      const length = a.replayed ? t(L, 'resume.before') : formatSpan(Math.max(0, (a.durationMs ?? end - a.startedAt) - (a.heldMs ?? 0)))
      return { mark: muted('✓'), name, nameTone: 'muted', length, ...(a.replayed ? {} : bar), barTone: 'muted', detail: facts.length > 0 ? [muted(facts.join(' · '))] : [] }
    })
  return { rows, folded: folded.size }
}

/**
 * How long a running row has run: `3m…`; one quackpit first saw already
 * running has run at least this long (`≥3m…`, `≥40s…` under a minute), its
 * start unseen.
 */
function runningFor(ms: number, isLate: boolean): string {
  if (!isLate) return `${formatMinutes(ms)}…`
  return `≥${ms < 60_000 ? formatSpan(ms) : formatMinutes(ms)}…`
}

/** The background jobs as rows: running ones with their expected end ahead, ended ones with how they ended. */
function jobRows(c: Cockpit, now: number, L: Locale, eta: Eta | undefined): Row[] {
  const expected = new Map((eta?.jobs ?? []).map(j => [j.id, j]))
  return c.jobs.slice(-MAX_AGENT_ROWS).map((j: Job): Row => {
    const name = jobName(j)
    if (isJobRunning(j)) {
      const end = expected.get(j.id)
      const facts = [end ? t(L, 'hero.left', { left: formatLeft(end.to - now) }) : t(L, 'agents.noUsual')]
      // First seen at a turn's end, already running: it has run at least this long.
      return { mark: { text: '▸', bold: true }, name, length: runningFor(now - j.startedAt, j.isLate === true), from: j.startedAt, to: now, ...(end && end.to > now ? { ahead: end.to } : {}), detail: [muted(facts.join(' · '))] }
    }
    // Listed alive and not at work (queued): no bar of work.
    if (j.status === 'waiting') return { mark: muted('◦'), name, length: '', detail: [muted(t(L, 'agents.waiting'))] }
    const end = j.endedAt ?? now
    const failed = j.status === 'failed'
    const facts = [...(j.exitCode !== undefined ? [t(L, 'jobs.exit', { code: j.exitCode })] : []), ...(j.status === 'killed' ? [t(L, 'agents.stopped')] : []), ...(j.isGone ? [t(L, 'jobs.gone')] : [])]
    const length = j.isLate || j.isGone ? '' : formatSpan(end - j.startedAt)
    return {
      mark: failed ? { text: '✗', tone: 'bad' } : muted('✓'),
      name,
      nameTone: failed ? 'bad' : 'muted',
      length,
      ...(j.isLate ? {} : { from: j.startedAt, to: end }),
      barTone: failed ? 'bad' : 'muted',
      detail: facts.length > 0 ? [{ text: facts.join(' · '), ...(failed ? { tone: 'bad' as const } : { tone: 'muted' as const }) }] : [],
    }
  })
}

/** The main loop's waits on the person as one row: each a stretch on the axis, in the accent colour. */
function waitSpans(axis: Axis, waits: readonly Wait[], now: number): Span[] {
  const cells = Array.from({ length: axis.width }, () => false)
  const span = Math.max(1, axis.to - axis.from)
  for (const w of waits) {
    const x0 = Math.max(0, Math.floor(((w.from - axis.from) / span) * axis.width))
    const x1 = Math.min(axis.width, Math.max(x0 + 1, Math.ceil((((w.to ?? now) - axis.from) / span) * axis.width)))
    for (let i = x0; i < x1; i++) cells[i] = true
  }
  const out: Span[] = []
  for (const on of cells) {
    const last = out.at(-1)
    const tone = on ? 'accent' : undefined
    if (last && last.tone === tone) last.text += on ? '▒' : ' '
    else out.push({ text: on ? '▒' : ' ', ...(tone ? { tone } : {}) })
  }
  return out
}

/**
 * The column TIME, CACHE, AI, TASKS and WAITS head: 7 columns, or the longest
 * of them in this language and two more (`キャッシュ` takes 10).
 */
function headWidth(L: Locale): number {
  return Math.max(7, ...(['time.title', 'time.cache', 'ai.title', 'time.tasks', 'time.waits'] as const).map(key => displayWidth(t(L, key)) + 2))
}

/** The cache's line: warm while a turn runs, the minutes left after it, or what the next prompt rewrites once cold. */
function cacheLine(clock: CacheClock, L: Locale): Line {
  const head: Span = { text: pad(t(L, 'time.cache'), headWidth(L)), bold: true, tone: 'muted' }
  if (clock.state === 'turn') return [head, muted(t(L, 'cache.turn', { ttl: clock.ttl }))]
  if (clock.state === 'warm') return [head, { text: t(L, 'cache.warm', { left: formatMinutes(clock.left), ttl: clock.ttl }) }]
  return [head, { text: t(L, 'cache.cold', { tokens: formatTokens(clock.rewrite) }), tone: 'warn' }]
}

/** The timeline in parts: the head lines, the axis's times, and the rows on it. */
export type TimeBlocks = { head: Line[]; axis?: Line; rows: Line[] }

/** What the pane says of the AI ETA: its setting, the last 7 days' calls (a tally a day), and how its answers scored. */
export type AiView = { on: boolean; today: string; days: readonly { day: string; tally: AiTally }[]; scores: AiScores }

const callsText = (n: number, L: Locale) => (n === 1 ? t(L, 'ai.call') : t(L, 'ai.calls', { n }))

/**
 * The AI ETA's lines over the turns: whether it is on, its calls and the
 * tokens their own usage reported today and over 7 days (with the failed and
 * the unreadable ones counted), and once 20 first answers are scored, how
 * often it and history alone landed within 2× of the time really left, first
 * answers and revisions apart (a revision knows more of its turn). Nothing at
 * all while it is off and made no call in 7 days. Words wrap under its head.
 */
export function aiLines(ai: AiView, L: Locale, width: number): Line[] {
  const week = sumTallies(ai.days.map(d => d.tally))
  if (!ai.on && week.calls === 0) return []
  const today = ai.days.find(d => d.day === ai.today)?.tally ?? emptyTally()
  const headW = headWidth(L)
  const room = Math.max(16, width - headW)
  const said = (tally: AiTally) => ({ calls: callsText(tally.calls, L), tokens: formatTokens(tallyTokens(tally)) })
  const misses = [...(week.failed > 0 ? [t(L, 'ai.failed', { n: week.failed })] : []), ...(week.unread > 0 ? [t(L, 'ai.unread', { n: week.unread })] : [])]
  const { first, revised } = ai.scores
  const scored = (key: 'ai.score' | 'ai.scoreRevised', score: AiScore) => t(L, key, { ai: share(score.ai, score.n), history: share(score.history, score.n), n: score.n })
  const facts = [
    `${t(L, ai.on ? 'ai.on' : 'ai.off')} · ${t(L, 'ai.today', said(today))}`,
    [t(L, 'ai.week', said(week)), ...misses].join(' · '),
    first.n >= MIN_SCORED ? scored('ai.score', first) : t(L, 'ai.scoreLater', { min: MIN_SCORED, n: first.n }),
    ...(revised.n >= MIN_SCORED ? [scored('ai.scoreRevised', revised)] : revised.n > 0 ? [t(L, 'ai.scoreRevisedLater', { n: revised.n })] : []),
  ]
  const lines = facts.flatMap(fact => wrap(fact, room, 2))
  return lines.map((text, i): Line => [i === 0 ? { text: pad(t(L, 'ai.title'), headW), bold: true, tone: 'muted' } : { text: ' '.repeat(headW) }, i === 0 ? { text } : muted(text)])
}

/** A share in whole percent: `64%`. */
const share = (hits: number, n: number) => `${Math.round((100 * hits) / Math.max(1, n))}%`

/** The timeline tab's TIME (with the cache's clock when `ttl` is known), TASKS, WAITS, AGENTS and BACKGROUND, in parts; with `ai`, the AI ETA's lines after TIME. */
export function timeBlocks(c: Cockpit, now: number, L: Locale, width: number, ttl?: Ttl, eta?: Eta, ai?: AiView): TimeBlocks {
  const head: Line[] = []
  const began = c.sessionStartedAt ?? c.startedAt
  // Working time: the turns' own lengths, the running one's so far, their waits on the person left out.
  const working = c.activeMs + turnWorkSoFar(c, now)
  const turns = c.turnCount + (c.turn ? 1 : 0)
  // The session's elapsed time and cost are Claude Code's, whole; working time and turns are what
  // quackpit saw, so a session it joined late (a resume, a reload, an install) says since when.
  const whole = [t(L, 'time.elapsed', { time: formatHm(now - began) }), ...(c.reading?.costUsd !== undefined ? [formatUsd(c.reading.costUsd)] : [])]
  const seen = [t(L, 'time.working', { time: formatHm(working) }), t(L, turns === 1 ? 'ho.turns.one' : 'ho.turns.many', { n: turns })]
  const facts = c.joinedLate ? `${whole.join(' · ')} · ${t(L, 'time.since', { time: clockText(c.startedAt) })} ${seen.join(' · ')}` : [whole[0], ...seen, ...whole.slice(1)].join(' · ')
  head.push([{ text: pad(t(L, 'time.title'), headWidth(L)), bold: true, tone: 'muted' }, { text: facts }])
  const clock = ttl ? cacheClock(c, now, ttl) : undefined
  if (clock) head.push(cacheLine(clock, L))
  if (ai) head.push(...aiLines(ai, L, width))

  const tasks = taskRows(c, now, eta)
  const agents = agentRows(c, now, L, eta)
  const jobs = jobRows(c, now, L, eta)
  // The waits on the person that held the main loop, on the same axis.
  const waits = c.waits.filter(w => w.main)
  const waitRow = waits.length > 0 ? [{ from: Math.min(...waits.map(w => w.from)), to: Math.max(...waits.map(w => w.to ?? now)) }] : []
  // The words after the axis keep their room.
  const all = [...tasks.rows, ...agents.rows, ...jobs]
  const detail = Math.max(0, ...all.map(row => displayWidth(row.detail.map(span => span.text).join(''))))
  const cols = columns(width, detail)
  const axis = cols.axis > 0 ? axisOf([...all, ...waitRow, ...(eta && !eta.isDone ? [{ from: eta.startedAt, to: now, ahead: eta.endsAt }] : [])], cols.axis) : undefined
  const offset = 3 + cols.name + 9
  const fitRow = (line: Line) => (displayWidth(line.map(span => span.text).join('')) > width ? clipLine(line, width) : line)
  const blocks: TimeBlocks = { head: head.map(fitRow), rows: [] }
  // The waits are drawn on the axis too, so they get its times even with nothing else on it.
  if (axis && (all.length > 0 || waits.length > 0)) blocks.axis = fitRow([{ text: ' '.repeat(offset) }, muted(axisLabels(axis))])
  const lines: Line[] = []
  const progress = c.tasks ? c.tasks.items.filter(item => item.status === 'completed').length : 0
  const total = c.tasks?.items.length ?? 0
  if (total > 0) {
    const allDone = progress === total
    lines.push([{ text: pad(t(L, 'time.tasks'), headWidth(L)), bold: true, tone: 'muted' }, { text: t(L, 'time.tasksDone', { done: progress, total }), ...(allDone ? { tone: 'ok' as const } : {}) }])
    for (const row of tasks.rows) lines.push(rowLine(row, cols, axis))
    if (tasks.hidden > 0) lines.push([muted(`   ${t(L, 'time.more', { n: tasks.hidden })}`)])
  }
  if (waits.length > 0) {
    const sum = waits.reduce((ms, w) => ms + Math.max(0, (w.to ?? now) - w.from), 0)
    const said = waits.length === 1 ? t(L, 'time.waitsOne', { time: formatSpan(sum) }) : t(L, 'time.waitsLine', { n: waits.length, time: formatSpan(sum) })
    lines.push([{ text: pad(t(L, 'time.waits'), headWidth(L)), bold: true, tone: 'muted' }, muted(said)])
    // One row: each wait a stretch on the axis.
    if (axis) lines.push([{ text: ' ' }, { text: '⏸', tone: 'accent' }, { text: ' ' }, muted(pad(fit(t(L, 'time.waitsRow'), cols.name), cols.name)), muted(`${formatSpan(sum).padStart(7)}  `), muted('│'), ...waitSpans(axis, waits, now), muted('│')])
  }
  if (c.agents.length > 0) {
    // Running as the progress and AGENTS count it: Claude's own agents at work; another's are listed and counted apart.
    const work = workOf(c, now, eta)
    const done = c.agents.filter(a => a.status === 'done').length
    const failed = c.agents.filter(a => a.status === 'failed').length
    const idle = c.agents.filter(a => a.status === 'idle').length
    const waiting = c.agents.filter(a => a.status === 'waiting').length
    const counts = [
      t(L, 'agents.running', { n: work.agents.length }),
      ...(work.others.length > 0 ? [`${work.others.length} ${t(L, 'agents.notCounted')}`] : []),
      ...(idle > 0 ? [`${idle} ${t(L, 'agents.idle')}`] : []),
      ...(waiting > 0 ? [`${waiting} ${t(L, 'agents.waiting')}`] : []),
      t(L, 'agents.done', { n: done }),
      ...(failed > 0 ? [t(L, 'agents.failedCount', { n: failed })] : []),
    ]
    lines.push([{ text: `${t(L, 'time.agents')}  `, bold: true, tone: 'muted' }, { text: counts.join(' · ') }])
    if (agents.folded > 0) lines.push([muted(`   ${t(L, 'time.finished', { n: agents.folded })}`)])
    for (const row of agents.rows) lines.push(rowLine(row, cols, axis))
  }
  if (c.jobs.length > 0) {
    const running = c.jobs.filter(isJobRunning).length
    lines.push([{ text: `${t(L, 'time.jobs')}  `, bold: true, tone: 'muted' }, { text: [t(L, 'agents.running', { n: running }), t(L, 'agents.done', { n: c.jobs.length - running })].join(' · ') }])
    for (const row of jobs) lines.push(rowLine(row, cols, axis))
  }
  blocks.rows = lines.map(fitRow)
  return blocks
}

/** The timeline as lines of text. */
export function timeSection(c: Cockpit, now: number, L: Locale, width: number, ttl?: Ttl, eta?: Eta, ai?: AiView): Line[] {
  const b = timeBlocks(c, now, L, width, ttl, eta, ai)
  return [...b.head, ...(b.axis ? [b.axis] : []), ...b.rows]
}

/** A line cut to `width` columns, an ellipsis where it was cut. */
function clipLine(line: Line, width: number): Line {
  const out: Line = []
  let left = width
  for (const span of line) {
    const w = displayWidth(span.text)
    if (w <= left) {
      out.push(span)
      left -= w
    } else {
      if (left > 0) out.push({ ...span, text: fit(span.text, left) })
      break
    }
  }
  return out
}
