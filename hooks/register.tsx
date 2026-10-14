// Claude Code adapter: the only file that touches `$`. It turns Claude Code's
// events into the plain inputs of the agent-agnostic core (src/), keeps the
// cockpit in the session's state, and draws with hooks/draw.tsx.
//
// Rules every hook here keeps:
//   - fail-open: any error draws nothing and blocks nothing; every observing
//     hook hands its event on unchanged;
//   - nothing reaches the model's context: no prompt.compose, no prompt
//     text or context, and the commands answer with an empty result;
//   - zero model tokens by default: the one model call is the opt-in AI ETA's
//     `$.model.complete` (askAi), a completion of its own, made only while its
//     setting is on, its usage tallied; never `$.model.fork`;
//   - no network, no processes; `$.fs` only reads claude-hud's config
//     (readHudFile) and writes the handover (writeHandoverFile);
//   - main agent only: tool and turn events that carry an `agentId` are passed by.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Events, MatchedHook, ModelCompleteResult, PaneOpenArgs, PromptOrigin, Register, RenderElement, RenderSurface, SessionUsage, TurnStepResult } from 'claude-code'

import { aiRequest, parseMinutes, planAsk, startedBy, tallyTokens, type AiOutcome, type AiPrevious, type AiRecord } from '../src/ai'

import { forcedTtl, ttlOf, type Ttl } from '../src/cache'
import { parseCounts } from '../src/checks'
import { parseCommand } from '../src/commands'
import type { DayTotals } from '../src/derive'
import { cautionsOf, freshCautions, quackLine, cautionText, type Caution } from '../src/duck'
import { baseName, clockText, dayKey, formatCountdown, formatTokens } from '../src/format'
import { duckCells, duckImage, probeImage } from '../src/gauges'
import { measureMessages, splitOf, type BreakdownInput } from '../src/context'
import { buildHandover, HANDOVER_PATH } from '../src/handover'
import { hudTiles, layerHud, parseHudConfig, HUD_FILES } from '../src/hud'
import { systemLocale, t } from '../src/i18n'
import { DENSE_BELOW, planBand, sharedRows } from '../src/layout'
import { isJobRunning, isRunLength, jobLength, parseNotices, type CommandLengths, type ListedTask } from '../src/jobs'
import { calibration, historyLeft, turnLengths } from '../src/lengths'
import { isNum, MINUTE, newTokens } from '../src/metrics'
import {
  acknowledge,
  adoptEarly,
  asCockpit,
  backfill,
  isAgentOpen,
  isCounted,
  markHandover,
  markSeen,
  newCockpit,
  isCompactPointDue,
  joinStretch,
  onAgentList,
  onAgentSpawn,
  onAgentTurnEnd,
  onBackgroundTasks,
  onCompact,
  onCompactPoint,
  onContextSplit,
  onDialogsClosed,
  onForeignTask,
  onMeta,
  onNotices,
  onPrompt,
  onReading,
  onStep,
  onStepStart,
  onToolEnd,
  onToolStart,
  onTurnEnd,
  onTurnStart as startTurn,
  onWaitEnd,
  onWaitStart,
  settleWith,
  turnLength,
  turnWorkSoFar,
  waitKindOf,
  type AiAsk,
  type AiWhy,
  type AgentRun,
  type Cockpit,
  type ListedAgent,
  type PastMessage,
  type Reading,
  type Stretch,
  type ToolEnd,
} from '../src/model'
import { activeMs, openWaits, waitingNow } from '../src/waits'
import { detailOf, type DetailId } from '../src/details'
import { bandBody, bodyKeys, drillBody, guideBody, handoverBody, headRows, overviewBody, paneModel, sumRows, timelineBody, turnsBody, type BodyPart, type OverviewPlan } from '../src/panes'
import { clampTop, followed, overflows, scrolled, windowRows } from '../src/pin'
import { asView, DEFAULT_VIEW, VIEW_IDS, type PaneView, type ViewId } from '../src/views'
import {
  addTile,
  effectiveLayout,
  hudLayout,
  isCurrent,
  isSameLayout,
  moveTile,
  readSettings,
  removeTile,
  setDuck,
  setRows,
  type Change,
  type Layout,
  type LayoutRecord,
  type Settings,
} from '../src/prefs'
import { isListLive, progressOf } from '../src/progress'
import { quackWav } from '../src/sound'
import { QUACK_FRAME_MS, QUACK_FRAMES, type Frame } from '../src/sprites'
import { toRecord } from '../src/record'
import { guideRows } from '../src/guide'
import { aiLines, timeBlocks, type AiView } from '../src/timeline'
import { topSection } from '../src/top'
import {
  addAiCall,
  addAiRecord,
  addCommandRun,
  addToDay,
  giveBackNotify,
  loadAiSummary,
  loadDays,
  loadHud,
  loadLayout,
  loadLengths,
  loadSession,
  loadView,
  pruneAi,
  rollUp,
  saveHud,
  saveLayout,
  saveSession,
  saveView,
  surveySessions,
  takeNotify,
  type AiSummary,
  type KV,
} from '../src/store'
import { emptyDurations, isTurnCovered, type Durations } from '../src/eta'
import { availableTiles, isTileId, readingsOf, receiptText, unknownTiles, type TileId } from '../src/tiles'
import type { QuackpitJson } from '../types'
import { drawBand, drawPane, drawsNothing, planDraws, type Kit } from './draw'

type Dollar = EngineInterface

export const PANE_ID = 'quackpit'

// ------------------------------------------------------------------ state

const cockpitAtom = atom({ plugin: 'quackpit', key: 'cockpit' } as const, null)
const uiAtom = atom({ plugin: 'quackpit', key: 'ui' } as const, null)

type UiState = {
  graphics: 'unknown' | 'pixels' | 'text'
  layout: Layout
  days: DayTotals[]
  /** The pane's view in front and the detail drilled into, kept in the store too, so /clear keeps them. */
  pane?: PaneView
  /** The last handover written: when, and whether the file was written. */
  handover?: { at: number; written: boolean }
  /** The AI ETA's last 7 days of calls and its score, from the store: what the pane shows of it. */
  ai?: AiSummary
}

/** The module's own settings, from userConfig; a change reloads the module. */
let settings: Settings = readSettings({})

function defaultUi(): UiState {
  return { graphics: 'unknown', layout: { tiles: [...settings.tiles], rows: settings.rows, duck: settings.duck }, days: [] }
}

function asUi(x: unknown): UiState {
  if (typeof x !== 'object' || x === null) return defaultUi()
  const u = x as Partial<UiState>
  const base = defaultUi()
  const layout = u.layout && Array.isArray(u.layout.tiles) ? { ...base.layout, ...u.layout, tiles: u.layout.tiles.filter(isTileId) } : base.layout
  return {
    graphics: u.graphics === 'pixels' || u.graphics === 'text' ? u.graphics : 'unknown',
    layout,
    days: Array.isArray(u.days) ? u.days : [],
    ...(u.handover && isNum(u.handover.at) ? { handover: { at: u.handover.at, written: u.handover.written === true } } : {}),
    ...(asView(u.pane) ? { pane: asView(u.pane) as PaneView } : {}),
    ...(isAiSummary(u.ai) ? { ai: u.ai } : {}),
  }
}

/** A stored AI summary, checked before it is drawn from. */
function isAiSummary(x: unknown): x is AiSummary {
  if (typeof x !== 'object' || x === null) return false
  const a = x as Partial<AiSummary>
  const isScore = (x: unknown) => typeof x === 'object' && x !== null && isNum((x as { n?: unknown }).n) && isNum((x as { ai?: unknown }).ai) && isNum((x as { history?: unknown }).history)
  return Array.isArray(a.days) && a.days.every(d => typeof d?.day === 'string' && typeof d.tally === 'object' && d.tally !== null) && isScore(a.scores?.first) && isScore(a.scores?.revised)
}

const json = (x: unknown): QuackpitJson => x as QuackpitJson

async function now($: Dollar): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

async function attempt<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work()
  } catch {
    return fallback
  }
}

/** A line of work where each waits for the one before: a store read-then-write never interleaves with another. */
type Queue = { tail: Promise<unknown> }

function serially<T>(queue: Queue, work: () => Promise<T>): Promise<T> {
  const run = queue.tail.then(work, work)
  queue.tail = run.catch(() => undefined)
  return run
}

/** The day's notification count; the layout override. */
const notifyQueue: Queue = { tail: Promise.resolve() }
const layoutQueue: Queue = { tail: Promise.resolve() }

/** A press or a timer's work, unawaited by anyone: its failure goes to the debug log, never unhandled. */
function safely($: Dollar, where: string, work: () => Promise<unknown>): void {
  void work().catch(err => debugLog($, where, err))
}

/**
 * What the timers and the drawing need to know without reading the state:
 * whether agents are at work (their list is looked up while they are), which
 * calls a wait on the person holds (a progress row of one ends its wait), and
 * which loops a wait holds. Refreshed on every write.
 */
const hint = { isAgentOpen: false, waitIds: new Set<string>(), waitLoops: new Set<string>(), isWaiting: false, hasDialog: false }

function noteCockpit(c: Cockpit) {
  // Polled while an agent is at work or waiting: either changes by itself, and no event of the main loop says when.
  hint.isAgentOpen = c.agents.some(a => isAgentOpen(a) || a.status === 'waiting')
  const open = openWaits(c.waits)
  hint.waitIds = new Set(open.flatMap(w => (w.toolUseId ? [w.toolUseId] : [])))
  hint.waitLoops = new Set(open.map(w => w.agentId ?? MAIN_LOOP))
  hint.isWaiting = open.length > 0
  hint.hasDialog = open.some(w => w.kind === 'permission')
}

/** The main loop's name among the loops a wait may hold. */
const MAIN_LOOP = '(main)'

/** Applies a reducer to the cockpit, starting a fresh one when there is none. */
async function apply($: Dollar, at: number, change: (c: Cockpit) => Cockpit): Promise<Cockpit> {
  let result: Cockpit = newCockpit(at)
  await update($, cockpitAtom, raw => {
    result = change(asCockpit(raw) ?? newCockpit(at))
    return json(result)
  })
  noteCockpit(result)
  ensurePoller($)
  ensureWaitTicker($)
  return result
}

async function readCockpit($: Dollar): Promise<Cockpit | undefined> {
  return asCockpit(await read($, cockpitAtom))
}

async function readUi($: Dollar): Promise<UiState> {
  const raw = await read($, uiAtom)
  return raw === null ? restoredUi($) : asUi(raw)
}

/** The ui state read back from the store, kept until this session's own is written. */
let restored: UiState | undefined

/**
 * The ui state where this session's is new and nothing wrote it yet: after
 * /clear Claude Code starts the session's state afresh with no session.start,
 * so the layout override and the days for the usual pace are read back from
 * the store, as start-up reads them. Only read here (a drawing may not write);
 * the next change writes it, starting from this.
 */
async function restoredUi($: Dollar): Promise<UiState> {
  if (restored) return restored
  const at = await now($)
  const kv = kvOf($)
  const record = await attempt(() => loadLayout(kv), undefined)
  const days = await attempt(() => loadDays(kv, dayKey(at)), [] as DayTotals[])
  // The AI ETA's calls and score are the store's too: /clear does not spend them.
  const ai = await attempt(() => loadAiSummary(kv, dayKey(at)), undefined)
  // And the pane opens on the tab and detail it was left on.
  const pane = await attempt(() => loadView(kv), undefined)
  restored = { ...defaultUi(), layout: effectiveLayout(settings, record), days, ...(ai ? { ai } : {}), ...(pane ? { pane } : {}) }
  return restored
}

