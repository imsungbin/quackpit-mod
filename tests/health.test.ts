import { describe, expect, test } from 'claude-code/testing'

import type { PaceReading } from '../src/derive'
import { clockText } from '../src/format'
import { HEALTH_PARTS, HEALTH_WEIGHTS, healthOf, healthWord, lineShare, nightMs, partValue, shareOf, weakestHint } from '../src/health'
import { extendStretch, joinStretch, newCockpit, onCompact, onPrompt, onReading, onToolEnd, onToolStart, onTurnEnd, onTurnStart, PAUSE_MS, type Cockpit } from '../src/model'
import { plain } from '../src/text'
import { readingsOf, tileFace } from '../src/tiles'
import { at, band, bash, command, EN, HOUR, MINUTE, start, turn, world } from './kit'

const T0 = at(2026, 10, 13, 14)
const NO_PACE: PaceReading = { perHour: 0, hourSum: 0, hasData: false, level: 'none' }
/** A pace `ratio` times usual, now and over the last hour alike (health reads the last hour's). */
const paceAt = (ratio: number): PaceReading => ({ perHour: 10_000 * ratio, hourSum: 10_000 * ratio, hasData: true, usual: 10_000, ratio, hourRatio: ratio, needle: ratio / 2, level: 'none' })

/** A turn of one minute at `from` minutes past T0, costing `tokens`. */
function turnAt(c: Cockpit, id: string, from: number, tokens: number): Cockpit {
  const started = onTurnStart(c, { at: T0 + from * MINUTE, turnId: id, text: 'go' })
  return onTurnEnd(started, { at: T0 + (from + 1) * MINUTE, turnId: id, tokens, durationMs: MINUTE, isAborted: false })
}

