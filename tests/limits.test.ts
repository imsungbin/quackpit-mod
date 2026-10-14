import { describe, expect, test } from 'claude-code/testing'

import { cautionsOf } from '../src/duck'
import { fiveHourForecast, forecast, FIVE_HOUR_MS, sevenDayForecast } from '../src/derive'
import { newCockpit, onReading, type Cockpit } from '../src/model'
import { limitsFace, readingsOf } from '../src/tiles'
import { plain } from '../src/text'
import { at, band, EN, HOUR, MINUTE, shaded, start, turn, world } from './kit'

const T0 = at(2026, 10, 11, 10)
const DAY = 24 * HOUR
const VIEW = (now: number) => ({ now, locale: 'en' as const, days: [], today: '2026-10-11' })

/** A cockpit that read the five-hour window at each `[minutes from T0, %]`. */
function readFive(points: [number, number][], resetsAt: number, seven?: { pct: number; resetsAt: number }): Cockpit {
  let c = newCockpit(T0, 's')
  for (const [m, pct] of points) c = onReading(c, { at: T0 + m * MINUTE, fiveHour: { pct, resetsAt }, ...(seven ? { sevenDay: seven } : {}) })
  return c
}

describe('plan limits', () => {
  test('the 5h forecast is a least-squares line through the last 90 minutes of readings, 3 and 10 minutes at least', () => {
    // A jumpy window: a line through every reading, so one jump of a point does not swing it.
    const c = readFive([[0, 40], [10, 46], [20, 49], [30, 55]], T0 + 4 * HOUR)
    const f = fiveHourForecast(c)
    expect(f?.how).toBe('fit')
    // Slope (by hand, in minutes): sxy 240 / sxx 500 = 0.48 points a minute; 55 + 0.48 × 210 at reset.
    expect(Math.round((f?.rate ?? 0) * MINUTE * 1000)).toBe(480)
    expect(Math.round(f?.atReset ?? 0)).toBe(156)
    // Readings older than 90 minutes are no part of it.
    const old = readFive([[-120, 5], [0, 40], [10, 46], [20, 49], [30, 55]], T0 + 4 * HOUR)
    expect(fiveHourForecast(old)?.rate).toBe(f?.rate)
  })

  test('without enough readings it falls back to the use so far over the time the window has been open', () => {
    // Opened 2 hours ago (it resets in 3), 30% used: 15 points an hour, so ~75% at reset.
    const c = readFive([[0, 30]], T0 + 3 * HOUR)
    expect(fiveHourForecast(c)).toEqual({ rate: 30 / (2 * HOUR), how: 'average', atReset: 75 })
    // Ten minutes into a window is too soon to say anything.
    expect(forecast({ pct: 3, resetsAt: T0 + FIVE_HOUR_MS - 5 * MINUTE }, FIVE_HOUR_MS, T0, undefined)).toBeUndefined()
  })

  test('the 7-day window is forecast too, at its average so far', () => {
    // Open 3 days, 30% used: 10 a day, 4 days to go: ~70% at reset.
    const c = readFive([[0, 10]], T0 + 4 * HOUR, { pct: 30, resetsAt: T0 + 4 * DAY })
    const f = sevenDayForecast(c)
    expect(f?.how).toBe('average')
    expect(Math.round(f?.atReset ?? 0)).toBe(70)
  })

  test('the meter draws the projected use at reset in a second shade, in the band and in the pane', EN, async ($, on) => {
    const c = readFive([[0, 30]], T0 + 3 * HOUR, { pct: 30, resetsAt: T0 + 4 * DAY })
    const face = limitsFace(readingsOf(c, VIEW(T0)))
    expect(shaded(face.lines[0])).toBe('5h ▰▰▓▓▱  30% → ~75% ↻3h00')
    expect(shaded(face.lines[1])).toBe('7d ▰▰▓▓▱  30% → ~70% ↻4d0h')
    // A week that runs out days before its reset says in how long, not a bare time of day.
    const week = readFive([[0, 10]], T0 + 4 * HOUR, { pct: 60, resetsAt: T0 + 4 * DAY })
    expect(shaded(limitsFace(readingsOf(week, VIEW(T0))).lines[1])).toBe('7d ▰▰▰▓▓  60% → full in ~2d0h ↻4d0h')
    // Running out before the reset says when, in amber.
    const fast = readFive([[0, 40], [10, 50], [20, 60], [30, 70]], T0 + 4 * HOUR)
    const fastFace = limitsFace(readingsOf(fast, VIEW(T0 + 30 * MINUTE)))
    expect(shaded(fastFace.lines[0])).toMatch(/^5h ▰▰▰▰▓  70% → full ~\d\d:\d\d ↻3h30$/)
    expect(fastFace.lines[0].find(span => span.text.includes('full'))?.tone).toBe('warn')
    const w = world(on, { now: T0, usage: { fiveHour: 30, fiveResetsIn: 180 } })
    await start($, w)
    await w.clock.advance(MINUTE)
    await turn($, w)
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...{ component: 'Pane' as const, requestId: 'quackpit', props: { title: 'quackpit', isFocused: false, bodyColumns: 110, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} } } })
    // The pane's account dial, a fuel gauge: what is used and where the trend ends at the reset; no rate beside it.
    expect(await pane.find({ type: 'Text', text: '30% used' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^~7\d% at reset$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /%\/h|what lasts/ })).toBeUndefined()
    await pane.unmount()
  })

  test('a reading whose reset has passed is a reset: no caution, never ↻0m', EN, async ($, on) => {
    const c = readFive([[0, 95]], T0 + 30 * MINUTE)
    expect(cautionsOf(c, T0 + 10 * MINUTE).map(k => k.kind)).toEqual(['five'])
    // Its reset came and no reading followed yet.
    expect(cautionsOf(c, T0 + 31 * MINUTE)).toEqual([])
    const face = limitsFace(readingsOf(c, VIEW(T0 + 31 * MINUTE)))
    expect(plain(face.lines[0])).toBe('5h ▱▱▱▱▱ reset')
    expect(face.level).toBe('none')
    const w = world(on, { now: T0, usage: { fiveHour: 95, fiveResetsIn: 20 } })
    await start($, w)
    await w.clock.advance(25 * MINUTE)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: /↻0m/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '▱▱▱▱▱ reset' })).toBeDefined()
    await ui.unmount()
  })

  test('the 5h caution keeps quiet when the window lasts until a reset under 30 minutes away', () => {
    // 85%, resetting in 20 minutes, rising a point every 10: ~87% at reset. Nothing to do.
    const calm = readFive([[0, 83], [10, 84], [20, 85]], T0 + 40 * MINUTE)
    expect(cautionsOf(calm, T0 + 20 * MINUTE)).toEqual([])
    // The same window 40 minutes from its reset: the caution stands.
    const far = readFive([[0, 83], [10, 84], [20, 85]], T0 + 60 * MINUTE)
    expect(cautionsOf(far, T0 + 20 * MINUTE).map(k => k.kind)).toEqual(['five'])
    // Resetting soon but running out first: it stands, and at 90% it notifies.
    const short = readFive([[0, 80], [10, 85], [20, 91]], T0 + 40 * MINUTE)
    expect(cautionsOf(short, T0 + 20 * MINUTE)).toMatchObject([{ kind: 'five', isNotify: true }])
  })
})