async function changeUi($: Dollar, change: (u: UiState) => UiState): Promise<UiState> {
  // A new state starts from what the store holds, not from the settings alone.
  const start = (await read($, uiAtom)) === null ? await restoredUi($) : undefined
  let result = defaultUi()
  await update($, uiAtom, raw => {
    result = change(raw === null && start ? start : asUi(raw))
    return json(result)
  })
  restored = undefined
  return result
}

/** The pane's view, as the session's state has it (or the store kept it). */
function viewOf(ui: UiState): PaneView {
  return ui.pane ?? DEFAULT_VIEW
}

/**
 * Changes the pane's view: in the store first, which a /clear (whose state
 * starts afresh) reads it back from, then in the session's state, which
 * redraws the pane. A state that cannot be written leaves the store's.
 */
async function setView($: Dollar, change: (view: PaneView) => PaneView): Promise<PaneView> {
  const view = change(viewOf(await attempt(() => readUi($), defaultUi())))
  await attempt(() => saveView(kvOf($), view), undefined)
  restored = undefined
  await attempt(() => changeUi($, u => ({ ...u, pane: view })), defaultUi())
  redraw($)
  return view
}

function kvOf($: Dollar): KV {
  return {
    get: key => $.store.get(key),
    set: (key, value) => $.store.set(key, value),
    delete: key => $.store.delete(key),
    keys: () => $.store.keys(),
  }
}

function toast($: Dollar, text: string, timeoutMs = 6000) {
  try {
    $.ui.toast(text, { timeoutMs })
  } catch {
    // a toast that cannot show is not worth an error
  }
}

/** A failure, to the debug log alone (`claude --debug`): fail-open, but not silent. */
function debugLog($: Dollar, where: string, err: unknown) {
  try {
    $.ui.log(`quackpit ${where}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`, { to: 'debug' })
  } catch {
    // nowhere to say it
  }
}

function redraw($: Dollar) {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // nothing drawn to redraw
  }
}

// ------------------------------------------------------------------ readings

/** The figures `$.session.usage()` answers and `session.measure` pushes, flattened. */
function readingOf(usage: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'> & { startedAt?: number }, at: number): Reading {
  const reading: Reading = { at, ...(isNum(usage.startedAt) ? { sessionStartedAt: usage.startedAt } : {}) }
  const ctx = usage.context
  if (ctx) {
    if (isNum(ctx.percent)) reading.contextPct = ctx.percent
    if (isNum(ctx.tokens)) reading.contextTokens = ctx.tokens
    if (isNum(ctx.window)) reading.contextWindow = ctx.window
  }
  for (const limit of usage.rateLimits ?? []) {
    if (!isNum(limit.percentUsed)) continue
    const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
    const window = { pct: limit.percentUsed, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) }
    if (limit.kind === 'five_hour') reading.fiveHour = window
    else if (limit.kind === 'seven_day') reading.sevenDay = window
  }
  if (usage.cost && isNum(usage.cost.usd)) reading.costUsd = usage.cost.usd
  return reading
}

/**
 * `$.session.usage()` read directly: the fallback at start-up and at a turn's
 * start (`session.measure` pushes every other reading). Undefined when it
 * throws (fail-open).
 */
async function readUsage($: Dollar, at: number): Promise<Reading | undefined> {
  try {
    return readingOf(await $.session.usage(), at)
  } catch {
    return undefined
  }
}

// ------------------------------------------------------------------ the duck's voice

let lastQuackAt = 0

/** An OS notification within the day's 3, else a toast. Never awaited by a turn. */
async function notifyCapped($: Dollar, title: string, body: string, day: string) {
  try {
    const kv = kvOf($)
    // Two cautions at once (a failed check and the 5h window) take their slots in turn.
    if (!(await serially(notifyQueue, () => attempt(() => takeNotify(kv, day), false)))) return toast($, title, 8000)
    let isSent = false
    try {
      const result = await $.ui.notify(body, { title })
      isSent = result.isSent === true
    } catch {
      // before 2.1.295 there is no $.ui.notify; a hook may refuse it
      isSent = false
    }
    if (!isSent) {
      await serially(notifyQueue, () => attempt(() => giveBackNotify(kv, day), undefined))
      toast($, title, 8000)
    }
  } catch {
    toast($, title, 8000)
  }
}

function playQuack($: Dollar, at: number) {
  if (!settings.sound || at - lastQuackAt < 20_000) return
  lastQuackAt = at
  try {
    void $.audio.play({ base64: quackWav(), mime: 'audio/wav' }).catch(() => undefined)
  } catch {
    // no player here: the duck stays silent
  }
}

function cautionBody(k: Caution, c: Cockpit): string {
  if (k.kind === 'check') {
    const check = [...c.checks].reverse().find(ch => ch.kind === k.checkKind && ch.status === 'fail')
    return check ? `${check.command}` : cautionText(k, settings.locale)
  }
  if (k.kind === 'five') {
    const w = c.reading?.fiveHour
    return w?.resetsAt !== undefined ? `${cautionText(k, settings.locale)} · ↻${formatCountdown(w.resetsAt - (c.reading?.at ?? 0))} (${clockText(w.resetsAt)})` : cautionText(k, settings.locale)
  }
  return cautionText(k, settings.locale)
}

/**
 * A caution was just announced: the band plays its quack at its next draw that
 * shows the duck. Only an announcement sets it, so neither a redraw nor a
 * reload (which starts the module's variables over) replays an old one.
 */
let quackDue = false

/**
 * Each new caution: one "Quack:" toast, or for the notify kinds an OS
 * notification. The checks one run failed (a chain whose output named none
 * of them) are one announcement: `Quack: types+tests failed`.
 */
function announce($: Dollar, fresh: readonly Caution[], c: Cockpit, layout: Layout, at: number) {
  if (!layout.duck || fresh.length === 0) return
  const L = settings.locale
  const groups: Caution[][] = []
  for (const k of fresh) {
    const run = k.kind === 'check' ? groups.find(g => g[0]?.kind === 'check' && g[0].at === k.at) : undefined
    if (run) run.push(k)
    else groups.push([k])
  }
  for (const [k, ...more] of groups) {
    if (!k) continue
    const line = more.length === 0 ? quackLine(k, L) : `${t(L, 'duck.quack')} ${t(L, 'caution.check', { kind: [k, ...more].map(g => t(L, `kind.${g.checkKind ?? 'test'}`)).join('+') })}`
    if (k.isNotify) void notifyCapped($, line, cautionBody(k, c), dayKey(at))
    else toast($, line)
  }
  quackDue = true
  playQuack($, at)
}

/** Folds an event in and announces what it newly raised. */
async function fold($: Dollar, at: number, change: (c: Cockpit) => Cockpit): Promise<Cockpit> {
  let fresh: Caution[] = []
  const c = await apply($, at, before => {
    const next = change(before)
    fresh = freshCautions(next)
    return fresh.length > 0 ? markSeen(next, fresh.map(k => k.key)) : next
  })
  if (fresh.length > 0) {
    const ui = await attempt(() => readUi($), defaultUi())
    announce($, fresh, c, ui.layout, at)
  }
  return c
}

// ------------------------------------------------------------------ the ticker

let ticker: { cancel: () => void } | undefined
let poller: { cancel: () => void } | undefined

function ensureTicker($: Dollar) {
  if (ticker) return
  try {
    ticker = $.clock.every(30_000, () => void tick($))
  } catch {
    ticker = undefined
  }
}

/**
 * Every 30 seconds, for the countdowns, ages and the swimming duck's place:
 * nothing in the band ticks seconds, and every event that changes the cockpit
 * redraws it by itself. It redraws and nothing more. The duck never animates
 * while idle.
 */
function tick($: Dollar) {
  redraw($)
}

/** While an agent is at work (or waiting), the agents' list is looked up every 5 seconds: no event of the main loop says when it ends. */
function ensurePoller($: Dollar) {
  if (hint.isAgentOpen === (poller !== undefined)) return
  if (poller) {
    try {
      poller.cancel()
    } catch {
      // gone already
    }
    poller = undefined
    return
  }
  try {
    poller = $.clock.every(5000, () => safely($, 'agents', () => lookUpAgents($)))
  } catch {
    poller = undefined
  }
}

/** Every agent loop of the session as the host lists it: subagents, teammates, workflows' and plugins' agents. */
async function lookUpAgents($: Dollar) {
  const listed = await attempt(
    async () =>
      (await $.agent.list()).map(
        (a): ListedAgent => ({
          id: a.id,
          status: a.status,
          type: a.type,
          description: a.description,
          ...(a.parentId ? { parentId: a.parentId } : {}),
          ...(a.spawnedBy ? { spawnedBy: a.spawnedBy } : {}),
          ...(a.teammateId ? { teammateId: a.teammateId } : {}),
          ...(a.name ? { name: a.name } : {}),
        }),
      ),
    undefined,
  )
  if (!listed) return
  const at = await now($)
  await apply($, at, before => onAgentList(before, at, listed))
  planAi($)
}

let waitTicker: { cancel: () => void } | undefined

/**
 * While a wait on the person is open, a redraw every second: its clock is the
 * one thing that ticks (`⏸ waiting on you · 1m05`). Nothing counts down, and
 * the duck holds still.
 */
function ensureWaitTicker($: Dollar) {
  if (hint.isWaiting === (waitTicker !== undefined)) return
  if (waitTicker) {
    try {
      waitTicker.cancel()
    } catch {
      // gone already
    }
    waitTicker = undefined
    return
  }
  try {
    waitTicker = $.clock.every(1000, () => redraw($))
  } catch {
    waitTicker = undefined
  }
}

// ------------------------------------------------------------------ the AI ETA

/**
 * The AI ETA's next call for the turn running: its timer until it is due,
 * its controller while it runs, so the turn's end cancels either. Only while
 * the setting is on; a reload drops both, and the turn's asks in the state
 * keep the limits.
 */
let aiCall: { turnId: string; timer?: { cancel: () => void }; controller?: AbortController } | undefined

/** The AI ETA's store writes (its tally and its scored answers) go one after another. */
const aiQueue: Queue = { tail: Promise.resolve() }

/** Main turns that have ended, the last few: a call about to go out for one of them is not made. */
const endedTurns = new Set<string>()

/**
 * The work's shape, which an AI answer was made for: Claude's agents at work
 * and its background jobs running, whether a task list is open, and whether
 * something measured covers the turn. A change asks the AI again.
 */
function shapeOf(c: Cockpit, covered: boolean): string {
  const agents = c.agents.filter(a => isCounted(a) && isAgentOpen(a)).map(a => a.id)
  const jobs = c.jobs.filter(isJobRunning).map(j => j.id)
  const list = c.tasks?.items.some(t => t.status !== 'completed') ? 'list' : ''
  return [agents.sort().join(','), jobs.sort().join(','), list, covered ? 'covered' : ''].join('|')
}

/** A plain estimate context, for the AI's own decisions (its answer never decides whether it is asked). */
function etaContext() {
  return { priors, ...(cmdLengths ? { lengths: cmdLengths } : {}) }
}

/** Cancels the AI ETA's timer, or its call while it runs: the turn ended first. */
function disarmAi(turnId?: string) {
  const armed = aiCall
  if (!armed || (turnId !== undefined && armed.turnId !== turnId)) return
  aiCall = undefined
  try {
    armed.timer?.cancel()
  } catch {
    // fired already
  }
  armed.controller?.abort()
}

/** Only the timer: a call in flight goes on. */
function clearAiTimer() {
  try {
    aiCall?.timer?.cancel()
  } catch {
    // fired already
  }
  if (aiCall) aiCall = aiCall.controller ? { turnId: aiCall.turnId, controller: aiCall.controller } : undefined
}

