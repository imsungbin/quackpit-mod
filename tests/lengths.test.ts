import { describe, expect, test } from 'claude-code/testing'

import { calibration, historyLeft, quantile, turnFact } from '../src/lengths'
import { newCockpit, onTurnStart, type Cockpit } from '../src/model'
import { toRecord } from '../src/record'
import { factText, heroFace, readingsOf } from '../src/tiles'
import { plain } from '../src/text'
import { at, band, EN, LIMIT_MS, MINUTE, start, world } from './kit'

const T0 = at(2026, 10, 12, 9)
const S = 1000

/** Turns of 10 s, 20 s, ... 300 s: thirty of them. */
const thirty = Array.from({ length: 30 }, (_, i) => (i + 1) * 10 * S)

/** A record of another session whose turns took these lengths. */
function recordWith(sid: string, turns: number[], savedAt: number) {
  const c: Cockpit = { ...newCockpit(savedAt - MINUTE, sid), durations: { tasks: [], agents: {}, turns } }
  return toRecord(c, savedAt)
}

describe('your turns, as recorded', () => {
  test('the fact rounds down to what it knows: half, 60% ... 90%, 95%, 99%, or longer than any; nothing under 20 turns or under half', () => {
    expect(turnFact(thirty.slice(0, 19), 10 * MINUTE)).toBeUndefined()
    // 14 of 30 are shorter than 150 s: under half, nothing to say.
    expect(turnFact(thirty, 150 * S)).toBeUndefined()
    expect(turnFact(thirty, 151 * S)).toEqual({ kind: 'share', pct: 50, n: 30 })
    // 27 of 30 shorter: 90%, not 93%.
    expect(turnFact(thirty, 275 * S)).toEqual({ kind: 'share', pct: 90, n: 30 })
    expect(turnFact(thirty, 295 * S)).toEqual({ kind: 'share', pct: 95, n: 30 })
    expect(turnFact(thirty, 301 * S)).toEqual({ kind: 'longest', n: 30 })
    expect(['en', 'ko'].map(L => factText({ kind: 'share', pct: 90, n: 30 }, L as 'en' | 'ko'))).toEqual(['longer than 90% of your turns', '평소 턴의 90%보다 길어요'])
    expect(factText({ kind: 'share', pct: 50, n: 30 }, 'en')).toBe('longer than half your turns')
    expect(factText({ kind: 'longest', n: 214 }, 'en')).toBe('longer than any of your last 214 turns')
  })

  test("history alone: the median of your turns that ran longer than this one so far, less its time; none under 3 of them", () => {
    // Past 60 s: 70 s ... 300 s are longer, their median 185 s; 125 s are left.
    expect(historyLeft(thirty, 60 * S)).toBe(125 * S)
    expect(historyLeft(thirty, 275 * S)).toBe(15 * S)
    expect(historyLeft(thirty, 285 * S)).toBeUndefined()
    expect(quantile(thirty, 0.5)).toBe(150 * S)
    expect(quantile(thirty, 0.9)).toBe(270 * S)
    expect(calibration(thirty, 60 * S)).toEqual({ n: 30, p50: 150 * S, p90: 270 * S, p95: 290 * S, longer: { n: 24, p50: 180 * S, p90: 280 * S } })
  })

  test('a long turn with no estimate says how it compares with your turns, beside its count or alone when narrow', () => {
    const priors = { tasks: [], agents: {}, turns: thirty }
    const c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
    const view = (minutes: number, L: 'en' | 'ko' = 'en') => ({ now: T0 + minutes * MINUTE, locale: L, days: [], today: '2026-10-12', priors })
    expect(plain(heroFace(readingsOf(c, view(1)), 60).lines[1])).toBe('turn 1 · 0 tools')
    expect(plain(heroFace(readingsOf(c, view(4.6)), 60).lines[1])).toBe('turn 1 · 0 tools · longer than 90% of your turns')
    expect(plain(heroFace(readingsOf(c, view(4.6)), 32).lines[1])).toBe('longer than 90% of your turns')
    // A full band leaves the hero about 28 columns: the short form, never the count instead of the news.
    expect(plain(heroFace(readingsOf(c, view(4.6)), 28).lines[1])).toBe('longer than 90% of turns')
    expect(plain(heroFace(readingsOf(c, view(4.6, 'ko')), 20).lines[1])).toBe('90%보다 긴 턴')
    expect(plain(heroFace(readingsOf(c, view(6)), 26).lines[1])).toBe('longest of 30 turns')
    expect(plain(heroFace(readingsOf(c, view(4.6, 'ko')), 60).lines[1])).toBe('턴 1 · 도구 0회 · 평소 턴의 90%보다 길어요')
    // Never a guessed number: no countdown, no pond.
    expect(heroFace(readingsOf(c, view(4.6)), 60).pond).toBeUndefined()
  })

  test("in a session: other sessions' turns are read with their records, and the band says the fact", { options: { locale: 'en' }, timeoutMs: LIMIT_MS }, async ($, on) => {
    const w = world(on, { now: T0, store: { 's:earlier': recordWith('earlier', thirty, T0 - 60 * MINUTE) } })
    await start($, w)
    await $.turn.start({ text: 'Refactor the parser', turnId: 'long' })
    // Past the longest of them (5 minutes).
    await w.clock.advance(6 * MINUTE)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: /longer than any of your last 30 turns/ })).toBeDefined()
    await ui.unmount()
  })

  test('with too few recorded turns a long turn says nothing more', EN, async ($, on) => {
    const w = world(on, { now: T0, store: { 's:earlier': recordWith('earlier', thirty.slice(0, 5), T0 - 60 * MINUTE) } })
    await start($, w)
    await $.turn.start({ text: 'Refactor the parser', turnId: 'long' })
    await w.clock.advance(30 * MINUTE)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: /longer than/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'turn 1 · 0 tools' })).toBeDefined()
    await ui.unmount()
  })
})