describe("health, quackpit's own", () => {
  test('the formula: seven parts weighed to 100, each a straight line from whole to nothing, its word and its colour by threshold', () => {
    expect(HEALTH_PARTS).toEqual(['checks', 'context', 'window', 'runaway', 'pace', 'breaks', 'night'])
    expect(Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100)
    expect([lineShare(2, 2, 15), lineShare(8.5, 2, 15), lineShare(15, 2, 15), lineShare(40, 2, 15), lineShare(0, 2, 15)]).toEqual([1, 0.5, 0, 0, 1])
    const shares = [
      [{ id: 'checks', edits: 2, hasPassed: true }, { id: 'checks', edits: 8.5, hasPassed: true }, { id: 'checks', edits: 15, hasPassed: false }],
      [{ id: 'context', pct: 50, ofCompact: true, compactions: 0 }, { id: 'context', pct: 75, ofCompact: true, compactions: 0 }, { id: 'context', pct: 10, ofCompact: true, compactions: 2 }],
      [{ id: 'window', atReset: 90, pct: 20, isUsedUp: false }, { id: 'window', atReset: 105, pct: 40, isUsedUp: false }, { id: 'window', pct: 100, isUsedUp: true }],
      [{ id: 'runaway', count: 0 }, { id: 'runaway', count: 1, last: 7 }, { id: 'runaway', count: 2, last: 9 }],
      [{ id: 'pace', ratio: 1.2 }, { id: 'pace', ratio: 1.6 }, { id: 'pace', ratio: 2.4 }],
      [{ id: 'breaks', minutes: 120, isPaused: false, since: T0 }, { id: 'breaks', minutes: 210, isPaused: false, since: T0 }, { id: 'breaks', minutes: 300, isPaused: false, since: T0 }],
      [{ id: 'night', minutes: 0 }, { id: 'night', minutes: 60 }, { id: 'night', minutes: 120 }],
    ] as const
    expect(shares.map(row => row.map(reading => Math.round(shareOf(reading) * 100) / 100))).toEqual([
      [1, 0.5, 0],
      [1, 0.5, 0.5],
      [1, 0.5, 0],
      [1, 0.5, 0],
      [1, 0.5, 0],
      [1, 0.5, 0],
      [1, 0.5, 0],
    ])
    expect([100, 85, 84, 70, 69, 50, 49, 0].map(healthWord)).toEqual(['smooth', 'smooth', 'light', 'light', 'choppy', 'choppy', 'turbulent', 'turbulent'])
  })

  test('a part with nothing to judge counts whole and says so; a fresh session measures nothing', () => {
    const fresh = healthOf(newCockpit(T0, 's'), T0, NO_PACE)
    expect(fresh).toMatchObject({ score: 100, word: 'smooth', level: 'none', isMeasuring: false })
    expect(fresh.weakest).toBeUndefined()
    expect(fresh.parts.map(p => [p.id, p.off, partValue(p, 'en', clockText)])).toEqual([
      ['checks', 0, 'nothing to judge yet: no check has run'],
      ['context', 0, 'nothing to judge yet: no reading'],
      ['window', 0, 'nothing to judge yet: no 5h forecast'],
      ['runaway', 0, 'nothing to judge yet: under 6 turns'],
      ['pace', 0, 'nothing to judge yet: no usual pace'],
      ['breaks', 0, 'nothing to judge yet: no prompt'],
      ['night', 0, 'nothing to judge yet: no prompt'],
    ])
    expect(weakestHint(fresh, 'en')).toBe('nothing to judge yet')
    expect(weakestHint(fresh, 'ko')).toBe('아직 판단할 것 없음')
    // Found live after /clear: a usual pace was kept, so the pace part waits for 10 minutes of watching, not for a usual.
    const warming = healthOf(newCockpit(T0, 's'), T0, { ...NO_PACE, usual: 295_000, usualBasis: 'days' })
    const pace = warming.parts.find(p => p.id === 'pace')
    expect(pace).toMatchObject({ off: 0, isWarming: true })
    expect(pace ? partValue(pace, 'en', clockText) : '').toBe('nothing to judge yet: watched under 10 minutes')
  })

  test("a session's parts: what each measured, what it took off, the points adding up to 100 less the score", () => {
    let c = newCockpit(T0 - 4 * HOUR, 's')
    // The person's prompts every 20 minutes from 10:00 to 14:00: four hours with no 30-minute pause.
    for (let m = -240; m <= 0; m += 20) c = onPrompt(c, { at: T0 + m * MINUTE, text: `step ${m}`, isPersonal: true })
    // Five ordinary turns, then one at ten times their cost: a runaway.
    for (let i = 0; i < 5; i++) c = turnAt(c, `t${i}`, -200 + i * 10, 1000)
    c = turnAt(c, 'big', -100, 10_000)
    // A check passed, then eight edits came after it.
    const run = { at: T0 - 90 * MINUTE, id: 'run', tool: 'Bash', input: { command: 'pnpm test' } }
    c = onToolEnd(onToolStart(c, run), { ...run, outcome: 'ok', text: 'Tests  4 passed (4)', result: { stdout: 'Tests  4 passed (4)', stderr: '', interrupted: false } })
    for (let i = 0; i < 8; i++) {
      const edit = { at: T0 - 60 * MINUTE + i * MINUTE, id: `e${i}`, tool: 'Edit', input: { file_path: `/work/f${i % 3}.ts` } }
      c = onToolEnd(onToolStart(c, edit), { ...edit, outcome: 'ok', text: 'ok' })
    }
    // The context once compacted, and now near the auto-compact point.
    c = onCompact(c, { at: T0 - 30 * MINUTE, isSkipped: false, isPrecompute: false })
    c = onReading(c, { at: T0, contextTokens: 160_000, contextPct: 80, contextWindow: 200_000 })
    c = { ...c, autoCompact: { at: T0, turn: 6, isOn: true, threshold: 167_000 } }
    const h = healthOf(c, T0, paceAt(1.6))
    const byId = Object.fromEntries(h.parts.map(p => [p.id, p]))
    expect(byId.checks?.reading).toEqual({ id: 'checks', edits: 8, hasPassed: true })
    expect(byId.context?.reading).toMatchObject({ id: 'context', ofCompact: true, compactions: 1 })
    expect(byId.runaway?.reading).toEqual({ id: 'runaway', count: 1, last: 6 })
    expect(byId.breaks?.reading).toMatchObject({ id: 'breaks', minutes: 240, isPaused: false })
    expect(byId.night?.reading).toEqual({ id: 'night', minutes: 0 })
    expect(byId.window?.reading).toBeUndefined()
    // checks 25×(1−7/13)=11.5, context 20×(1−0.08)=18.3, runaway 5, pace 5, breaks 10×(1−60/180)=6.7: 46.6 off.
    expect(h.score).toBe(53)
    expect(h.parts.reduce((sum, p) => sum + p.off, 0)).toBe(100 - h.score)
    expect(h.parts.map(p => p.off)).toEqual([12, 18, 0, 5, 5, 7, 0])
    expect([h.word, h.level, h.weakest?.id]).toEqual(['choppy', 'warn', 'context'])
    expect(weakestHint(h, 'en')).toBe('context 96%')
    expect(h.parts.map(p => partValue(p, 'en', clockText))).toEqual([
      '8 edits since a check last passed',
      '96% of the way to auto-compact · 1 compaction',
      'nothing to judge yet: no 5h forecast',
      '1 in the last 10 turns (turn 6)',
      '1.6× your usual over the last hour',
      '4h00 with no 30-minute pause, since 10:00',
      'none in this stretch',
    ])
    // Until 3 past days are kept, usual is this session's own average, and the part names it so, as the dial does.
    expect(partValue({ ...h.parts[4]!, reading: { id: 'pace', ratio: 1.6, isSession: true } }, 'en', clockText)).toBe("last hour 1.6× this session's average")
    // Under 50 it turns red.
    expect(healthOf({ ...c, compactions: 4 }, T0, paceAt(2.5)).level).toBe('bad')
  })

  test("breaks and the night come from the person's own prompts: a 30-minute pause starts a new stretch", () => {
    const late = at(2026, 10, 12, 22, 30)
    let c = newCockpit(late, 's')
    for (let m = 0; m <= 180; m += 15) c = onPrompt(c, { at: late + m * MINUTE, text: 'more', isPersonal: true })
    // At 01:30 the stretch began at 22:30, and 90 minutes of it fell after midnight.
    const h = healthOf(c, late + 180 * MINUTE, NO_PACE)
    expect(h.parts.find(p => p.id === 'breaks')?.reading).toMatchObject({ minutes: 180, isPaused: false })
    expect(h.parts.find(p => p.id === 'night')?.reading).toEqual({ id: 'night', minutes: 90 })
    expect(weakestHint(h, 'en')).toBe('night work 1h30')
    // Half an hour with no prompt is a pause: the stretch is over, and so is the night's.
    const paused = healthOf(c, late + 211 * MINUTE, NO_PACE)
    expect(paused.parts.find(p => p.id === 'breaks')?.reading).toMatchObject({ minutes: 0, isPaused: true })
    expect(partValue(paused.parts.find(p => p.id === 'breaks') ?? paused.parts[0]!, 'en', clockText)).toBe('on a pause since 01:30')
    expect(paused.score).toBe(100)
    expect(extendStretch({ from: late, last: late + MINUTE }, late + MINUTE + PAUSE_MS)).toEqual({ from: late + MINUTE + PAUSE_MS, last: late + MINUTE + PAUSE_MS })
    expect(joinStretch({ from: late, last: late + 10 * MINUTE }, { from: late + 20 * MINUTE, last: late + 25 * MINUTE })).toEqual({ from: late, last: late + 25 * MINUTE })
    expect(nightMs(at(2026, 10, 12, 23), at(2026, 10, 14, 7))).toBe(12 * HOUR)
    // A rebuilt transcript's prompts have no times: they make no stretch.
    expect(onPrompt(newCockpit(T0, 's'), { at: T0, text: 'old', isPersonal: true, isReplay: true }).stretch).toBeUndefined()
  })

  test('in the band: the score, its word and its weakest part; the duck never quacks for health', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { ctxTokens: 30_000, ctxPct: 15 } })
    await start($, w)
    await command($, 'add health')
    w.bash = () => ({ ok: true, stdout: 'Tests  3 passed (3)' })
    const edit = (n: number) => ({ tool: 'Edit' as const, file_path: `/work/src/f${n}.ts`, old_string: 'a', new_string: 'b' })
    await turn($, w, { prompt: 'Fix the parser', tools: [bash('pnpm test'), edit(1), edit(2), edit(3), edit(4), edit(5), edit(6), edit(7), edit(8), edit(9), edit(1), edit(2), edit(3), edit(4), edit(5), edit(6)] })
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band(200) })
    // 15 edits since the pass take its whole 25 off; nothing else has anything against it.
    const score = await ui.find({ type: 'Text', text: '75 light chop' })
    expect(score).toBeDefined()
    expect(score?.props.color).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: ' · 15 edits unverified' })).toBeDefined()
    await ui.unmount()
    expect(w.toasts.filter(text => text.startsWith('Quack:'))).toEqual([])
    expect(w.notified).toEqual([])
    const r = readingsOf(newCockpit(T0, 's'), { now: T0, locale: 'ko', days: [], today: '2026-10-13' })
    expect(plain(tileFace(r, 'health').lines[1])).toBe('건강 · 아직 판단할 것 없음')
  })

  test("the person's stretch goes on through /clear: they did not pause for it", EN, async ($, on) => {
    let fresh = false
    const held = new Map<string, { value: unknown; version: number }>()
    on('state.get', ($2, e, next) => {
      if (!fresh || e.plugin !== 'quackpit') return next(e)
      const h = held.get(e.key) ?? { value: undefined, version: 0 }
      return { value: { value: h.value as never, version: h.version } }
    })
    // Typed loosely: the state events' declared shapes are too deep for the checker here.
    const onLoose = on as unknown as (event: 'state.set', hook: ($2: unknown, e: { plugin: string; key: string; value: unknown }, next: (e: unknown) => unknown) => unknown) => void
    onLoose('state.set', ($2, e, next) => {
      if (!fresh || e.plugin !== 'quackpit') return next(e)
      const version = (held.get(e.key)?.version ?? 0) + 1
      held.set(e.key, { value: e.value, version })
      return { value: { isSet: true, version } }
    })
    const w = world(on, { now: T0 })
    await start($, w)
    await command($, 'add health')
    for (let i = 0; i < 8; i++) {
      await turn($, w, { prompt: `step ${i}` })
      await w.clock.advance(19 * MINUTE)
    }
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    fresh = true
    w.sid = 'session-2'
    w.messages = [{ role: 'user', text: '<command-name>/clear</command-name>', toolUses: [] }]
    await turn($, w, { prompt: 'Now the signup form' })
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band(200) })
    // Prompts since 14:00, the last at 16:33: two and a half hours with no pause, through the /clear.
    expect(await ui.find({ type: 'Text', text: ' · 2h34 with no pause' })).toBeDefined()
    await ui.unmount()
  })
})