/**
 * Looks at the AI ETA for the turn running, after anything that changes it:
 * notes a reason to ask again (the work changed shape, the measured estimate
 * it deferred to went away), then asks now, sets a timer for when it may, or
 * leaves it. A timer's work, never a hook's: it is never awaited.
 */
function planAi($: Dollar) {
  if (!settings.aiEta) return
  safely($, 'ai plan', async () => {
    const at = await now($)
    const c = await readCockpit($)
    const turn = c?.turn
    if (!c || !turn || endedTurns.has(turn.id)) return
    const covered = isTurnCovered(c, at, etaContext())
    const shape = shapeOf(c, covered)
    const asks = turn.asks ?? []
    let due = turn.aiDue?.why
    // A change of shape after the AI answered is a reason to ask it again.
    if (turn.shape !== shape) {
      const wasCovered = turn.shape?.endsWith('|covered') === true
      const why: AiWhy | undefined = asks.length > 0 || (wasCovered && !covered) ? (wasCovered && !covered ? 'deferred' : 'shape') : undefined
      await apply($, at, x => (x.turn?.id === turn.id ? { ...x, turn: { ...x.turn, shape, ...(why && !x.turn.aiDue ? { aiDue: { why, at } } : {}) } } : x))
      if (why && !due) due = why
    }
    const answered = asks.findLast(a => a.state === 'answered')
    const plan = planAsk({
      now: at,
      workedMs: turnWorkSoFar(c, at),
      isWaiting: waitingNow(c.waits) !== undefined,
      isAsking: asks.at(-1)?.state === 'asking' || aiCall?.controller !== undefined,
      asks,
      isCovered: covered,
      ...(due ? { due } : {}),
      ...(answered ? { workedSinceLast: activeMs(c.waits, answered.askedAt, at) } : {}),
    })
    clearAiTimer()
    if (plan.kind === 'ask') return askAi($, turn.id, plan.why)
    if (plan.kind === 'later') {
      try {
        const timer = $.clock.after(Math.max(1000, plan.inMs), () => planAi($))
        aiCall = { turnId: turn.id, timer, ...(aiCall?.controller ? { controller: aiCall.controller } : {}) }
      } catch {
        // no timers: the next event looks again
      }
    }
  })
}

/**
 * One AI ETA call for the turn running: made in the background, never by a
 * hook. The turn is marked before the call, so a reload never asks twice;
 * its earlier answers and what happened since go with a re-ask. The call's
 * own usage is tallied whatever its outcome; an answer that is a number
 * becomes the turn's latest, anything else draws nothing, and an answer made
 * for a state that changed while it was asked (a wait began, the work
 * changed shape) is dropped as stale.
 */
async function askAi($: Dollar, turnId: string, why: AiWhy) {
  if (!settings.aiEta) return
  const at = await now($)
  const c = await readCockpit($)
  const turn = c?.turn
  if (!c || !turn || turn.id !== turnId || endedTurns.has(turnId)) return
  const asks = turn.asks ?? []
  if (asks.at(-1)?.state === 'asking') return
  const lengths = turnLengths(c, priors)
  const elapsedMs = turnWorkSoFar(c, at)
  // What history alone says at the same moment, kept to score the two side by side.
  const historyMs = historyLeft(lengths, elapsedMs)
  const n = asks.length + 1
  const shape = shapeOf(c, isTurnCovered(c, at, etaContext()))
  const marked = { isMarked: false }
  await apply($, at, x => {
    if (x.turn?.id !== turnId || (x.turn.asks ?? []).length !== asks.length) return x
    marked.isMarked = true
    const ask: AiAsk = { n, askedAt: at, elapsedMs, why, state: 'asking', ...(historyMs !== undefined ? { historyMs: Math.round(historyMs) } : {}) }
    const { aiDue: _due, ...rest } = x.turn
    return { ...x, turn: { ...rest, asks: [...(x.turn.asks ?? []), ask], shape } }
  })
  if (!marked.isMarked) return
  const tasks = c.tasks && isListLive(c.tasks, turn.n) ? c.tasks.items.map(task => ({ title: task.title, status: task.status })) : undefined
  const cal = calibration(lengths, elapsedMs)
  // A re-ask: the answers before, and what happened since the latest.
  const previous: AiPrevious[] = asks.map(a => ({ at: a.askedAt, elapsedMs: a.elapsedMs, ...(a.state === 'answered' && a.leftMs !== undefined ? { leftMs: a.leftMs } : {}) }))
  const last = asks.at(-1)
  const since = last
    ? {
        workedMs: activeMs(c.waits, last.askedAt, at),
        heldMs: Math.max(0, at - last.askedAt - activeMs(c.waits, last.askedAt, at)),
        notes: (turn.log ?? []).filter(note => note.at > last.askedAt).map(note => note.text),
        ...(turn.lastWords ? { lastWords: turn.lastWords } : {}),
      }
    : undefined
  const request = aiRequest({
    elapsedMs,
    tools: turn.tools,
    ...(turn.text ? { text: turn.text } : {}),
    ...(turn.source ? { startedBy: startedBy(turn.source.kind) } : {}),
    ...(turn.words ? { words: turn.words } : {}),
    ...(tasks ? { tasks } : {}),
    ...(cal ? { calibration: cal } : {}),
    ...(previous.length > 0 ? { previous } : {}),
    ...(since ? { since } : {}),
  })
  // The turn may have ended while it was being marked: then there is nothing to ask about.
  if (endedTurns.has(turnId)) return
  const controller = new AbortController()
  clearAiTimer()
  aiCall = { turnId, controller }
  let result: ModelCompleteResult | undefined
  try {
    result = await $.model.complete(request, { signal: controller.signal })
  } catch (err) {
    // A request the engine would not send (a blocked model): no reply, no usage.
    debugLog($, 'ai', err)
  }
  if (aiCall?.controller === controller) aiCall = undefined
  const minutes = result?.isAnswered ? parseMinutes(result.text) : undefined
  const after = await now($)
  const latest = await readCockpit($)
  // Made for a state that changed while it was asked: a wait began, or the work changed shape.
  const isStale = !controller.signal.aborted && latest?.turn?.id === turnId && (latest.waits.some(w => w.main && w.from >= at) || shapeOf(latest, isTurnCovered(latest, after, etaContext())) !== shape)
  const outcome: AiOutcome = controller.signal.aborted || isStale ? 'cancelled' : !result?.isAnswered ? 'failed' : minutes === undefined ? 'unread' : 'answered'
  await serially(aiQueue, () => attempt(() => addAiCall(kvOf($), dayKey(at), c.sid, outcome, result?.usage), undefined))
  await apply($, after, x => {
    const asked = x.turn?.id === turnId ? (x.turn.asks ?? []).find(a => a.n === n) : undefined
    if (!x.turn || asked?.state !== 'asking') return x
    const ask: AiAsk = isStale
      ? { ...asked, state: 'stale' }
      : minutes !== undefined && outcome === 'answered'
        ? { ...asked, state: 'answered', leftMs: Math.round(minutes * MINUTE) }
        : { ...asked, state: outcome === 'cancelled' ? 'cancelled' : 'failed' }
    // A stale answer leaves its reason to ask standing: the state it was made for is gone.
    const due = isStale && !x.turn.aiDue ? { aiDue: { why: 'shape' as const, at: after } } : {}
    return { ...x, turn: { ...x.turn, asks: (x.turn.asks ?? []).map(a => (a.n === n ? ask : a)), ...due } }
  })
  await refreshAi($, after)
  planAi($)
}

/** The pane's AI ETA figures, read again from the store after a call or a scored turn. */
async function refreshAi($: Dollar, at: number) {
  const ai = await attempt(() => loadAiSummary(kvOf($), dayKey(at)), undefined)
  if (ai) await attempt(() => changeUi($, u => ({ ...u, ai })), defaultUi())
}

/**
 * Scores each of the AI's answers for a turn that ended on its own (an
 * interrupted one is no measure): what it said was left, what history alone
 * said at the same moment, and what was really left in the turn's working
 * time (its waits on the person since left out), each answer on its own.
 * Numbers only.
 */
async function scoreAi($: Dollar, sid: string, asks: readonly AiAsk[], waits: Cockpit['waits'], at: number) {
  const records: AiRecord[] = asks
    .filter(a => a.state === 'answered' && a.leftMs !== undefined)
    .map(a => [a.askedAt, a.elapsedMs, a.leftMs ?? 0, a.historyMs ?? -1, activeMs(waits, a.askedAt, at), a.n])
  if (records.length === 0) return
  for (const record of records) await serially(aiQueue, () => attempt(() => addAiRecord(kvOf($), sid, record), undefined))
  await refreshAi($, at)
}

/** The AI ETA as the pane shows it. */
function aiView(ui: UiState, at: number): AiView {
  const none = { n: 0, ai: 0, history: 0 }
  return { on: settings.aiEta, today: dayKey(at), days: ui.ai?.days ?? [], scores: ui.ai?.scores ?? { first: none, revised: none } }
}

// ------------------------------------------------------------------ how long commands take

/** The last runs of each command, by project: read at start-up, kept as written. */
let cmdLengths: CommandLengths | undefined

/** The record's writes go one after another: each reads what the last wrote. */
const runsQueue: Queue = { tail: Promise.resolve() }

/** Keeps a run of a command in the project's record, when it is long enough to estimate anything by. */
function noteRun($: Dollar, c: Cockpit, command: string, ms: number, at: number) {
  if (!isRunLength(ms)) return
  const project = c.meta.root ?? ''
  safely($, 'runs', () =>
    serially(runsQueue, async () => {
      cmdLengths = await addCommandRun(kvOf($), project, command, ms, at)
    }),
  )
}

/** The jobs that ended between two cockpits with both ends seen: their runs are kept for their commands. */
function noteEndedJobs($: Dollar, before: Cockpit, after: Cockpit, at: number) {
  for (const j of after.jobs) {
    const was = before.jobs.find(x => x.id === j.id)
    if (!was || !isJobRunning(was) || isJobRunning(j) || j.status !== 'done' || j.exitCode !== 0) continue
    const ms = jobLength(j)
    if (ms !== undefined && j.command) noteRun($, after, j.command, ms, at)
  }
}

// ------------------------------------------------------------------ files: the two uses of $.fs

