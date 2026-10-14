import { describe, expect, test, type Engine } from 'claude-code/testing'

import { addCall, AI_MAX_TOKENS, aiRequest, asRecords, asTally, gapAfter, isWithin2x, overrunAfter, parseMinutes, planAsk, scoreOf, scoresOf, sumTallies, tallyTokens, type AiRecord } from '../src/ai'
import { clockText } from '../src/format'
import { calibration } from '../src/lengths'
import { newCockpit, onTurnStart, type Cockpit } from '../src/model'
import { toRecord } from '../src/record'
import { readingsOf } from '../src/tiles'
import { topSection } from '../src/top'
import { aiLines } from '../src/timeline'
import { lineWidth, plain } from '../src/text'
import { answered, at, band, call, command, LIMIT_MS, MINUTE, modelUsage, PANE, start, step, todo, usage, world, type World } from './kit'

const T0 = at(2026, 10, 12, 14)
const S = 1000
const DAY = '2026-10-12'

/** Thirty recorded turns of 10 s ... 300 s, in another session's record. */
const thirty = Array.from({ length: 30 }, (_, i) => (i + 1) * 10 * S)
function priorsRecord(savedAt: number) {
  const c: Cockpit = { ...newCockpit(savedAt - MINUTE, 'earlier'), durations: { tasks: [], agents: {}, turns: thirty } }
  return toRecord(c, savedAt)
}

export const AI_ON = { options: { locale: 'en', aiEta: true }, timeoutMs: LIMIT_MS } as const
const OFF = { options: { locale: 'en' }, timeoutMs: LIMIT_MS } as const

/** The band's Text matching `pattern`, if it draws one. */
async function bandText($: Engine, pattern: RegExp): Promise<string | undefined> {
  const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
  const text = (await ui.find({ type: 'Text', text: pattern }))?.text
  await ui.unmount()
  return text
}

/** The pane's Text matching `pattern`, if it draws one: in the overview, where the estimate is, else in the turns view, where the AI ETA's tally is. */
async function paneText($: Engine, pattern: RegExp | string): Promise<string | undefined> {
  let text: string | undefined
  for (const view of ['overview', 'turns']) {
    let pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    await pane.press({ key: `pane-view-${view}` })
    await pane.unmount()
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    text = (await pane.find({ type: 'Text', text: pattern }))?.text
    await pane.unmount()
    if (text !== undefined) break
  }
  return text
}

/** A turn that starts now with the person's prompt, and a first response that says Claude's plan. */
export async function longTurn($: Engine, w: World, turnId: string, prompt: string, plan = "I'll read the parser, rewrite the lexer, then run the tests.") {
  await $.prompt.submit({ text: prompt, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: prompt, turnId })
  await step($, w, turnId, usage(2000, { output: 300 }), 0, plan)
}

export async function endTurn($: Engine, w: World, turnId: string, minutes: number, isAborted = false) {
  await $.turn.complete({ answer: 'done', durationMs: minutes * MINUTE, isAborted, turnId, reason: isAborted ? 'aborted' : 'answer', usage: usage(1000) })
  await w.clock.settle()
}

