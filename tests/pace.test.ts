import { describe, expect, test } from 'claude-code/testing'

import { fiveHourEta, paceReading, usualPace } from '../src/derive'
import { addRecent, hitRatio, MINUTE, newTokens, paceAt, pruneRecent } from '../src/metrics'
import { newCockpit, onReading, onStep, onToolEnd, onToolStart, onTurnEnd, onTurnStart, subagentTokens } from '../src/model'
import { addToDay, loadDays, rollUp, type KV } from '../src/store'
import { paceFace, readingsOf } from '../src/tiles'
import { plain } from '../src/text'
import { at, band, call, EN, measure, PANE, start, step, turn, usage, world } from './kit'

const T0 = at(2026, 10, 11, 10)

describe('pace', () => {
  test('pace is the tokens of the last 60 minutes (token-detox paceAt/pruneRecent)', () => {
    const now = T0
    const recent: [number, number][] = [
      [now - 70 * MINUTE, 999_999],
      [now - 50 * MINUTE, 200_000],
      [now - 10 * MINUTE, 300_000],
    ]
    expect(pruneRecent(recent, now)).toHaveLength(2)
    expect(paceAt(recent, now)).toBe(500_000)
  })

  test('below 10 minutes of data the needle is grey and only the number shows', () => {
    let c = newCockpit(T0, 's')
    c = onTurnStart(c, { at: T0, turnId: 't', text: 'go' })
    c = onTurnEnd(c, { at: T0 + 3 * MINUTE, turnId: 't', tokens: 90_000, durationMs: 3 * MINUTE, isAborted: false })
    const ctx = { now: T0 + 5 * MINUTE, locale: 'en' as const, days: [], today: '2026-10-11' }
    const r = readingsOf(c, ctx)
    expect(r.pace.hasData).toBe(false)
    const face = paceFace(r)
    expect(face.graphic).toMatchObject({ kind: 'dial', isGrey: true })
    // 90k new tokens two minutes ago read 567k an hour now: the rate at the last few minutes' pace.
    expect(plain(face.lines[0])).toBe('567k/h')
    expect(plain(face.lines[1])).toBe('pace')
  })

  test('your usual pace is the median day of the last 14 (token-detox dayPace), else this session', () => {
    const c = { ...newCockpit(T0, 's'), tokens: 600_000, activeMs: 30 * MINUTE }
    const days = [
      { day: '2026-10-07', tokens: 3_000_000, activeMin: 120 },
      { day: '2026-10-08', tokens: 1_000_000, activeMin: 60 },
      { day: '2026-10-09', tokens: 4_000_000, activeMin: 240 },
    ]
    expect(usualPace(c, days, '2026-10-11')).toBe(1_000_000)
    // Fewer than 3 days: this session's own tokens per active hour (at least an hour).
    expect(usualPace(c, days.slice(0, 2), '2026-10-11')).toBe(600_000)
  })

  test('the ETA says when the 5h window empties at the rate of its readings, or that it lasts to the reset', () => {
    let c = newCockpit(T0, 's')
    // 5 points every 10 minutes, a line through all four readings: the remaining 45% lasts 90 minutes.
    for (const [i, pct] of [40, 45, 50, 55].entries()) c = onReading(c, { at: T0 + i * 10 * MINUTE, fiveHour: { pct, resetsAt: T0 + 4 * 60 * MINUTE } })
    expect(fiveHourEta(c, T0 + 30 * MINUTE)).toEqual({ kind: 'empties', at: T0 + 120 * MINUTE })
    let slow = newCockpit(T0, 's')
    for (const [i, pct] of [40, 42, 43, 45].entries()) slow = onReading(slow, { at: T0 + i * 10 * MINUTE, fiveHour: { pct, resetsAt: T0 + 60 * MINUTE } })
    expect(fiveHourEta(slow, T0 + 30 * MINUTE)).toEqual({ kind: 'holds', resetsAt: T0 + 60 * MINUTE })
    // Under 10 minutes of readings there is no ETA yet.
    let early = newCockpit(T0, 's')
    early = onReading(early, { at: T0, fiveHour: { pct: 40 } })
    early = onReading(early, { at: T0 + 5 * MINUTE, fiveHour: { pct: 50 } })
    expect(fiveHourEta(early, T0 + 5 * MINUTE)).toBeUndefined()
  })

  test('the pace tile reads the needle against your usual pace and turns amber on the way to the red line', () => {
    let c = { ...newCockpit(T0 - 2 * 60 * MINUTE, 's') }
    // A steady 40k new tokens a minute for the last 20 minutes: about 2.4M an hour now.
    c = { ...c, recent: Array.from({ length: 20 }, (_, i): [number, number] => [T0 - i * MINUTE, 40_000]) }
    const days = [
      { day: '2026-10-07', tokens: 1_000_000, activeMin: 60 },
      { day: '2026-10-08', tokens: 1_000_000, activeMin: 60 },
      { day: '2026-10-09', tokens: 1_000_000, activeMin: 60 },
    ]
    const r = paceReading(c, T0, days, '2026-10-11')
    expect(Math.round((r.ratio ?? 0) * 10)).toBe(24)
    expect(r.level).toBe('bad')
    expect(r.needle).toBe(1)
  })

  test('pace rises during a turn, response by response, before the turn ends', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await $.turn.start({ text: 'go', turnId: 'long' })
    const paceText = async () => {
      const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
      const text = (await ui.find({ type: 'Text', text: /\/h$/ }))?.text
      await ui.unmount()
      return text
    }
    expect(await paceText()).toBe('0/h')
    // 50k new tokens just now: at that pace, 416k an hour.
    await step($, w, 'long', usage(40_000, { output: 2000, write: 8000 }), 0)
    expect(await paceText()).toBe('416k/h')
    await w.clock.advance(MINUTE)
    await step($, w, 'long', usage(10_000, { output: 5000, write: 15_000, read: 400_000 }), 1)
    expect(await paceText()).toBe('612k/h')
    // The turn's end sums the same responses: nothing is counted twice.
    await $.turn.complete({ answer: 'done', durationMs: 2 * MINUTE, isAborted: false, turnId: 'long', reason: 'answer', usage: { input_tokens: 50_000, output_tokens: 7000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 23_000, model: 'claude-test' } })
    await w.clock.settle()
    expect(await paceText()).toBe('612k/h')
  })

  test('cache reads stay out of pace and every total: a 490k context read over and over is not work', () => {
    // One response at a 490k context: almost all of it read from the cache.
    const response = { input_tokens: 3, output_tokens: 1200, cache_read_input_tokens: 489_000, cache_creation_input_tokens: 1800 }
    expect(newTokens(response)).toBe(3003)
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
    for (let i = 0; i < 40; i++) c = onStep(c, { at: T0 + i * 6000, startedAt: T0 + i * 6000 - 5000, turnId: 't', usage: response })
    expect(paceAt(c.recent, T0 + 4 * MINUTE)).toBe(40 * 3003)
    c = onTurnEnd(c, { at: T0 + 4 * MINUTE, turnId: 't', tokens: 40 * 3003, durationMs: 4 * MINUTE, isAborted: false })
    // The turn's figure, its sparkline bar and the runaway median count the same unit.
    expect(c.history.at(-1)?.tokens).toBe(120_120)
    expect(c.turnTokens).toEqual([120_120])
    expect(c.tokens).toBe(120_120)
    expect(paceAt(c.recent, T0 + 4 * MINUTE)).toBe(120_120)
  })

  test('the cache hit ratio is read ÷ (read + write + uncached), shown in the pane', EN, async ($, on) => {
    expect(hitRatio({ read: 98, write: 1, input: 1 })).toBe(0.98)
    expect(hitRatio({ read: 0, write: 0, input: 0 })).toBeUndefined()
    const w = world(on, { now: T0 })
    await start($, w)
    await $.turn.start({ text: 'go', turnId: 'cached' })
    await step($, w, 'cached', usage(1000, { read: 190_000, write: 9000 }))
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: '95% from cache' })).toBeDefined()
    await pane.unmount()
  })

  test("a subagent's own responses never count; its Agent result does, once, as Claude Code counts its tokens", () => {
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
    c = onStep(c, { at: T0 + 1000, startedAt: T0, turnId: 't', agentId: 'agent-1', usage: { input_tokens: 90_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    expect(c.recent).toEqual([])
    expect(c.cache).toEqual({ read: 0, write: 0, input: 0 })
    const call = { at: T0, id: 'a1', tool: 'Agent', input: { description: 'Map it', subagent_type: 'Explore' } }
    const result = { status: 'completed', agentId: 'agent-1', totalTokens: 23_613, usage: { input_tokens: 2, output_tokens: 220, cache_read_input_tokens: 21_748, cache_creation_input_tokens: 1643 } }
    c = onToolEnd(onToolStart(c, call), { ...call, at: T0 + 30_000, outcome: 'ok', text: 'done', result })
    expect(c.turn?.subTokens).toBe(23_613)
    expect(paceAt(c.recent, T0 + 30_000)).toBe(23_613)
    // A subagent's end carries its agentId: the main turn's figures stay as they were.
    const sub = onTurnEnd(c, { at: T0 + 31_000, turnId: 'sub', agentId: 'agent-1', tokens: 99_999, durationMs: 1000, isAborted: false })
    expect(sub).toBe(c)
    c = onTurnEnd(c, { at: T0 + MINUTE, turnId: 't', tokens: 5000, durationMs: MINUTE, isAborted: false })
    expect(c.history.at(-1)?.tokens).toBe(28_613)
    // A fork's prompt opens with the main thread's transcript: only its own new tokens count.
    expect(subagentTokens({ subagent_type: 'fork' }, result)).toBe(1865)
  })

  test("the turn's cost comes with the reading after it, not from a read at its end", EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { costUsd: 1 } })
    await start($, w)
    const plainReads = () => w.usageReads - w.breakdownReads
    const before = plainReads()
    await turn($, w, { tokens: 5000, costUsd: 0.25, tools: [{ tool: 'Bash', command: 'ls' }, { tool: 'Read', file_path: '/work/a.ts' }] })
    // One read at the turn's start; none at its tool calls; its end waits for session.measure.
    expect(plainReads() - before).toBe(1)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: ' · turn $0.25' })).toBeDefined()
    await ui.unmount()
  })

  test('a running turn costs "—" until the ledger has moved since it began, never "$0"', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { costUsd: 1 } })
    await start($, w)
    await turn($, w, { costUsd: 0.25 })
    // Turn 2 starts: the ledger is read, then two tool calls go by with no reading after them.
    await $.turn.start({ text: 'go on', turnId: 'running' })
    await call($, w, { tool: 'Read', file_path: '/work/a.ts' })
    await call($, w, { tool: 'Bash', command: 'ls' })
    const costLine = async (surface: 'band' | 'pane') => {
      const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...(surface === 'band' ? band() : PANE) })
      const text = (await ui.find({ type: 'Text', text: /^( · )?turn [—$]/ }))?.text
      await ui.unmount()
      return text
    }
    expect(await costLine('band')).toBe(' · turn —')
    expect(await costLine('pane')).toBe('turn —')
    // A reading pushed mid-turn (a plan window moved a point) shows what the turn has cost so far.
    w.usage.costUsd = 1.35
    await measure($, w)
    expect(await costLine('band')).toBe(' · turn $0.10')
  })

  test("day totals move to new keys; the first builds' records, in another unit, are dropped at roll-up", async () => {
    const map = new Map<string, unknown>([
      ['p:2026-10-08:old', { tokens: 9_000_000, activeMin: 60 }],
      ['d:2026-10-07', { tokens: 50_000_000, activeMin: 120, parts: [] }],
      ['layout', { v: 1 }],
    ])
    const kv: KV = {
      get: async key => map.get(key),
      set: async (key, value) => void map.set(key, value),
      delete: async key => void map.delete(key),
      keys: async () => [...map.keys()],
    }
    await addToDay(kv, '2026-10-09', 'a', 400_000, 60)
    await rollUp(kv, '2026-10-10')
    expect([...map.keys()].sort()).toEqual(['layout', 'nd:2026-10-09'])
    expect(await loadDays(kv, '2026-10-10')).toEqual([{ day: '2026-10-09', tokens: 400_000, activeMin: 60 }])
  })

  test('pace keeps one sample a minute, so a busy hour keeps every token', () => {
    let recent: [number, number][] = []
    for (let i = 0; i < 600; i++) recent = addRecent(recent, T0 + i * 6000, 100)
    expect(recent.length).toBeLessThanOrEqual(61)
    expect(paceAt(recent, T0 + 599 * 6000)).toBe(60_000)
  })

  test('the band shows the pace and, past 10 minutes, the 5h ETA in amber', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { fiveHour: 40, fiveResetsIn: 240 } })
    await start($, w)
    await turn($, w, { tokens: 300_000, minutes: 1 })
    // Idle time counts toward the hour of data too; the session's first reading was at 40%.
    await w.clock.advance(20 * MINUTE)
    w.usage.fiveHour = 60
    await turn($, w, { tokens: 300_000, minutes: 1 })
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    // 300k new tokens just now and 300k 21 minutes ago: 2.6M an hour at the last few minutes' pace.
    expect(await ui.find({ type: 'Text', text: '2.6M/h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^empties \d\d:\d\d$/ })).toBeDefined()
    await ui.unmount()
  })
})