/** Reads one of claude-hud's config files; undefined when it is not there. Read only. */
async function readHudFile($: Dollar, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

/** Writes the handover to the project. */
async function writeHandoverFile($: Dollar, path: string, text: string): Promise<boolean> {
  try {
    await $.fs.write(path, text)
    return true
  } catch {
    return false
  }
}

async function claudeConfigDir($: Dollar): Promise<string | undefined> {
  const dir = await attempt(() => $.env.get('CLAUDE_CONFIG_DIR'), undefined)
  if (dir) return dir.replace(/\/+$/, '')
  const home = await attempt(() => $.env.get('HOME'), undefined)
  return home ? `${home.replace(/\/+$/, '')}/.claude` : undefined
}

/** The first time quackpit runs where a person is at the prompt: one toast on where the pane is. */
async function welcome($: Dollar, kv: KV, at: number) {
  if ((await kv.get('welcomed')) !== undefined) return
  await kv.set('welcomed', at)
  toast($, t(settings.locale, 'toast.welcome'), 10_000)
}

/** First run only: claude-hud's enabled lines become the layout, said once in a toast. */
async function importHud($: Dollar, kv: KV, at: number): Promise<LayoutRecord | undefined> {
  if (await attempt(() => loadHud(kv), undefined)) return undefined
  const dir = await claudeConfigDir($)
  let mapped: TileId[] | undefined
  if (dir) {
    const shared = parseHudConfig(await readHudFile($, `${dir}/${HUD_FILES[0]}`))
    const local = parseHudConfig(await readHudFile($, `${dir}/${HUD_FILES[1]}`))
    const config = layerHud(shared, local)
    if (config) mapped = hudTiles(config)
  }
  await attempt(() => saveHud(kv, { checkedAt: at, ...(mapped ? { tiles: mapped } : {}) }), undefined)
  if (!mapped) return undefined
  const record = hudLayout(settings, mapped)
  await attempt(() => saveLayout(kv, record), undefined)
  toast($, t(settings.locale, 'toast.hud', { tiles: mapped.join(', ') }), 10_000)
  return record
}

// ------------------------------------------------------------------ session

let sessionId = ''

/** The id a cockpit carries between /clear and the next turn, which gives it the new session's. */
const CLEARED = '(cleared)'
/**
 * A /clear just ended the last session. Claude Code starts the next one's
 * state afresh, so the cleared cockpit written there may not carry over; this
 * module, which /clear keeps, remembers it instead, and the next session
 * starts at turn 1 rather than counting the commands in its transcript.
 */
let clearPending = false
/** The person's stretch of prompts when /clear came: they did not pause for it, so the next session carries it on. */
let clearedStretch: Stretch | undefined

async function currentSid($: Dollar): Promise<string> {
  return attempt(() => $.session.id(), sessionId)
}

/**
 * A fresh cockpit for this session: its record when quackpit kept one (a
 * process that restarted gets its turns back as they were at its last turn),
 * else rebuilt from the transcript when it has one.
 */
async function freshCockpit($: Dollar, at: number, sid: string): Promise<Cockpit> {
  const restored = sid !== CLEARED ? await attempt(() => loadSession(kvOf($), sid), undefined) : undefined
  const c = restored ?? (await fromTranscript($, at, sid))
  return withMeta($, c)
}

/** The project root and the model, as the session has them now. */
async function withMeta($: Dollar, c: Cockpit): Promise<Cockpit> {
  const root = await attempt(() => $.session.root(), undefined)
  const model = await attempt(() => $.session.model(), undefined)
  return onMeta(c, { ...(root ? { root, repo: baseName(root) } : {}), ...(model ? { model } : {}) })
}

/**
 * The project root and the model, read again into the cockpit kept: at
 * start-up, so a reload into a session whose cockpit has none (an older
 * version's, cleared) gets them, and at each turn's start, since /model
 * changes the model mid-session.
 */
async function refreshMeta($: Dollar, at: number, what: { root?: boolean } = { root: true }) {
  const root = what.root ? await attempt(() => $.session.root(), undefined) : undefined
  const model = await attempt(() => $.session.model(), undefined)
  if (!root && !model) return
  await apply($, at, c => onMeta(c, { ...(root ? { root, repo: baseName(root) } : {}), ...(model ? { model } : {}) }))
}

/** What the transcript still holds, for a session quackpit joined under way with no record of it. */
async function fromTranscript($: Dollar, at: number, sid: string): Promise<Cockpit> {
  let c = newCockpit(at, sid)
  const messages = await attempt(async () => {
    const rows = await $.session.messages()
    if (!Array.isArray(rows)) return [] as PastMessage[]
    return rows.map((m): PastMessage => ({ ...m, toolUses: m.toolUses.map(u => ({ ...u, outcome: outcomeOf(u.tool, u) })) }))
  }, [] as PastMessage[])
  if (messages.length > 0) {
    const turns = await attempt(() => $.session.turns(), 0)
    c = backfill(c, messages, at, turns)
    // What the transcript already held is history: the duck does not quack about it.
    const old = cautionsOf(c).map(k => k.key)
    c = markSeen(acknowledge(c, old), old)
  }
  return c
}

/** Follows a /clear or an in-process resume: another session id means another cockpit. */
async function syncSession($: Dollar, at: number): Promise<void> {
  const sid = await currentSid($)
  const c = await readCockpit($)
  if (c && c.sid === sid) return
  sessionId = sid
  // After /clear the cockpit is fresh already and only takes the new id: the new
  // transcript has nothing to rebuild, and counting its rows as turns would count
  // /clear itself and the prompt now starting.
  const cleared = c?.sid === CLEARED || clearPending
  clearPending = false
  // What came after the clear (an early event's cockpit, or the cleared one) carries on; nothing before it does.
  // Its model and project are read again: the cleared cockpit starts with none.
  const base = c && (c.sid === CLEARED || c.sid === '') ? c : newCockpit(at)
  // The person's stretch goes on through a /clear: theirs, not the session's.
  const stretch = cleared ? joinStretch(clearedStretch, base.stretch) : undefined
  clearedStretch = undefined
  const fresh = cleared ? await withMeta($, { ...base, sid, ...(stretch ? { stretch } : {}) }) : await freshCockpit($, at, sid)
  // Written only if no other event got there first: a cockpit already on this session stays.
  let kept: Cockpit = fresh
  await update($, cockpitAtom, raw => {
    const current = asCockpit(raw)
    kept = current && current.sid === sid ? current : current?.sid === CLEARED ? onMeta({ ...current, sid }, fresh.meta) : adoptEarly(fresh, current)
    return json(kept)
  })
  noteCockpit(kept)
}

/** The prompt cache's lifetime as the environment or the settings force it (read at start-up). */
let cacheForced: Ttl | undefined
/** What the other sessions' finished tasks and subagents took: read once at start-up. */
let priors: Durations = emptyDurations()

/** The environment and settings Claude Code decides the prompt cache's lifetime by. Read only. */
async function readCacheTtl($: Dollar): Promise<Ttl | undefined> {
  const merged: Readonly<Record<string, unknown>> = await attempt(() => $.settings.read(), {})
  const force5m = await attempt(() => $.env.get('FORCE_PROMPT_CACHING_5M'), undefined)
  const ttlVar = await attempt(() => $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'), undefined)
  const enable1h = await attempt(() => $.env.get('ENABLE_PROMPT_CACHING_1H'), undefined)
  return forcedTtl({ setting: merged.promptCacheTtl, ...(force5m ? { force5m } : {}), ...(ttlVar ? { ttlVar } : {}), ...(enable1h ? { enable1h } : {}) })
}

async function boot($: Dollar, isInteractive = true) {
  const at = await now($)
  cacheForced = await readCacheTtl($)
  const today = dayKey(at)
  const kv = kvOf($)
  let record = await attempt(() => loadLayout(kv), undefined)
  if (record && !isCurrent(record, settings)) {
    // userConfig changed since the override: the setting wins.
    await attempt(() => saveLayout(kv, undefined), undefined)
    record = undefined
  }
  if (!record) record = await attempt(() => importHud($, kv, at), undefined)
  const layout = effectiveLayout(settings, record)
  await attempt(() => rollUp(kv, today), undefined)
  const days = await attempt(() => loadDays(kv, today), [] as DayTotals[])
  await attempt(() => pruneAi(kv, today), undefined)
  const ai = await attempt(() => loadAiSummary(kv, today), undefined)
  await changeUi($, u => ({ ...u, layout, days, ...(ai ? { ai } : {}) }))
  sessionId = await currentSid($)
  await syncSession($, at)
  // A reload finds this session's cockpit kept: its model and project are read again all the same.
  await attempt(() => refreshMeta($, at), undefined)
  // After this session's own record was read back: the others' lengths stand in for the estimate.
  priors = await attempt(() => surveySessions(kv, sessionId, at), emptyDurations())
  // How long each command took the last few times: a background job's expected length.
  cmdLengths = await attempt(() => loadLengths(kv), undefined)
  const c = await attempt(() => readCockpit($), undefined)
  if (c) noteCockpit(c)
  // A reload mid-turn (the AI ETA just turned on, an edit) looks at the turn again, within its limits.
  if (c?.turn) planAi($)
  const reading = await readUsage($, at)
  if (reading) await fold($, at, c => onReading(c, reading))
  safely($, 'context', () => readContext($))
  if (isInteractive) await attempt(() => welcome($, kv, at), undefined)
  ensureTicker($)
}

// ------------------------------------------------------------------ hooks

/** `/config`'s tiles row refuses a name that is no tile, and says which tiles there are. */
export const onTilesSet: MatchedHook<'config.set', { readonly key: 'quackpit.tiles' }> = async ($, e, next) => {
  const unknown = unknownTiles(e.value)
  if (unknown.length > 0) return { deny: t(settings.locale, 'config.unknownTiles', { tiles: unknown.map(name => `"${name}"`).join(', '), list: availableTiles().join(', ') }) }
  return next(e)
}

/** The tiles row lists every tile there is. */
export const onTilesDescribe: MatchedHook<'config.describe', { readonly key: 'quackpit.tiles' }> = ($, e, next) =>
  next({ ...e, description: t(settings.locale, 'config.tilesHelp', { list: availableTiles().join(', ') }) })

export const onSessionStart: Events['session.start'] = async ($, e, next) => {
  try {
    const argumentHint = t(settings.locale, 'command.hint')
    await $.command.register({ name: 'quackpit', description: t(settings.locale, 'command.description'), argumentHint, immediate: true })
    await $.command.register({ name: 'quack', description: t(settings.locale, 'command.alias'), argumentHint, immediate: true })
  } catch {
    // the commands are a convenience; the band still draws
  }
  // The engine holds the first prompt for this hook, so the cockpit is ready when it
  // comes; should reading it (a long resumed transcript) take longer than that, the
  // session starts anyway and the cockpit fills in after.
  const booting = boot($, e.isInteractive).catch(err => debugLog($, 'boot', err))
  let timer: { cancel: () => void } | undefined
  await Promise.race([booting, new Promise<void>(resolve => (timer = startTimer($, BOOT_WAIT_MS, resolve)))])
  timer?.cancel()
  return next(e)
}

/** How long session.start waits for the cockpit before letting the session go on. */
const BOOT_WAIT_MS = 1500

/** A one-off timer; where there is no clock, `fn` runs at once. */
function startTimer($: Dollar, ms: number, fn: () => void): { cancel: () => void } | undefined {
  try {
    return $.clock.after(ms, fn)
  } catch {
    fn()
    return undefined
  }
}

/** The person's own prompts: typed, from their phone, or the SDK. */
function isPersonal(origin: PromptOrigin | undefined): boolean {
  return origin === undefined || ['composer', 'bridge', 'sdk', 'unclassified'].includes(origin.kind)
}

export const onPromptSubmit: Events['prompt.submit'] = async ($, e, next) => {
  const result = await next(e)
  try {
    if (result.drop === undefined) {
      const at = await now($)
      // A task's notice, as a turn of its own or delivered into one: the job or agent it names has ended.
      const notices = e.origin.kind === 'task-notification' ? parseNotices(result.text) : []
      let before: Cockpit | undefined
      // Folded: a background check that failed is a caution like any other.
      const after = await fold($, at, c => {
        before = c
        const told = notices.length > 0 ? onNotices(c, at, notices) : c
        return onPrompt(told, { at, text: result.text, isPersonal: isPersonal(e.origin) })
      })
      if (before && notices.length > 0) {
        noteEndedJobs($, before, after, at)
        planAi($)
      }
    }
  } catch {
    // fail open: the prompt went through untouched
  }
  return result
}

export const onTurnStart: Events['turn.start'] = async ($, e, next) => {
  try {
    const at = await now($)
    await syncSession($, at)
    const reading = await readUsage($, at)
    await fold($, at, c => {
      // Taken between turns, the reading settles the last turn's cost before this one starts.
      const started = startTurn(reading ? settleWith(c, reading) : c, { at, turnId: e.turnId, text: e.text, ...(reading?.costUsd !== undefined ? { costUsd: reading.costUsd } : {}) })
      return reading ? onReading(started, reading) : started
    })
    // /model may have changed it since the last turn.
    await attempt(() => refreshMeta($, at, {}), undefined)
    // The agents at work as the turn begins: ones left from earlier turns, a skill's, a teammate.
    safely($, 'agents', () => lookUpAgents($))
    // The AI ETA, when it is on, is due once the turn has worked a minute: a timer, never this hook's work.
    planAi($)
  } catch {
    // fail open
  }
  return next(e)
}

/**
 * Each main-loop model response, as it ends: pace counts its new tokens at
 * once. It observes only: every chunk passes on as it came, the request goes
 * out at once (the time is read alongside, not before), and the response is
 * handed back before quackpit folds it in. A subagent's steps are its own.
 */
export const onTurnStep: Events['turn.step'] = async function* ($, e, next) {
  // A loop's next request: whatever dialog held it is over, since it moved on.
  if (hint.waitLoops.has(e.agentId ?? MAIN_LOOP)) safely($, 'step start', () => endLoopWaits($, e.agentId))
  if (e.agentId !== undefined) return yield* next(e)
  const startedAt = now($)
  const response = yield* next(e)
  safely($, 'step', () => foldStep($, e.turnId, e.model, response, startedAt))
  return response
}

/** The waits of one loop end: it went on to its next request. */
async function endLoopWaits($: Dollar, agentId: string | undefined) {
  const at = await now($)
  await apply($, at, c => onStepStart(c, { at, ...(agentId !== undefined ? { agentId } : {}) }))
  planAi($)
}

async function foldStep($: Dollar, turnId: string, model: string, response: TurnStepResult, startedAt: Promise<number>) {
  if (!response.usage) return
  const at = await now($)
  const began = await startedAt
  const usage = response.usage
  await fold($, at, c => onStep(c, { at, startedAt: began, turnId, model, usage, answer: response.answer }))
}

/** The readings Claude Code pushes after each main turn and when a plan window moves a point. */
export const onMeasure: Events['session.measure'] = async ($, e, next) => {
  const result = await next(e)
  try {
    const at = await now($)
    const reading: Reading = { ...readingOf(e, at), pushed: true }
    const c = await fold($, at, before => onReading(before, reading))
    if (isCompactPointDue(c)) safely($, 'context', () => readContext($))
  } catch {
    // fail open
  }
  return result
}

let isReadingPoint = false

/** The breakdown as the split reads it: /context's rows and the lists beneath them, plain. */
function breakdownOf(b: NonNullable<SessionUsage['context']['breakdown']>): BreakdownInput {
  return {
    categories: b.categories.map(row => ({ name: row.name, tokens: isNum(row.tokens) ? row.tokens : 0, kind: row.kind })),
    mcpTools: (b.mcpTools ?? []).map(tool => ({ serverName: tool.serverName, tokens: isNum(tool.tokens) ? tool.tokens : 0, isLoaded: tool.isLoaded === true })),
    memoryFiles: (b.memoryFiles ?? []).map(file => ({ path: file.path, tokens: isNum(file.tokens) ? file.tokens : 0 })),
    agents: (b.agents ?? []).map(agent => ({ agentType: agent.agentType, tokens: isNum(agent.tokens) ? agent.tokens : 0 })),
    ...(b.skills ? { skills: { totalSkills: b.skills.totalSkills, includedSkills: b.skills.includedSkills, tokens: b.skills.tokens } } : {}),
  }
}

/**
 * What fills the context, and where Claude Code compacts it by itself: the
 * breakdown /context draws, which the engine estimates locally (`summary`
 * sends no request), and the conversation the next request is built from
 * (`$.session.messages({ as: 'api' })`, the live window after a compaction),
 * measured by source: sizes and tool names, never its words. Once at
 * start-up, at most once a turn after it (when the turn's reading arrives),
 * and once after a compaction, which no reading follows. A timer's work,
 * never a drawing's.
 */
async function readContext($: Dollar) {
  if (isReadingPoint) return
  isReadingPoint = true
  try {
    const usage = await attempt(() => $.session.usage({ breakdown: 'summary' }), undefined)
    const b = usage?.context.breakdown
    if (!b) return
    const at = await now($)
    const c = await fold($, at, before => onCompactPoint(before, { at, isOn: b.isAutoCompactEnabled === true, ...(isNum(b.autoCompactThreshold) ? { threshold: b.autoCompactThreshold } : {}) }))
    const messages = await attempt(() => $.session.messages({ as: 'api' }), undefined)
    if (!Array.isArray(messages)) return
    const home = await attempt(() => $.env.get('HOME'), undefined)
    const root = c.meta.root
    const split = splitOf(breakdownOf(b), measureMessages(messages, root), at, c.turnCount, { ...(root ? { root } : {}), ...(home ? { home } : {}) })
    await apply($, at, before => onContextSplit(before, split))
  } finally {
    isReadingPoint = false
  }
}

/** The tool's own arguments, without the envelope. */
function argsOf(e: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, requestMeta: _meta, ...args } = e
  return args
}

/** A shell command that ran and exited non-zero: Claude Code's error for it starts so. */
const EXITED_RE = /^Exit code \d+/
/** Esc while (or before) it ran, or a call cut off to deliver a message. */
const STOPPED_RE = /\[Request interrupted by user|\[Tool call did not complete/
/** The permission dialog's no, or a permission rule or mode that refused it. */
const REFUSED_RE = /^The user doesn't want to proceed with this tool use|has been denied/

/**
 * How a tool call ended. Claude Code answers a call that never ran (refused at
 * the dialog, by a rule or a hook, or by the tool's own check, as Bash blocks a
 * leading `sleep`) with an error, as it does a failure; so do Esc and a timeout.
 * A refused or interrupted test is not a failed one, so its words tell them
 * apart. A shell command that ran says how it exited (`Exit code 1`): without
 * that, and without a runner's summary in what it printed, it never ran.
 */
function outcomeOf(tool: string, ran: { readonly deny?: string; readonly isError?: true; readonly text?: string; readonly result?: unknown }): ToolEnd['outcome'] {
  if (ran.deny !== undefined) return 'denied'
  if (ran.isError !== true) return 'ok'
  const text = ran.text ?? (typeof ran.result === 'string' ? ran.result : '')
  if (STOPPED_RE.test(text)) return 'interrupted'
  if (tool === 'Bash') {
    const counts = parseCounts(text)
    const printed = counts.passed !== undefined || counts.failed !== undefined || counts.errors !== undefined
    return EXITED_RE.test(text) || printed ? 'error' : 'denied'
  }
  return REFUSED_RE.test(text) ? 'denied' : 'error'
}

/**
 * Claude's calls that were put to a decider (the permission dialog, the mode's
 * own): measured around the call, their time is the wait's as much as the run's.
 */
const asked = new Set<string>()

/**
 * Calls of every loop that the permission check put to a decider (`ask`), the
 * latest few: a permission dialog names no call, so the one it is for is the
 * latest such call of the same loop and tool (its input the same, where it
 * can tell).
 */
const asks = new Map<string, { tool: string; agentId?: string; input: string; at: number }>()

/** A tool's input as one string, to tell two calls of a tool apart. */
const inputKey = (x: unknown) => {
  try {
    return JSON.stringify(x) ?? ''
  } catch {
    return ''
  }
}

export const onToolCheck: Events['tool.check'] = async ($, e, next) => {
  const verdict = await next(e)
  if (verdict.decision === 'ask' && e.tool_use_id !== undefined && next.origin.plugin === 'engine') {
    if (e.agentId === undefined) {
      if (asked.size >= 64) asked.clear()
      asked.add(e.tool_use_id)
    }
    if (asks.size >= 64) asks.delete(asks.keys().next().value as string)
    asks.set(e.tool_use_id, { tool: e.tool, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}), input: inputKey(e.input), at: await now($) })
  }
  return verdict
}

/**
 * A permission dialog about to show. Read only: the answer beneath goes up
 * unchanged. Where no hook beneath settled it (no `decision`), the dialog
 * really shows and the loop that asked waits on the person until the call
 * goes on: its first progress, its end, or the loop's next request. An ask
 * the auto-mode classifier settles raises no dialog and no wait (a live run
 * showed the classifier approve with no PermissionRequest at all); a
 * question or a plan is its own call's wait already.
 */
export const onPermissionRequest: Events['classic.PermissionRequest'] = async ($, e, next) => {
  const answer = await next(e)
  try {
    if (answer.decision !== undefined || answer.block !== undefined || waitKindOf(e.tool_name)) return answer
    const at = await now($)
    const want = inputKey(e.tool_input)
    const mine = [...asks.entries()].filter(([, a]) => a.tool === e.tool_name && a.agentId === e.agent_id && at - a.at < 120_000)
    const call = (mine.findLast(([, a]) => a.input === want) ?? mine.at(-1))?.[0]
    if (call) asks.delete(call)
    await apply($, at, c => onWaitStart(c, { at, kind: 'permission', tool: e.tool_name, ...(call ? { toolUseId: call } : {}), ...(e.agent_id !== undefined ? { agentId: e.agent_id } : {}), ...(e.agent_type ? { agentType: e.agent_type } : {}) }))
    redraw($)
    planAi($)
  } catch {
    // fail open: the dialog shows as it would
  }
  return answer
}

/**
 * A running call's progress row (the run-in-background hint under a shell):
 * its drawing means the person answered the dialog that held it, so the wait
 * ends here, before the call does. Drawing only: the row draws as the engine
 * has it, and the state is written by a timer, since a drawing may not write.
 */
export const renderProgress: MatchedHook<'ui.render', { readonly component: 'ToolProgress' }> = async ($, e, next) => {
  const id = e.props.tool_use_id
  if (hint.waitIds.has(id)) {
    hint.waitIds.delete(id)
    try {
      $.clock.after(0, () => safely($, 'progress', () => endCallWait($, id)))
    } catch {
      // no timers: the call's end ends the wait
    }
  }
  return next(e)
}

/** The band was drawn again: every permission dialog asked for before it is answered. */
async function closeDialogs($: Dollar, at: number) {
  await apply($, at, c => onDialogsClosed(c, at))
  planAi($)
}

async function endCallWait($: Dollar, toolUseId: string) {
  const at = await now($)
  await apply($, at, c => onWaitEnd(c, { at, toolUseId }))
  planAi($)
}

/**
 * An agent loop starting: the Agent tool's, a workflow's, a plugin's, one
 * another agent started. Read only: its id, its type and who started it go
 * into the list the timeline shows; only Claude's own count in the estimate.
 */
export const onAgentSpawned: Events['agent.spawn'] = async ($, e, next) => {
  const started = await next(e)
  try {
    if (started.agentId) {
      const at = await now($)
      const plugin = next.origin.plugin !== 'engine' ? next.origin.plugin : undefined
      const parent = e.parentAgentId
      const by: NonNullable<AgentRun['by']> = plugin ? 'plugin' : parent ? 'agent' : e.workflow ? 'workflow' : 'main'
      const agentId = started.agentId
      await apply($, at, c => {
        const byName = plugin ?? (parent ? (c.agents.find(a => a.agentId === parent)?.type ?? 'subagent') : undefined)
        return onAgentSpawn(c, { at, toolUseId: e.tool_use_id, agentId, type: e.subagentType, description: e.description, background: e.background, by, ...(byName ? { byName } : {}), ...(e.isTeammate ? { isTeammate: true } : {}) })
      })
      planAi($)
    }
  } catch {
    // fail open
  }
  return started
}

export const onToolCall: Events['tool.call'] = async ($, e, next) => {
  // Another loop's call: only a wait on the person it held ends with it; its tools never reach a gauge.
  if (e.agentId !== undefined) {
    const ran = await next(e)
    if (hint.waitIds.has(e.tool_use_id)) safely($, 'wait end', () => endCallWait($, e.tool_use_id))
    // A shell or a monitor it sent to the background is that loop's work: a turn's end lists it, never as Claude's job.
    const result = ran.result as { backgroundTaskId?: unknown; taskId?: unknown } | undefined
    const taskId = typeof result?.backgroundTaskId === 'string' ? result.backgroundTaskId : e.tool === 'Monitor' && typeof result?.taskId === 'string' ? result.taskId : undefined
    if (taskId) safely($, 'foreign task', async () => apply($, await now($), c => onForeignTask(c, taskId)))
    return ran
  }
  // Claude's own calls only: a call another plugin raised (its own `$.tool.call`) is that plugin's, not Claude's check or command.
  if (next.origin.plugin !== 'engine') return next(e)
  const tool = String(e.tool)
  const input = argsOf(e as unknown as Record<string, unknown>)
  let startedAt: number | undefined
  try {
    const at = await now($)
    startedAt = at
    await apply($, at, c => onToolStart(c, { at, id: e.tool_use_id, tool, input }))
    // A question or a plan put to the person holds the turn: a timer's look at the AI ETA stops meanwhile.
    if (waitKindOf(tool)) planAi($)
  } catch {
    // fail open
  }
  const ran = await next(e)
  const wasAsked = asked.delete(e.tool_use_id)
  asks.delete(e.tool_use_id)
  try {
    const at = await now($)
    const outcome = outcomeOf(tool, ran)
    let before: Cockpit | undefined
    const after = await fold($, at, c => {
      before = c
      return onToolEnd(c, { at, id: e.tool_use_id, tool, input, outcome, text: ran.deny ?? ran.text ?? '', result: ran.result, ...(wasAsked ? { wasAsked } : {}) })
    })
    // A command's own run, in the foreground and not held by a dialog: how long it took, for the next time it runs.
    const result = (ran.result ?? {}) as { backgroundTaskId?: unknown }
    if (tool === 'Bash' && typeof input.command === 'string' && startedAt !== undefined && !wasAsked && outcome === 'ok' && typeof result.backgroundTaskId !== 'string') noteRun($, after, input.command, at - startedAt, at)
    if (before) noteEndedJobs($, before, after, at)
    planAi($)
  } catch {
    // fail open
  }
  return ran
}

export const onTurnComplete: Events['turn.complete'] = async ($, e, next) => {
  const result = await next(e)
  if (e.agentId !== undefined) {
    // A subagent's loop ended a turn: it is done (a teammate goes idle), its waits end. Its tokens never count here.
    const agentId = e.agentId
    safely($, 'agent end', async () => {
      const at = await now($)
      await apply($, at, c => onAgentTurnEnd(c, { at, agentId, isAborted: e.isAborted }))
      planAi($)
    })
    return result
  }
  // The AI ETA's timer or call, if any, ends with the turn.
  if (endedTurns.size >= 16) endedTurns.clear()
  endedTurns.add(e.turnId)
  disarmAi(e.turnId)
  try {
    const at = await now($)
    const ended: { asks?: AiAsk[]; waits?: Cockpit['waits'] } = {}
    // Its cost comes with the reading Claude Code pushes after the turn (session.measure).
    const c = await fold($, at, before => {
      if (before.turn?.id === e.turnId) ended.asks = before.turn.asks
      const after = onTurnEnd(before, { at, turnId: e.turnId, tokens: newTokens(e.usage), durationMs: e.durationMs, isAborted: e.isAborted, answer: e.answer })
      ended.waits = after.waits
      return after
    })
    const asks = ended.asks
    if (asks && asks.length > 0 && !e.isAborted) safely($, 'ai score', () => scoreAi($, c.sid, asks, ended.waits ?? [], at))
    const last = c.history.at(-1)
    if (last && last.endedAt === at) {
      // Its working minutes, its waits on the person left out, as your usual pace counts them.
      await attempt(() => addToDay(kvOf($), dayKey(at), c.sid, last.tokens, turnLength(last) / MINUTE), undefined)
      // The session's record, once a turn: what a restart brings back.
      if (c.sid !== '' && c.sid !== CLEARED) safely($, 'record', () => saveSession(kvOf($), toRecord(c, at)))
    }
    // The agents still at work as the turn ends: Claude comes back to them.
    safely($, 'agents', () => lookUpAgents($))
  } catch {
    // fail open
  }
  return result
}

export const onSessionCompact: Events['session.compact'] = async ($, e, next) => {
  const result = await next(e)
  try {
    const at = await now($)
    // The context's fill is unknown until the next response reports it.
    const isMain = e.agentId === undefined && result.skip === undefined && e.trigger !== 'precompute'
    await fold($, at, c => onCompact(c, { at, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}), isSkipped: result.skip !== undefined, isPrecompute: e.trigger === 'precompute' }))
    // No reading follows a compaction: what fills the window now is measured at once, ready when the fill is known again.
    if (isMain) safely($, 'context', () => readContext($))
  } catch {
    // fail open
  }
  return result
}