describe('the AI ETA (opt-in)', () => {
  test('its request: Claude Haiku, low effort, a few tokens, 10 seconds; the turn, its words, its tasks and your turn lengths', () => {
    const r = aiRequest({
      elapsedMs: 65 * S,
      tools: 4,
      text: 'Port the parser to the new grammar, keep ANTHROPIC_API_KEY=*** out of logs',
      words: "I'll read the grammar first, then port the lexer.",
      tasks: [
        { title: 'Read the grammar', status: 'completed' },
        { title: 'Port the lexer', status: 'in_progress' },
        { title: 'Port the parser', status: 'pending' },
      ],
      calibration: calibration(thirty, 65 * S),
    })
    expect([r.model, r.effort, r.maxTokens, r.timeoutMs]).toEqual(['haiku', 'low', AI_MAX_TOKENS, 10_000])
    expect(r.maxTokens).toBeLessThanOrEqual(16)
    expect(r.system).toMatch(/Answer with a single number: the minutes left/)
    expect(r.prompt).toStartWith('This turn has worked 1m05 so far (time spent waiting on the person left out) and made 4 tool calls.')
    expect(r.prompt).toContain("The person's request, secrets masked, long text cut:\n<<<\nPort the parser to the new grammar, keep ANTHROPIC_API_KEY=*** out of logs\n>>>")
    expect(r.prompt).toContain("What Claude has said so far this turn, cut:\n<<<\nI'll read the grammar first, then port the lexer.\n>>>")
    expect(r.prompt).toContain("Claude's task list, 1 of 3 done:\n[x] Read the grammar\n[>] Port the lexer\n[ ] Port the parser")
    expect(r.prompt).toContain("This person's recorded turns (30): half ended within 2m30, 9 in 10 within 4m30, 19 in 20 within 4m50. Of the 24 that ran past 1m05, half ended within 3m00 in all and 9 in 10 within 4m40.")
    expect(r.prompt).toEndWith('How many more minutes will this turn run? Answer with the number only.')
    // A turn no person typed says what started it.
    expect(aiRequest({ elapsedMs: 61 * S, tools: 0, text: '<task-notification>…', startedBy: "a background task's notice" }).prompt).toContain("The message that started the turn (a background task's notice, not typed by the person)")
    expect(aiRequest({ elapsedMs: 61 * S, tools: 1 }).prompt).toContain('Claude has said nothing yet this turn.')
  })

  test('the reply is read strictly: one number of minutes, or nothing', () => {
    expect(['8', ' 12.5 ', '0', '720', '3\n'].map(parseMinutes)).toEqual([8, 12.5, 0, 720, 3])
    for (const reply of ['8 minutes', '~8', '8m', 'about 8', '', '8-10', '9999', '721', '-3', '8\n9', '1e3', 'eight']) expect(parseMinutes(reply), reply).toBeUndefined()
  })

  test('the tally: every call and the four token counts its own usage reported, by outcome', () => {
    let t = addCall(undefined, 'answered', modelUsage(900, 2, 0, 0))
    t = addCall(t, 'failed', modelUsage(0, 0))
    t = addCall(t, 'unread', { input_tokens: 880, output_tokens: 16, cache_read_input_tokens: 40, cache_creation_input_tokens: 20 })
    t = addCall(t, 'cancelled', undefined)
    expect(t).toEqual({ calls: 4, answered: 1, unread: 1, failed: 1, cancelled: 1, input: 1780, output: 18, cacheRead: 40, cacheWrite: 20 })
    expect(tallyTokens(t)).toBe(1858)
    expect(asTally({ calls: 2, input: 5, junk: 'x', output: -3 })).toEqual({ calls: 2, answered: 0, unread: 0, failed: 0, cancelled: 0, input: 5, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(asTally({ calls: 0 })).toBeUndefined()
    expect(sumTallies([t, t]).calls).toBe(8)
  })

  test('the score: within 2× of what was really left, the AI and history over the same turns, history with nothing to say a miss', () => {
    expect([isWithin2x(8, 4), isWithin2x(8, 3.9), isWithin2x(2, 4), isWithin2x(1.9, 4), isWithin2x(0, 5), isWithin2x(0, 0)]).toEqual([true, false, true, false, false, true])
    const records: AiRecord[] = [
      [T0, 60 * S, 8 * MINUTE, 2 * MINUTE, 6 * MINUTE],
      [T0 + 1, 60 * S, 1 * MINUTE, -1, 6 * MINUTE],
      [T0 + 2, 60 * S, 5 * MINUTE, 5 * MINUTE, 4 * MINUTE],
    ]
    expect(scoreOf(records)).toEqual({ n: 3, ai: 2, history: 1 })
    expect(asRecords([[1, 2, 3, 4, 5], [1, 2], 'x', [1, 2, -3, 4, 5], [1, 2, 3, 4, Number.NaN]])).toEqual([[1, 2, 3, 4, 5]])
    // In the pane: under 20 scored answers it says when the shares come; from 20, the two side by side.
    // First answers and revisions are scored apart: a revision knows more of its turn.
    const score = (n: number) => ({ n, ai: Math.round(n * 0.64), history: Math.round(n * 0.36) })
    const view = (n: number, revised = 0) => ({ on: true, today: DAY, days: [{ day: DAY, tally: addCall(undefined, 'answered', modelUsage(4000, 2)) }], scores: { first: score(n), revised: score(revised) } })
    expect(aiLines(view(7), 'en', 100).map(plain)).toEqual([
      'AI     ETA on · today 1 call, 4k tokens',
      '       7 days 1 call, 4k tokens',
      '       within 2× of the real end: shown from 20 scored first answers (7 so far)',
    ])
    expect(aiLines(view(22), 'en', 100).map(plain).at(-1)).toBe('       first answers within 2× of the real end: AI 64%, history 36% (22)')
    expect(aiLines(view(22, 5), 'en', 100).map(plain).at(-1)).toBe('       revisions scored apart: 5 so far')
    expect(aiLines(view(22, 25), 'en', 100).map(plain).at(-1)).toBe('       revisions within 2×: AI 64%, history 36% (25)')
    // Off, with no call in 7 days: nothing at all.
    expect(aiLines({ ...view(0), on: false, days: [] }, 'en', 100)).toEqual([])
    expect(aiLines(view(22), 'ko', 100).map(plain)).toEqual(['AI     예상 켬 · 오늘 1회, 토큰 4k', '       7일 1회, 토큰 4k', '       첫 답이 실제의 2배 안: AI 64%, 기록 36% (22개)'])
    // A revision's record carries its place in the turn; older records, five numbers, were first answers.
    expect(scoresOf([[T0, 60 * S, 8 * MINUTE, 2 * MINUTE, 6 * MINUTE], [T0, 3 * MINUTE, 5 * MINUTE, -1, 4 * MINUTE, 2]])).toEqual({ first: { n: 1, ai: 1, history: 0 }, revised: { n: 1, ai: 1, history: 0 } })
  })

  test("on top of the pane the AI's estimate, its pond and whose guess it is fit 56 to 96 columns whole", () => {
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
    c = { ...c, turn: c.turn && { ...c.turn, asks: [{ n: 1, why: 'first' as const, askedAt: T0 + MINUTE, elapsedMs: MINUTE, state: 'answered' as const, leftMs: 8 * MINUTE }] } }
    const now = T0 + 2 * MINUTE
    for (const L of ['en', 'ko'] as const) {
      for (const width of [56, 70, 96]) {
        const top = topSection(readingsOf(c, { now, locale: L, days: [], today: DAY, aiOn: true }), width)
        const pond = top.pond
        expect(pond?.columns, `${L} ${width}`).toBeGreaterThanOrEqual(12)
        expect((pond?.columns ?? 0) + 1 + Math.max(...(pond?.words ?? []).map(lineWidth)), `${L} ${width}`).toBeLessThanOrEqual(width)
        expect(plain(pond?.words[0] ?? []), L).toBe(L === 'en' ? '~7m left (AI)' : '~7m 남음 (AI)')
        expect(top.under.map(line => plain(line))).toEqual(L === 'en' ? [`Haiku's guess at ${clockText(T0 + MINUTE)} · not measured`] : [`${clockText(T0 + MINUTE)} Haiku의 추정 · 측정값 아님`])
      }
    }
  })

  test('off by default: no model call, ever, and nothing says AI', OFF, async ($, on) => {
    const w = world(on, { now: T0, store: { 's:earlier': priorsRecord(T0 - 60 * MINUTE) } })
    w.modelReply = () => answered('8')
    await start($, w)
    await longTurn($, w, 'long', 'Port the parser')
    await w.clock.advance(4 * MINUTE)
    expect(w.modelCalls).toEqual([])
    expect(await bandText($, /\(AI\)/)).toBeUndefined()
    // A long turn with nothing to estimate it gets the fact instead.
    expect(await bandText($, /longer than/)).toBeDefined()
    expect(await paneText($, /^AI {5}/)).toBeUndefined()
    expect([...w.store.keys()].filter(key => key.startsWith('ai:') || key.startsWith('aa:'))).toEqual([])
  })

  test("on: one call a minute into a turn with nothing measured; '~8m left (AI)' in the band and the pane, its tokens tallied, its answer scored at the turn's end", AI_ON, async ($, on) => {
    const w = world(on, { now: T0, store: { 's:earlier': priorsRecord(T0 - 60 * MINUTE) } })
    w.modelReply = () => answered('8', modelUsage(1180, 2, 0, 0))
    await start($, w)
    const key = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    await longTurn($, w, 'long', `Port the parser; the token is ${key}`)
    await w.clock.advance(59 * S)
    expect(w.modelCalls).toEqual([])
    // Asked at 1:00, answered at 1:01.2.
    await w.clock.advance(3 * S)
    expect(w.modelCalls).toHaveLength(1)
    const sent = w.modelCalls[0]
    expect([sent?.model, sent?.effort, sent?.maxTokens, sent?.timeoutMs]).toEqual(['haiku', 'low', 16, 10_000])
    expect(sent?.prompt).toContain('Port the parser; the token is ***')
    expect(sent?.prompt).not.toContain(key)
    expect(sent?.prompt).toContain("I'll read the parser, rewrite the lexer, then run the tests.")
    expect(sent?.prompt).toContain("This person's recorded turns (30)")
    // At 2:02 the AI's 8 minutes from 1:00 have 7 left; the duck's pond follows it.
    await w.clock.advance(MINUTE)
    expect(await bandText($, /left \(AI\)$/)).toBe(' ~7m left (AI)')
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Raster', key: 'progress-pond' })).toBeDefined()
    await ui.unmount()
    // No second call while the turn runs within its answer and nothing changes.
    await w.clock.advance(3 * MINUTE)
    expect(w.modelCalls).toHaveLength(1)
    expect(w.store.get(`ai:${DAY}:session-1`)).toEqual({ calls: 1, answered: 1, unread: 0, failed: 0, cancelled: 0, input: 1180, output: 2, cacheRead: 0, cacheWrite: 0 })
    expect(await paneText($, 'ETA on · today 1 call, 1.2k tokens')).toBeDefined()
    expect(await paneText($, '~4m left (AI)')).toBeDefined()
    expect(await paneText($, /^Haiku's guess at \d\d:\d\d · not measured$/)).toBeDefined()
    // The turn ends at 5:02: 4m02 was really left when it was asked at 1:00. The AI said 8m;
    // history, the median of the recorded turns longer than 1:00 (3m05), less that minute, 2m05.
    await endTurn($, w, 'long', 5)
    const records = w.store.get('aa:session-1') as AiRecord[]
    // The sixth number: it was the turn's first answer.
    expect(records).toEqual([[T0 + 60 * S, 60 * S, 8 * MINUTE, 125 * S, 242 * S, 1]])
    expect(await paneText($, /shown from 20 scored first answers \(1 so far\)/)).toBeDefined()
    // A completion of its own: nothing went into the conversation, no fork was made.
    expect(w.forks).toBe(0)
    expect(w.prompts.map(p => p.text)).toEqual([`Port the parser; the token is ${key}`])
  })

  test('measured estimates win: a turn whose task list has a pace is never asked about', AI_ON, async ($, on) => {
    const w = world(on, { now: T0 })
    w.modelReply = () => answered('30')
    await start($, w)
    await longTurn($, w, 'listed', 'Port the parser')
    const write = (statuses: ('pending' | 'in_progress' | 'completed')[]) => call($, w, todo(statuses.map((status, i) => [`Task ${i + 1}`, status])))
    await write(['in_progress', 'pending', 'pending'])
    await w.clock.advance(20 * S)
    await write(['completed', 'in_progress', 'pending'])
    await w.clock.advance(20 * S)
    await write(['completed', 'completed', 'in_progress'])
    await w.clock.advance(2 * MINUTE)
    expect(w.modelCalls).toEqual([])
    expect(await bandText($, /\(AI\)/)).toBeUndefined()
    expect(await bandText($, / ~\d+m left$/)).toBeDefined()
  })

  test('a turn that ends first is never asked; a call still running when it ends is cancelled, counted, and draws nothing', AI_ON, async ($, on) => {
    const w = world(on, { now: T0 })
    w.modelReply = () => answered('8')
    await start($, w)
    await longTurn($, w, 'quick', 'Rename a variable')
    await w.clock.advance(50 * S)
    await endTurn($, w, 'quick', 50 / 60)
    await w.clock.advance(2 * MINUTE)
    expect(w.modelCalls).toEqual([])
    // The next turn is asked at its own minute, and ends while the model is still answering.
    w.modelMs = 8000
    await longTurn($, w, 'slow', 'Port the parser')
    await w.clock.advance(61 * S)
    expect(w.modelCalls).toHaveLength(1)
    await endTurn($, w, 'slow', 61 / 60)
    await w.clock.advance(10 * S)
    expect(w.store.get(`ai:${DAY}:session-1`)).toMatchObject({ calls: 1, cancelled: 1, answered: 0 })
    expect(w.store.get('aa:session-1')).toBeUndefined()
    expect(await bandText($, /\(AI\)/)).toBeUndefined()
  })

  test('a failed call or a reply that is no number draws nothing; both are counted, with the tokens their usage reported', AI_ON, async ($, on) => {
    const w = world(on, { now: T0 })
    w.modelReply = () => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: modelUsage(0, 0) })
    await start($, w)
    await longTurn($, w, 'a', 'Port the parser')
    await w.clock.advance(2 * MINUTE)
    expect(await bandText($, /\(AI\)/)).toBeUndefined()
    await endTurn($, w, 'a', 2)
    w.modelReply = () => answered('about eight minutes', modelUsage(1100, 5))
    await longTurn($, w, 'b', 'Port the lexer')
    await w.clock.advance(2 * MINUTE)
    expect(await bandText($, /\(AI\)/)).toBeUndefined()
    expect(w.store.get(`ai:${DAY}:session-1`)).toMatchObject({ calls: 2, failed: 1, unread: 1, answered: 0, input: 1100, output: 5 })
    expect(await paneText($, '7 days 2 calls, 1.1k tokens · 1 failed · 1 unreadable')).toBeDefined()
    await endTurn($, w, 'b', 2)
    expect(w.store.get('aa:session-1')).toBeUndefined()
  })

  test('past what the AI said the turn says so, its duck held short of the flag', AI_ON, async ($, on) => {
    const w = world(on, { now: T0 })
    w.modelReply = () => answered('2')
    await start($, w)
    await longTurn($, w, 'over', 'Port the parser')
    await w.clock.advance(2 * MINUTE)
    expect(await bandText($, /left \(AI\)$/)).toBe(' ~1m left (AI)')
    // It said 2 minutes at 1:00, so 3 in all; at 4:00 the turn is past them.
    await w.clock.advance(2 * MINUTE)
    expect(await bandText($, /AI's/)).toBe(" past the AI's ~3m")
    expect(await paneText($, /^AI said ~\d\d:\d\d$/)).toBeDefined()
  })

  test("from 20 scored first answers the pane says how often each landed within 2× of the real end", AI_ON, async ($, on) => {
    // Earlier sessions' scored answers: the AI within 2× in 14 of 22, history in 8.
    const records: AiRecord[] = Array.from({ length: 22 }, (_, i) => [T0 - (i + 1) * MINUTE, 60 * S, i < 14 ? 4 * MINUTE : 20 * MINUTE, i < 8 ? 5 * MINUTE : 30 * MINUTE, 5 * MINUTE])
    const w = world(on, { now: T0, store: { 'aa:earlier': records } })
    await start($, w)
    expect(await paneText($, 'first answers within 2× of the real end: AI 64%, history 36% (22)')).toBeDefined()
  })

  test("after /clear, with the session's state started afresh, the pane still counts the day's calls: they are the store's", AI_ON, async ($, on) => {
    let fresh = false
    on('state.get', ($2, e, next) => (fresh && e.plugin === 'quackpit' ? { value: { value: undefined as never, version: 0 } } : next(e)))
    const w = world(on, { now: T0, store: { [`ai:${DAY}:earlier`]: { calls: 2, answered: 2, input: 2400, output: 300 } } })
    await start($, w)
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    fresh = true
    expect(await paneText($, 'ETA on · today 2 calls, 2.7k tokens')).toBeDefined()
  })

  test('/quackpit ai on and off change its row in /config; /quackpit ai says how it stands', OFF, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await command($, 'ai')
    expect(w.toasts.at(-1)).toBe('AI ETA is off, as it is by default. /quackpit ai on asks Claude Haiku how long a long turn with nothing measured has left, 4 calls a turn at most; the pane counts its tokens.')
    await command($, 'ai on')
    expect(w.configSets).toEqual([{ key: 'quackpit.aiEta', value: true }])
    expect(w.toasts.at(-1)).toMatch(/^AI ETA is on\. Once a turn has worked a minute with nothing measured, quackpit asks Claude Haiku how long is left .*4 calls a turn at most/)
    await command($, 'ai off')
    expect(w.configSets.at(-1)).toEqual({ key: 'quackpit.aiEta', value: false })
    expect(w.toasts.at(-1)).toBe('AI ETA is off: quackpit calls no model.')
    // Its answer is empty, as every command's: nothing reaches the model.
    expect((await command($, 'ai on')).text).toBeUndefined()
  })

  test('/quackpit ai, while on, says what it spent today', AI_ON, async ($, on) => {
    const w = world(on, { now: T0, store: { [`ai:${DAY}:other`]: { calls: 3, answered: 3, input: 3600, output: 6 } } })
    await start($, w)
    await command($, 'ai')
    expect(w.toasts.at(-1)).toBe('AI ETA is on. Today: 3 calls, 3.6k tokens. /quackpit ai off turns it off.')
  })
})

describe('the AI ETA revises itself', () => {
  const ask = (n: number, askedAt: number, state: 'asking' | 'answered' | 'failed' = 'answered', leftMs = 2 * MINUTE) => ({ n, askedAt, elapsedMs: askedAt - T0, why: 'first' as const, state, ...(state === 'answered' ? { leftMs } : {}) })

  test('when it asks: a minute in with nothing measured; again past its answer by 30 s or half of it, or for a reason; 2, 4, then 8 minutes apart; 4 calls at most; never mid-call or mid-wait', () => {
    const base = { now: T0, workedMs: 0, isWaiting: false, isAsking: false, asks: [], isCovered: false }
    expect(planAsk({ ...base, workedMs: 40 * S })).toEqual({ kind: 'later', inMs: 20 * S })
    expect(planAsk({ ...base, workedMs: 60 * S })).toEqual({ kind: 'ask', why: 'first' })
    // Something measured covers the turn: the AI defers to it, until it goes.
    expect(planAsk({ ...base, workedMs: 5 * MINUTE, isCovered: true })).toEqual({ kind: 'none' })
    expect(planAsk({ ...base, workedMs: 5 * MINUTE, due: 'deferred' })).toEqual({ kind: 'ask', why: 'deferred' })
    expect(planAsk({ ...base, workedMs: 5 * MINUTE, isWaiting: true })).toEqual({ kind: 'none' })
    // It said 2 minutes at 1:00: past them by a minute (half of 2, more than 30 s) it is asked again.
    const one = [ask(1, T0 + MINUTE)]
    expect(planAsk({ ...base, now: T0 + 3 * MINUTE, asks: one, workedSinceLast: 2 * MINUTE })).toEqual({ kind: 'later', inMs: 61 * S })
    expect(planAsk({ ...base, now: T0 + 4 * MINUTE + S, asks: one, workedSinceLast: 3 * MINUTE + S })).toEqual({ kind: 'ask', why: 'overrun' })
    // A short answer is given 30 seconds: 40 s said, asked again past 70 s, if 2 minutes have passed.
    expect(overrunAfter(40 * S)).toBe(70 * S)
    expect(planAsk({ ...base, now: T0 + 2 * MINUTE, asks: [ask(1, T0 + MINUTE, 'answered', 40 * S)], workedSinceLast: 71 * S })).toEqual({ kind: 'later', inMs: MINUTE })
    // A reason that came (a wait ended, the work changed shape) asks again once the spacing allows.
    expect(planAsk({ ...base, now: T0 + 2 * MINUTE, asks: one, workedSinceLast: MINUTE, due: 'answered' })).toEqual({ kind: 'later', inMs: MINUTE })
    expect(planAsk({ ...base, now: T0 + 3 * MINUTE, asks: one, workedSinceLast: 2 * MINUTE, due: 'shape' })).toEqual({ kind: 'ask', why: 'shape' })
    // The gaps double: 2 minutes after the first, 4 after the second, 8 after the third.
    expect([gapAfter(1), gapAfter(2), gapAfter(3)]).toEqual([2 * MINUTE, 4 * MINUTE, 8 * MINUTE])
    const three = [ask(1, T0), ask(2, T0 + 3 * MINUTE), ask(3, T0 + 8 * MINUTE)]
    expect(planAsk({ ...base, now: T0 + 12 * MINUTE, asks: three, workedSinceLast: 4 * MINUTE, due: 'shape' })).toEqual({ kind: 'later', inMs: 4 * MINUTE })
    // Never two at once, never a fifth.
    expect(planAsk({ ...base, now: T0 + 30 * MINUTE, asks: three, isAsking: true, due: 'shape' })).toEqual({ kind: 'none' })
    expect(planAsk({ ...base, now: T0 + 60 * MINUTE, asks: [...three, ask(4, T0 + 20 * MINUTE)], workedSinceLast: 30 * MINUTE })).toEqual({ kind: 'none' })
  })

  test('a re-ask tells it its earlier answers, how long the turn has worked since and what happened, and to keep its estimate unless that changes it', () => {
    const r = aiRequest({
      elapsedMs: 4 * MINUTE,
      tools: 9,
      text: 'Port the parser',
      previous: [{ at: T0 + MINUTE, elapsedMs: MINUTE, leftMs: 2 * MINUTE }],
      since: { workedMs: 3 * MINUTE, heldMs: 75 * S, notes: ['Bash (Run the tests)', "the person answered Claude's question after 1m15"], lastWords: 'The tests pass; now the docs.' },
    })
    expect(r.prompt).toContain(`You were asked before: at ${clockText(T0 + MINUTE)}, 1m00 into the turn, you said 2 minutes were left.`)
    expect(r.prompt).toContain('Since your last answer the turn has worked 3m00, besides 1m15 it waited on the person. What happened since:\n- Bash (Run the tests)\n- the person answered Claude\'s question after 1m15')
    expect(r.prompt).toContain("Claude's latest words, cut:\n<<<\nThe tests pass; now the docs.\n>>>")
    expect(r.prompt).toContain('Keep your previous estimate unless what happened since changes it.')
    expect(r.prompt).toEndWith('How many more minutes will this turn run? Answer with the number only.')
    expect([r.model, r.effort, r.maxTokens]).toEqual(['haiku', 'low', AI_MAX_TOKENS])
  })

  test('in a session: a turn that outruns its answers is asked again 2, 4 and 8 minutes apart, 4 calls at most; revisions say so, and every call is tallied', AI_ON, async ($, on) => {
    const w = world(on, { now: T0 })
    w.modelReply = () => answered('2', modelUsage(1000, 2))
    await start($, w)
    await longTurn($, w, 'long', 'Port the parser')
    await w.clock.advance(62 * S)
    expect(w.modelCalls).toHaveLength(1)
    expect(await bandText($, /left \(AI\)$/)).toBe(' ~2m left (AI)')
    // It said 2 minutes at 1:00; past them by a minute, at 4:01, it is asked again, and told what it said.
    await w.clock.advance(2 * MINUTE + 50 * S)
    expect(w.modelCalls).toHaveLength(1)
    await w.clock.advance(15 * S)
    expect(w.modelCalls).toHaveLength(2)
    expect(w.modelCalls[1]?.prompt).toContain('you said 2 minutes were left')
    expect(w.modelCalls[1]?.prompt).toContain('Keep your previous estimate unless what happened since changes it.')
    expect(await bandText($, /\(AI, revised\)$/)).toBe(' ~2m left (AI, revised)')
    expect(await paneText($, new RegExp(`^Haiku's 2nd guess at \\d\\d:\\d\\d \\(1st ~2m\\) · not measured$`))).toBeDefined()
    // Past its second answer by 7:02, but the next call waits until 4 minutes after it: the band says it will ask.
    await w.clock.advance(3 * MINUTE + 30 * S)
    expect(w.modelCalls).toHaveLength(2)
    expect(await bandText($, /asking again$/)).toMatch(/^ past the AI's ~\dm · asking again$/)
    await w.clock.advance(MINUTE)
    expect(w.modelCalls).toHaveLength(3)
    // The fourth no sooner than 8 minutes after the third; then none, however long the turn runs.
    await w.clock.advance(7 * MINUTE)
    expect(w.modelCalls).toHaveLength(3)
    await w.clock.advance(2 * MINUTE)
    expect(w.modelCalls).toHaveLength(4)
    await w.clock.advance(30 * MINUTE)
    expect(w.modelCalls).toHaveLength(4)
    expect(await bandText($, /AI's/)).toMatch(/^ past the AI's ~\d+m$/)
    expect(w.store.get(`ai:${DAY}:session-1`)).toMatchObject({ calls: 4, answered: 4, input: 4000, output: 8 })
    // Each answer is scored on its own at the turn's end, its place in the turn kept.
    await endTurn($, w, 'long', 45)
    const records = w.store.get('aa:session-1') as AiRecord[]
    expect(records.map(r => r[5])).toEqual([1, 2, 3, 4])
  })

  test("a wait on the person that ended asks again, its length told; a reply made while a wait began is dropped as stale, and counted", AI_ON, async ($, on) => {
    const w = world(on, { now: T0 })
    w.modelReply = () => answered('8')
    w.askUserMs = 70 * S
    await start($, w)
    await longTurn($, w, 'long', 'Port the parser')
    await w.clock.advance(62 * S)
    expect(w.modelCalls).toHaveLength(1)
    // A question at 2:00, answered at 3:10: the AI is asked again (2 minutes after its first call allows it).
    await w.clock.advance(58 * S)
    const asked = $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which parser?', header: 'Parser', options: [{ label: 'PEG' }, { label: 'LR' }] }] } as never)
    await w.clock.advance(71 * S)
    await asked
    await w.clock.advance(3 * S)
    expect(w.modelCalls).toHaveLength(2)
    expect(w.modelCalls[1]?.prompt).toContain("the person answered Claude's question after 1m10")
    // A third call goes out at 7:10, 4 minutes on, for a shape change; a question opens while it is in flight.
    w.modelMs = 5000
    w.askUserMs = 10 * MINUTE
    await $.tool.call({ tool: 'Agent', description: 'Scan the grammar', prompt: 'scan', subagent_type: 'Explore', run_in_background: true } as never)
    await w.clock.advance(4 * MINUTE)
    expect(w.modelCalls).toHaveLength(3)
    void $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which file?', header: 'File', options: [{ label: 'a' }, { label: 'b' }] }] } as never)
    await w.clock.advance(6 * S)
    // Its reply was made for a turn not yet waiting: dropped, never shown, and counted with its tokens.
    expect(await bandText($, /revised/)).toBeUndefined()
    expect(w.store.get(`ai:${DAY}:session-1`)).toMatchObject({ calls: 3, answered: 2, cancelled: 1 })
  })
})