/** Effort and permission mode, as the main turn's Stop hook input carries them. */
/**
 * Effort and permission mode, as the main turn's Stop hook input carries
 * them; and the background work still in flight as the turn ends (its
 * `background_tasks`): the jobs and agents Claude will come back to.
 */
export const onStop: Events['classic.Stop'] = async ($, e, next) => {
  try {
    if (e.agent_id === undefined) {
      const at = await now($)
      const effort = e.effort?.level
      const mode = e.permission_mode
      const tasks: ListedTask[] | undefined = Array.isArray(e.background_tasks) ? e.background_tasks.map(task => ({ id: task.id, type: task.type, status: task.status, description: task.description, ...(task.command ? { command: task.command } : {}), ...(task.agent_type ? { agent_type: task.agent_type } : {}), ...(task.name ? { name: task.name } : {}) })) : undefined
      await apply($, at, c => {
        const withMeta = effort || mode ? onMeta(c, { ...(effort ? { effort } : {}), ...(mode ? { mode } : {}) }) : c
        return tasks ? onBackgroundTasks(withMeta, at, tasks) : withMeta
      })
    }
  } catch {
    // fail open
  }
  return next(e)
}

export const onSessionEnd: Events['session.end'] = async ($, e, next) => {
  disarmAi()
  try {
    if (e.reason === 'clear') {
      clearPending = true
      const at = await now($)
      clearedStretch = (await attempt(() => readCockpit($), undefined))?.stretch
      const kept = clearedStretch
      await update($, cockpitAtom, () => json({ ...newCockpit(at, CLEARED), ...(kept ? { stretch: kept } : {}) }))
    }
  } catch {
    // fail open
  }
  return next(e)
}

// ------------------------------------------------------------------ pane and commands

/** The terminal's width as quackpit last saw it: a command's `presentation`, else the band's viewport. */
let terminalColumns: number | undefined

/**
 * The pane's size. Docked beside a fullscreen transcript, as wide as leaves
 * the transcript 70 columns or more (85 less, between 56 and 96); seated
 * inline above the prompt, about 12 rows, scrolling for the rest. It never
 * takes the prompt's keys as it opens, and Esc in it gives them back without
 * closing it: a pane that stays open beside the prompt is clicked into and
 * left, not dismissed (/quackpit, its close mark and ctrl+x x close it).
 */
export function paneArgs(columns: number | undefined): PaneOpenArgs {
  const dock = columns !== undefined && Number.isFinite(columns) ? Math.max(56, Math.min(96, Math.floor(columns) - 85)) : undefined
  return { id: PANE_ID, title: 'quackpit', rows: 12, ...(dock !== undefined ? { columns: dock } : {}) }
}

async function openPane($: Dollar) {
  try {
    const opened = await $.ui.open(paneArgs(terminalColumns))
    if (!opened.isPlaced) toast($, t(settings.locale, 'toast.unplaced', { reason: opened.reason }))
  } catch {
    // the band stays as it was
  }
}

async function togglePane($: Dollar) {
  const panes = await attempt(() => $.ui.panes(), [])
  if (panes.some(pane => pane.id === PANE_ID && pane.isShown)) {
    await attempt(() => $.ui.close({ id: PANE_ID }), undefined)
    return
  }
  await openPane($)
}

/** The cockpit the band and pane show: this session's, or an empty one before the first event. */
async function shownCockpit($: Dollar, at: number): Promise<Cockpit> {
  return (await readCockpit($)) ?? newCockpit(at)
}

/** The handover as it stands now: deterministic, so built afresh wherever it is shown. */
async function handoverText($: Dollar, at: number): Promise<string> {
  const c = await shownCockpit($, at)
  const root = c.meta.root ?? (await attempt(() => $.session.root(), undefined))
  return buildHandover({ c, now: at, locale: settings.locale, ...(root ? { root } : {}) })
}

async function handover($: Dollar, surface?: RenderSurface) {
  const at = await now($)
  const text = await handoverText($, at)
  const root = await attempt(() => $.session.root(), undefined)
  const path = root ? `${root.replace(/\/+$/, '')}/${HANDOVER_PATH}` : HANDOVER_PATH
  const written = await writeHandoverFile($, path, text)
  const copied = await attempt(async () => (await $.ui.copy({ text, ...(surface ? { surface } : {}) })).isCopied === true, false)
  await changeUi($, u => ({ ...u, handover: { at, written } }))
  await attempt(() => apply($, at, c => markHandover(c, at)), newCockpit(at))
  const L = settings.locale
  const key = !written ? 'toast.handoverFailed' : copied ? 'toast.handoverCopied' : 'toast.handover'
  toast($, t(L, key, { path: HANDOVER_PATH }), 8000)
  await openPane($)
}

async function copyHandover($: Dollar, surface: RenderSurface) {
  const at = await now($)
  const text = await handoverText($, at)
  const copied = await attempt(async () => (await $.ui.copy({ text, surface })).isCopied === true, false)
  toast($, t(settings.locale, copied ? 'toast.copied' : 'toast.copyFailed', { path: HANDOVER_PATH }))
}

async function changeLayout($: Dollar, apply_: (record: LayoutRecord | undefined) => Change, messages: { done: string; already?: string; missing?: string; unknown?: string; bad?: string }) {
  const kv = kvOf($)
  const before = await attempt(() => loadLayout(kv), undefined)
  const change = apply_(before)
  if (change.outcome === 'done') {
    await attempt(() => saveLayout(kv, change.record), undefined)
    const layout = effectiveLayout(settings, change.record)
    await changeUi($, u => ({ ...u, layout }))
    toast($, messages.done)
  } else {
    toast($, messages[change.outcome] ?? messages.done)
  }
}

async function runCommand($: Dollar, args: string) {
  const command = parseCommand(args)
  // A change of layout reads the stored override and writes it back: two quick ones go in turn.
  const isLayout = ['add', 'remove', 'move', 'rows', 'duck', 'reset'].includes(command.kind)
  return isLayout ? serially(layoutQueue, () => runParsed($, command)) : runParsed($, command)
}

async function runParsed($: Dollar, command: ReturnType<typeof parseCommand>) {
  const L = settings.locale
  const list = availableTiles().join(', ')
  switch (command.kind) {
    case 'pane':
      return togglePane($)
    case 'add':
      return changeLayout($, r => addTile(settings, r, command.tile, command.at), {
        done: t(L, 'toast.added', { tile: command.tile }),
        already: t(L, 'toast.already', { tile: command.tile }),
        unknown: t(L, 'toast.unknownTile', { tile: command.tile, list }),
      })
    case 'remove':
      return changeLayout($, r => removeTile(settings, r, command.tile), {
        done: t(L, 'toast.removed', { tile: command.tile }),
        missing: t(L, 'toast.notThere', { tile: command.tile }),
        unknown: t(L, 'toast.unknownTile', { tile: command.tile, list }),
      })
    case 'move':
      return changeLayout($, r => moveTile(settings, r, command.tile, command.to), {
        done: t(L, 'toast.moved', { tile: command.tile, n: command.to ?? '?' }),
        unknown: t(L, 'toast.unknownTile', { tile: command.tile, list }),
        bad: t(L, 'toast.help', { list }),
      })
    case 'rows':
      return changeLayout($, r => setRows(settings, r, command.n), { done: command.n === 1 ? t(L, 'toast.row') : t(L, 'toast.rows', { n: command.n ?? '?' }), bad: t(L, 'toast.rowsBad') })
    case 'duck': {
      const ui = await readUi($)
      const on = command.on ?? !ui.layout.duck
      return changeLayout($, r => setDuck(settings, r, on), { done: t(L, on ? 'toast.duckOn' : 'toast.duckOff') })
    }
    case 'reset': {
      await attempt(() => saveLayout(kvOf($), undefined), undefined)
      const base = effectiveLayout(settings, undefined)
      await changeUi($, u => ({ ...u, layout: base }))
      return toast($, t(L, 'toast.reset', { list: base.tiles.join(', '), rows: base.rows, duck: t(L, base.duck ? 'word.on' : 'word.off') }))
    }
    case 'handover':
      await setView($, () => ({ view: 'handover' }))
      return handover($)
    case 'guide':
      await setView($, () => ({ view: 'guide' }))
      return openPane($)
    case 'view': {
      const view = command.view
      // The command reads a view's English name, so another language shows it beside its own.
      if (!view) return toast($, t(L, 'toast.views', { list: VIEW_IDS.map((id, i) => `${i + 1} ${t(L, `view.${id}`)}${t(L, `view.${id}`) === id ? '' : ` (${id})`}`).join(' · ') }), 10_000)
      await setView($, () => ({ view }))
      return openPane($)
    }
    case 'detail':
      return openTile($, command.tile)
    case 'help':
      return toast($, t(L, 'toast.help', { list }), 12_000)
    case 'ai':
      return aiCommand($, command.on)
  }
}

/**
 * `/quackpit ai on|off` turns the AI ETA's setting on or off, as its row in
 * /config does (which reloads quackpit with it); `/quackpit ai` says how it
 * stands and what it spent today.
 */
async function aiCommand($: Dollar, on: boolean | undefined) {
  const L = settings.locale
  if (on === undefined) {
    if (!settings.aiEta) return toast($, t(L, 'toast.aiStateOff'), 10_000)
    const at = await now($)
    const ui = await readUi($)
    const today = aiView(ui, at).days.find(d => d.day === dayKey(at))?.tally
    const calls = today?.calls ?? 0
    return toast($, t(L, 'toast.aiStateOn', { calls: t(L, calls === 1 ? 'ai.call' : 'ai.calls', { n: calls }), tokens: formatTokens(today ? tallyTokens(today) : 0) }), 10_000)
  }
  const set = await attempt(() => $.config.set({ key: 'quackpit.aiEta', value: on }), { deny: 'no config' })
  toast($, set.deny !== undefined ? t(L, 'toast.aiFailed') : t(L, on ? 'toast.aiOn' : 'toast.aiOff'), 10_000)
}

export const onQuackpitCommand: MatchedHook<'command.run', { readonly command: 'quackpit' }> = async ($, e) => {
  try {
    terminalColumns = e.presentation.columns
    await runCommand($, e.args ?? '')
  } catch {
    // fail open
  }
  return {}
}

export const onQuackCommand: MatchedHook<'command.run', { readonly command: 'quack' }> = async ($, e) => {
  try {
    terminalColumns = e.presentation.columns
    await runCommand($, e.args ?? '')
  } catch {
    // fail open
  }
  return {}
}

// ------------------------------------------------------------------ drawing

let bandRequestId: string | undefined
let probe: 'idle' | 'scheduled' | 'done' = 'idle'
let probeTries = 0

/** Blits a 1x1 picture once: taken, the terminal shows images; refused with its alt, it does not. */
async function runProbe($: Dollar) {
  try {
    if (!bandRequestId) throw new Error('no band yet')
    const result = await $.ui.blit({ requestId: bandRequestId, key: 'qp-probe', source: probeImage() })
    let graphics: UiState['graphics'] | undefined
    if (result.deny === undefined) graphics = 'pixels'
    else if (/alt|placeholder|cannot|picture|image/i.test(result.deny)) graphics = 'text'
    if (graphics) {
      probe = 'done'
      const found = graphics
      await changeUi($, u => ({ ...u, graphics: found }))
      return
    }
  } catch {
    // retried below
  }
  probeTries++
  probe = probeTries >= 3 ? 'done' : 'idle'
  if (probe === 'done') await attempt(() => changeUi($, u => ({ ...u, graphics: 'text' })), defaultUi())
}

function scheduleProbe($: Dollar) {
  if (probe !== 'idle') return
  probe = 'scheduled'
  try {
    $.clock.after(400, () => void runProbe($))
  } catch {
    probe = 'done'
  }
}

/** One frame of the quack, swapped in place: the Raster's cells, or the Image's source. */
async function blitDuck($: Dollar, frame: Frame, pixels: boolean) {
  if (!bandRequestId) return
  try {
    if (pixels) await $.ui.blit({ requestId: bandRequestId, key: 'duck-g', source: duckImage(frame) })
    else await $.ui.blit({ requestId: bandRequestId, key: 'duck-g', cells: duckCells(frame, 2).cells })
  } catch {
    // the band moved on; the next draw shows the duck as it stands
  }
}

/**
 * The only time the duck moves: a caution appears, its head comes up and its
 * beak flaps twice, about a second in all, then it holds still. Idle, nothing runs.
 */
function playQuackFrames($: Dollar, pixels: boolean) {
  QUACK_FRAMES.slice(1).forEach((frame, i) => {
    try {
      $.clock.after(QUACK_FRAME_MS * (i + 1), () => void blitDuck($, frame, pixels))
    } catch {
      // no timers: the duck simply shows its alert pose
    }
  })
}

function contextFor(ui: UiState, at: number) {
  const today = dayKey(at)
  return { now: at, locale: settings.locale, days: ui.days, today, priors, aiOn: settings.aiEta, ...(cmdLengths ? { lengths: cmdLengths } : {}) }
}

/** The engine's own drawing of a site, with the props it was asked with: an empty band where no survey holds it. */
const ENGINE_OWN: RenderElement = { type: 'engine', ref: 0 }

export const renderBand: MatchedHook<'ui.render', { readonly component: 'AbovePrompt' }> = async ($, e, next) => {
  // Asked once, and first: each further call would run every hook beneath again.
  // Beneath is the band another mod drew there, or the engine's own empty one;
  // a dispatch that failed beneath reads as the empty one.
  const below = await attempt(() => next(e), ENGINE_OWN)
  if (e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) return below
  try {
    const at = await now($)
    const ui = await readUi($)
    // In a terminal the band is drawn only while no dialog shows: a permission dialog that held a call is answered.
    const isClear = e.surface === 'terminal'
    if (isClear && hint.hasDialog) {
      hint.hasDialog = false
      try {
        $.clock.after(0, () => safely($, 'dialogs', () => closeDialogs($, at)))
      } catch {
        // no timers: the call's progress or its end ends the wait
      }
    }
    const shown = await shownCockpit($, at)
    const c = isClear ? onDialogsClosed(shown, at) : shown
    const r = readingsOf(c, contextFor(ui, at))
    const width = e.props.bodyColumns
    // A tile's click opens the pane at the width the terminal has: the band's own column and the engine's five.
    terminalColumns = e.viewport?.columns ?? width + 5
    // Another mod's band beneath shares the rows; quackpit cannot measure it, so it takes fewer.
    const isShared = !drawsNothing(below)
    const rows = isShared ? sharedRows(ui.layout.rows, e.props.maxRows) : Math.min(ui.layout.rows, e.props.maxRows)
    if (rows < 1) return below
    const isDense = width < DENSE_BELOW || rows < 2
    // Until the picture probe has answered, its 1x1 Image needs a column of the first line.
    const withProbe = e.surface === 'terminal' && settings.graphics === 'auto' && ui.graphics === 'unknown'
    const reserved = withProbe ? (isDense ? 2 : 1) : 0
    const plan = planBand({
      readings: r,
      tiles: ui.layout.tiles,
      width: width - reserved,
      rows,
      maxRows: rows,
      withDuck: ui.layout.duck,
    })
    if (!planDraws(plan)) return below
    let kit: Kit
    if (e.surface === 'terminal') {
      bandRequestId = e.requestId
      const pixels = settings.graphics === 'pixels' || (settings.graphics === 'auto' && ui.graphics === 'pixels')
      if (withProbe) scheduleProbe($)
      kit = { surface: 'terminal', T: $.ui.resolve(e), pixels }
      // A caution just announced: draw the duck still idle, then let it quack (blits, no redraws).
      // Settled before it was drawn (acknowledged, or its cause gone), there is nothing to quack about.
      const duck = plan.kind === 'grid' ? plan.lines[0]?.find(f => f.id === 'duck') : undefined
      if (quackDue && r.duck.pose !== 'alert') quackDue = false
      if (quackDue && duck?.graphic?.kind === 'duck') {
        quackDue = false
        duck.graphic = { ...duck.graphic, pose: 'idle' }
        playQuackFrames($, pixels)
      }
    } else {
      kit = { surface: 'desktop', T: $.ui.resolve(e) }
    }
    const mine = drawBand(
      kit,
      plan,
      { openPane: () => void openPane($), openTile: id => safely($, 'tile', () => openTile($, id)), acknowledge: () => safely($, 'acknowledge', () => acknowledgeNow($)) },
      { withProbe, probeSource: probeImage(), width },
    )
    if (!isShared) return mine
    // Both bands, quackpit's rows nearest the prompt.
    const { Box } = kit.T
    return (
      <Box flexDirection="column">
        {below}
        {mine}
      </Box>
    )
  } catch (err) {
    debugLog($, 'band', err)
    return below
  }
}

async function acknowledgeNow($: Dollar) {
  const at = await now($)
  await apply($, at, c => acknowledge(c, cautionsOf(c).map(k => k.key)))
  toast($, t(settings.locale, 'toast.ack'), 4000)
}

/**
 * Where the pane's body stands in the terminal's pinned window, and what the
 * last drawing put in it: kept by the module, since a drawing may not write
 * state. The scroll and focus hooks move `top`; a new view starts at the top.
 */
const pin = { isPinned: false, scope: '', top: 0, rows: 0, body: 0, keys: new Map<string, { at: number; height: number }>() }

/** The pane's rows when the engine gave none (a surface that does not say): about a docked pane's. */
const PANE_ROWS_FALLBACK = 40

export const renderPane: MatchedHook<'ui.render', { readonly component: 'Pane'; readonly requestId: 'quackpit' }> = async ($, e, next) => {
  try {
    const at = await now($)
    const ui = await readUi($)
    const c = await shownCockpit($, at)
    const r = readingsOf(c, contextFor(ui, at))
    const L = settings.locale
    const width = Math.max(1, e.props.bodyColumns)
    const paneRows = e.props.scroll?.bodyRows || PANE_ROWS_FALLBACK
    const view = viewOf(ui)
    const root = c.meta.root ? { root: c.meta.root } : {}
    const detail = view.view === 'overview' ? view.detail : undefined
    const named = (id: DetailId, w: number) => ({ name: t(L, id === 'limits' ? 'dial.fiveTitle' : id === 'pace' ? 'dial.paceTitle' : `tile.${id}`), detail: detailOf(r, id, w, root) })
    const body = (plan: OverviewPlan): BodyPart[] => {
      if (detail) return drillBody(r, width, named(detail, width), t(L, 'pane.back'), w => named(detail, w))
      return viewBody(view.view, plan, c, r, ui, at, width)
    }
    const model = paneModel(r, { width, rows: paneRows, view: { view: view.view, ...(detail ? { detail } : {}) }, isFocused: e.props.isFocused, body })
    const kit: Kit =
      e.surface === 'terminal'
        ? { surface: 'terminal', T: $.ui.resolve(e), pixels: settings.graphics === 'pixels' || (settings.graphics === 'auto' && ui.graphics === 'pixels'), textOnly: settings.graphics === 'text' }
        : { surface: e.surface, T: $.ui.resolve(e) }
    // In the terminal the header and the hint stay; the body scrolls in a window of its own.
    let window: { rows: number; top: number; extra: boolean } | undefined
    if (e.surface === 'terminal') {
      const scope = `${view.view}:${detail ?? ''}`
      const rows = windowRows(paneRows, headRows(model), 1)
      const total = sumRows(model.body)
      const top = clampTop(scope === pin.scope ? pin.top : 0, total, rows)
      Object.assign(pin, { isPinned: true, scope, top, rows, body: total, keys: bodyKeys(model.body) })
      window = { rows, top, extra: overflows(total, rows) }
    } else pin.isPinned = false
    return drawPane(
      kit,
      model,
      {
        writeHandover: () => safely($, 'handover', () => handover($)),
        copyHandover: surface => safely($, 'copy', () => copyHandover($, surface as RenderSurface)),
        removeTile: id => safely($, 'remove', () => runCommand($, `remove ${id}`)),
        addTile: id => safely($, 'add', () => runCommand($, `add ${id}`)),
        resetLayout: () => safely($, 'reset', () => runCommand($, 'reset')),
        scrollTo: target => safely($, 'scroll', () => scrollToTurn($, target)),
        selectView: id => safely($, 'view', () => selectView($, id)),
        drill: id => safely($, 'detail', () => drill($, id)),
        back: () => safely($, 'back', () => back($)),
        acknowledge: () => safely($, 'acknowledge', () => acknowledgeNow($)),
      },
      window,
    )
  } catch (err) {
    debugLog($, 'pane', err)
    return next(e)
  }
}

/** The body of a view other than a drill-down: only the view in front is built (the handover's text, the turns' rows). */
function viewBody(view: ViewId, plan: OverviewPlan, c: Cockpit, r: ReturnType<typeof readingsOf>, ui: UiState, at: number, width: number): BodyPart[] {
  const L = settings.locale
  switch (view) {
    case 'overview':
      return overviewBody(r, width, plan)
    case 'timeline': {
      const time = timeBlocks(c, at, L, width, ttlOf(cacheForced, c.reading), r.eta)
      return timelineBody(time, time.rows.length === 0 ? t(L, 'timeline.empty') : undefined)
    }
    case 'turns':
      // The AI ETA's calls and its score against the turns' real ends sit over the turns it was asked about.
      return turnsBody(r, width, aiLines(aiView(ui, at), L, width))
    case 'band':
      return bandBody(
        L,
        width,
        ui.layout.tiles,
        availableTiles().filter(id => !ui.layout.tiles.includes(id)),
        isSameLayout(ui.layout, effectiveLayout(settings, undefined)),
      )
    case 'handover': {
      const written = ui.handover?.written ? ui.handover : undefined
      const status = written ? t(L, 'pane.written', { path: HANDOVER_PATH, time: clockText(written.at) }) : t(L, 'pane.notWritten', { path: HANDOVER_PATH })
      return handoverBody(L, width, [{ text: status, tone: 'muted' }], buildHandover({ c, now: at, locale: L, ...(c.meta.root ? { root: c.meta.root } : {}) }))
    }
    case 'guide':
      return guideBody(guideRows(L), width)
  }
}

/**
 * The pane's keyboard ring, put on one of its presses. Claude Code keeps the
 * ring at its place in the order across a redraw, so a view changed under it
 * would leave Enter on whatever press now stands there; the ring is parked on
 * the view bar first, which every view draws alike. Refused while the pane
 * does not hold the keyboard (a click on a press gives it none): then there
 * is no ring to park.
 */
async function focusOn($: Dollar, key: string): Promise<void> {
  await attempt(() => $.ui.focus({ requestId: PANE_ID, key }), { deny: 'no focus' })
}

/** A view brought to the front: the ring parked on its press in the bar, then the view changed (a detail is left). */
async function selectView($: Dollar, id: ViewId) {
  await focusOn($, `pane-view-${id}`)
  await setView($, () => ({ view: id }))
}

/** An instrument pressed: its detail in the overview's place (or beside its list), the ring parked on the bar. */
async function drill($: Dollar, id: DetailId) {
  await focusOn($, 'pane-view-overview')
  await setView($, () => ({ view: 'overview', detail: id }))
}

/** Back from a detail: the instruments again, the ring on the instrument that was open. */
async function back($: Dollar) {
  const was = viewOf(await attempt(() => readUi($), defaultUi())).detail
  await setView($, () => ({ view: 'overview' }))
  if (was) await focusOn($, `cell-${was}`)
}

/**
 * A move of the pane's window, the person's or the engine's: in the pinned
 * terminal pane it moves the body's own window and the engine's stays put
 * (answered without passing it on), so the header and the hint stay in view.
 */
export const onPaneScroll: MatchedHook<'ui.scroll', { readonly requestId: 'quackpit' }> = async ($, e, next) => {
  if (!pin.isPinned || e.component !== 'Pane') return next(e)
  try {
    const top = scrolled(pin.top, e.by, e.bodyRows, pin.body, pin.rows)
    if (top !== pin.top) {
      pin.top = top
      redraw($)
    }
  } catch {
    // the window stays where it was
  }
  return {}
}

/** The ring moved onto a press the window clips (Tab, the arrows): the window follows it. */
export const onPaneFocus: MatchedHook<'ui.focus', { readonly requestId: 'quackpit' }> = async ($, e, next) => {
  const result = await next(e)
  try {
    const key = e.element !== undefined ? pin.keys.get(e.element) : undefined
    if (pin.isPinned && key) {
      const top = followed(pin.top, key.at, key.height, pin.body, pin.rows)
      if (top !== pin.top) {
        pin.top = top
        redraw($)
      }
    }
  } catch {
    // the ring moved; the window stays
  }
  return result
}

/** A tile pressed in the band, or named by `/quackpit <tile>`: the pane opens on its detail (the hero's: the timeline). */
async function openTile($: Dollar, id: TileId) {
  await setView($, () => (id === 'progress' ? { view: 'timeline' } : { view: 'overview', detail: id }))
  await openPane($)
}

/**
 * A turn's row in the pane, pressed: the transcript scrolls to the turn's
 * first tool call (its `tool_use_id` is the row's `requestId`, which the
 * engine scrolls to while a press, the person's own act, asks for it).
 */
async function scrollToTurn($: Dollar, target: string) {
  const moved = await attempt(() => $.ui.scroll({ to: { requestId: target }, block: 'start' }), { deny: 'no scroll' })
  if (moved.deny !== undefined) toast($, t(settings.locale, 'toast.scrollGone'), 4000)
}

/**
 * The line Claude Code closes a main turn with (`Baked for 1m 4s`), with
 * quackpit's receipt after the engine's own words: drawing only, the
 * transcript's record untouched. A line no turn of quackpit's matches is
 * left as it was.
 */
export const renderReceipt: MatchedHook<'ui.render', { readonly component: 'TurnDuration' }> = async ($, e, next) => {
  const drawn = await attempt(() => next(e), ENGINE_OWN)
  try {
    const c = await readCockpit($)
    const receipt = c ? receiptText(c, e.props.durationMs, settings.locale) : undefined
    if (!receipt) return drawn
    const { Box, Text } = $.ui.resolve(e)
    // Claude Code's line fills its row: beside it the receipt is pushed to the far edge and wraps.
    return (
      <Box flexDirection="column">
        {drawn}
        <Text dimColor>{`  ${receipt}`}</Text>
      </Box>
    )
  } catch (err) {
    debugLog($, 'receipt', err)
    return drawn
  }
}

/** While a task list runs, the spinner's ellipsis carries its count: `… 3/7`. */
export const renderSpinner: MatchedHook<'ui.render', { readonly component: 'Spinner' }> = async ($, e, next) => {
  try {
    const c = await readCockpit($)
    const live = c && isListLive(c.tasks, c.turn?.n ?? c.turnCount) ? progressOf(c.tasks) : undefined
    if (!live || live.isComplete) return next(e)
    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix} ${live.done}/${live.total}` } })
  } catch {
    return next(e)
  }
}

// ------------------------------------------------------------------ registration

export const register: Register = (on, options) => {
  settings = readSettings(options, systemLocale())
  ticker = undefined
  priors = emptyDurations()
  restored = undefined
  clearPending = false
  clearedStretch = undefined
  probe = 'idle'
  probeTries = 0
  bandRequestId = undefined
  quackDue = false
  isReadingPoint = false
  poller = undefined
  waitTicker = undefined
  aiCall = undefined
  cmdLengths = undefined
  endedTurns.clear()
  asks.clear()
  asked.clear()
  Object.assign(hint, { isAgentOpen: false, waitIds: new Set<string>(), waitLoops: new Set<string>(), isWaiting: false })
  Object.assign(pin, { isPinned: false, scope: '', top: 0, rows: 0, body: 0, keys: new Map() })

  on('session.start', onSessionStart)
  on('session.end', onSessionEnd)
  on('turn.start', onTurnStart)
  on('turn.complete', onTurnComplete)
  // Observers that never refuse: should one fail, the event goes on untouched.
  on('turn.step', onTurnStep).catch(async function* ($, e, next) {
    return yield* next(e)
  })
  on('session.measure', onMeasure).catch(($, e, next) => next(e))
  on('prompt.submit', onPromptSubmit).catch(($, e, next) => next(e))
  on('tool.call', onToolCall).catch(($, e, next) => next(e))
  // Read only: the verdict beneath goes up unchanged.
  on('tool.check', onToolCheck)
  on('session.compact', onSessionCompact).catch(($, e, next) => next(e))
  on('classic.Stop', onStop).catch(($, e, next) => next(e))
  // Read only: the dialog's answer beneath goes up unchanged; a wait on the person begins where none settled it.
  on('classic.PermissionRequest', onPermissionRequest).catch(($, e, next) => next(e))
  // Read only: an agent's start, its id and who started it, for the estimate and the timeline.
  on('agent.spawn', onAgentSpawned).catch(($, e, next) => next(e))
  // Their answer is empty either way, so nothing reaches the model's context.
  on('command.run', { command: 'quackpit' }, onQuackpitCommand).catch(() => ({}))
  on('command.run', { command: 'quack' }, onQuackCommand).catch(() => ({}))
  on('ui.render', { component: 'AbovePrompt' }, renderBand)
  on('ui.render', { component: 'Pane', requestId: 'quackpit' }, renderPane)
  // The pinned window's own moves: the body scrolls, the header and the hint stay.
  on('ui.scroll', { requestId: 'quackpit' }, onPaneScroll).catch(($, e, next) => next(e))
  on('ui.focus', { requestId: 'quackpit' }, onPaneFocus).catch(($, e, next) => next(e))
  on('ui.render', { component: 'Spinner' }, renderSpinner)
  on('ui.render', { component: 'TurnDuration' }, renderReceipt)
  // Drawing only: a running call's first progress ends the wait its dialog held.
  on('ui.render', { component: 'ToolProgress' }, renderProgress)
  // A validator that fails lets the row be written: fail-open.
  on('config.set', { key: 'quackpit.tiles' }, onTilesSet).catch(($, e, next) => next(e))
  on('config.describe', { key: 'quackpit.tiles' }, onTilesDescribe)
}
