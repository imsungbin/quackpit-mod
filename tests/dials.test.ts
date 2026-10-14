import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_COLOR } from '../src/cells'
import { fuelGauge, paceReading } from '../src/derive'
import { dialCells, dialPixels, INK, type DialSpec } from '../src/dial'
import { instrumentOf } from '../src/instruments'
import { nowRate } from '../src/metrics'
import { newCockpit, onReading, onStep, type Cockpit } from '../src/model'
import { readingsOf } from '../src/tiles'
import { lineWidth, plain } from '../src/text'
import { at, decode, EN, HOUR, LIMIT_MS, MINUTE, PANE, start, turn, world } from './kit'

const T0 = at(2026, 10, 12, 14)
const pace = (needle: number | undefined, isGrey = false): DialSpec => ({ ...(needle !== undefined ? { needle } : {}), isGrey, bug: 0.5, warnFrom: 0.75, badFrom: 0.9 })
const paneAt = (bodyColumns: number) => ({ ...PANE, props: { ...PANE.props, bodyColumns } })

/** The five-hour window read at each `[minutes past T0, %]`, resetting `resetIn` minutes after T0. */
function readFive(points: [number, number][], resetIn: number): Cockpit {
  let c = newCockpit(T0 - 3 * HOUR, 's')
  for (const [m, pct] of points) c = onReading(c, { at: T0 + m * MINUTE, fiveHour: { pct, resetsAt: T0 + resetIn * MINUTE }, pushed: true })
  return c
}

describe('the dials (pane)', () => {
  test('the dial in quadrant pixels: the needle from the hub, the bug over the top outside the rim, ink drawn in the foreground only', () => {
    const columns = (cells: string) => {
      const all = decode(cells)
      return { all, at: (x: number, y: number) => all[y * 17 + x] }
    }
    // At usual the needle stands straight up from the hub, in the middle column; the bug crowns the arc there, outside it.
    const up = columns(dialCells(dialPixels(pace(0.5), 17, 5)).cells)
    expect(up.at(8, 4)).toEqual(['█', INK, DEFAULT_COLOR])
    expect(up.at(8, 0)?.[1]).toBe(INK)
    // Pointing to 2× usual it lies to the right along the hub's row; at 0 to the left.
    const right = columns(dialCells(dialPixels(pace(1), 17, 5)).cells)
    expect(right.at(12, 4)?.[1]).toBe(INK)
    expect(right.at(4, 4)?.[0]).toBe(' ')
    const left = columns(dialCells(dialPixels(pace(0), 17, 5)).cells)
    expect(left.at(4, 4)?.[1]).toBe(INK)
    // Wherever a cell holds ink it is the glyph's own colour, never the background (the same value there means the terminal's background).
    for (const spec of [pace(0.1), pace(0.38), pace(0.5), pace(0.82), pace(0.97), pace(undefined, true)]) {
      for (const [cols, rows] of [[17, 5], [15, 4]] as const) {
        const pixels = dialPixels(spec, cols, rows)
        const cells = decode(dialCells(pixels).cells)
        cells.forEach(([, fg], i) => {
          const x = i % cols
          const y = Math.floor(i / cols)
          const quad = [pixels[2 * y]?.[2 * x], pixels[2 * y]?.[2 * x + 1], pixels[2 * y + 1]?.[2 * x], pixels[2 * y + 1]?.[2 * x + 1]]
          if (quad.includes(INK)) expect(fg, `cell ${x},${y}`).toBe(INK)
        })
      }
    }
    // The red zone ends the arc on the right; with too little data the needle is grey, not ink.
    expect(up.all.filter(([, fg]) => fg === 0xf85149).length).toBeGreaterThan(0)
    const grey = decode(dialCells(dialPixels(pace(undefined, true), 17, 5)).cells)
    expect(grey.filter(([, fg]) => fg === 0x8b949e).length).toBeGreaterThan(0)
  })

  test('one needle: where the trend ends is a grey sweep outside the rim from the needle, never a second needle; none on a stale dial', () => {
    const fuel = (needle: number, sweep: number, isGrey = false): DialSpec => ({ needle, sweep, isGrey, warnFrom: 0.8, badFrom: 0.9 })
    const greyOf = (spec: DialSpec) => decode(dialCells(dialPixels(spec, 15, 4)).cells).filter(([, fg]) => fg === 0x8b949e).length
    expect(greyOf(fuel(0.1, 0.6))).toBeGreaterThan(0)
    expect(greyOf({ needle: 0.1, isGrey: false, warnFrom: 0.8, badFrom: 0.9 })).toBe(0)
    // A trend that ends where the needle is says nothing more: no sweep; on a stale dial none either (the trend is as old as the reading).
    expect(greyOf(fuel(0.5, 0.505))).toBe(0)
    const stale = (sweep?: number) => dialCells(dialPixels({ needle: 0.2, isGrey: true, warnFrom: 0.8, badFrom: 0.9, ...(sweep !== undefined ? { sweep } : {}) }, 15, 4)).cells
    expect(stale(0.7)).toBe(stale())
    // The sweep lies outside the rim, the needle inside it: the ink from the hub is one line, the same with or without the sweep.
    const inkOf = (spec: DialSpec) => decode(dialCells(dialPixels(spec, 15, 4)).cells).map(([glyph, fg]) => (fg === INK ? glyph : ' ')).join('')
    expect(inkOf(fuel(0.4, 0.9))).toBe(inkOf({ needle: 0.4, isGrey: false, warnFrom: 0.8, badFrom: 0.9 }))
    // Health's dial has no zones: its needle carries the threshold's colour instead.
    const health = decode(dialCells(dialPixels({ needle: 0.45, isGrey: false, warnFrom: 1, badFrom: 1, noZones: true, needleLevel: 'bad' }, 15, 4)).cells)
    expect(health.some(([, fg]) => fg === 0xf85149)).toBe(true)
    expect(health.some(([, fg]) => fg === 0xe3a008)).toBe(false)
  })

  test('pace now falls while idle: a response counts half as much 5 minutes on; the hour\'s sum does not move till samples leave it', () => {
    const recent: [number, number][] = [[T0, 300_000]]
    const a = nowRate(recent, T0 + MINUTE)
    expect(Math.round(nowRate(recent, T0 + 6 * MINUTE) / a * 100) / 100).toBe(0.5)
    expect(Math.round(nowRate(recent, T0 + 11 * MINUTE) / a * 100) / 100).toBe(0.25)
    // A steady flow reads as itself: 10k tokens a minute for an hour is about 600k an hour.
    const steady: [number, number][] = Array.from({ length: 60 }, (_, i) => [T0 + i * MINUTE, 10_000])
    expect(Math.abs(nowRate(steady, T0 + 59 * MINUTE + 30_000) - 600_000) / 600_000).toBeLessThan(0.06)
    // The band's tile and the dial read the same rate; health reads the last hour's sum.
    const c: Cockpit = { ...newCockpit(T0 - HOUR, 's'), recent, activeMs: 20 * MINUTE, tokens: 600_000 }
    const p = paceReading(c, T0 + 6 * MINUTE, [], '2026-10-12')
    expect(p.hourSum).toBe(300_000)
    expect(Math.round(p.perHour)).toBe(Math.round(nowRate(recent, T0 + 6 * MINUTE)))
    expect(p.usualBasis).toBe('session')
    expect(p.idleMs).toBe(T0 + 6 * MINUTE - (T0 - HOUR))
  })

  test('the five-hour window as a fuel gauge: used, where the trend ends at the reset, how much of the window has passed (in its detail), when it runs out', () => {
    // 40% at 0, 55% at 30 minutes: 30 points an hour. The reset is 3 hours off, so the trend ends at 130%: it runs out at 16:00.
    const fast = fuelGauge(readFive([[0, 40], [10, 45], [20, 50], [30, 55]], 180), T0 + 30 * MINUTE)
    const near = (x: number | undefined) => Math.round((x ?? Number.NaN) * 1000) / 1000
    expect([fast?.pct, near(fast?.rate), near(fast?.atReset), near(fast?.elapsed), fast?.how]).toEqual([55, 30, 130, 0.5, 'fit'])
    expect(fast?.emptiesAt).toBe(T0 + 2 * HOUR)
    expect(fast?.level).toBe('warn')
    // 6 points an hour: 70% at the reset, no run-out, no colour.
    const slow = fuelGauge(readFive([[0, 52], [10, 53], [20, 54], [30, 55]], 180), T0 + 30 * MINUTE)
    expect([near(slow?.atReset), slow?.emptiesAt, slow?.level]).toEqual([70, undefined, 'none'])
    // Used up: red, until the reset. A run-out within 30 minutes is red too.
    expect(fuelGauge(readFive([[0, 98], [10, 99], [20, 100], [30, 100]], 180), T0 + 30 * MINUTE)).toMatchObject({ isUsedUp: true, level: 'bad' })
    expect(fuelGauge(readFive([[0, 70], [10, 80], [20, 90], [30, 95]], 180), T0 + 30 * MINUTE)?.level).toBe('bad')
    // Past its reset the reading is about a window that is over.
    expect(fuelGauge(readFive([[0, 50]], 20), T0 + 30 * MINUTE)?.isReset).toBe(true)
    // On the dial: one needle at the use on 0 to 100%, the sweep to the end of the trend; no tick: the reset's time is in the words.
    const cell = instrumentOf(readingsOf(readFive([[0, 40], [10, 45], [20, 50], [30, 55]], 180), { now: T0 + 30 * MINUTE, locale: 'en', days: [], today: '2026-10-12' }), 'five', 34, 'full')
    expect(cell.graphic?.kind === 'dial' ? cell.graphic.spec : undefined).toEqual({ needle: 0.55, sweep: 1, isGrey: false, warnFrom: 0.8, badFrom: 0.9 })
  })

  test("the account's readings go stale while this session is idle: the age is shown, the needle grey after 15 minutes", () => {
    let c = readFive([[0, 40], [10, 45], [20, 50], [30, 55]], 240)
    c = onStep(c, { at: T0 + 30 * MINUTE, startedAt: T0 + 29 * MINUTE, turnId: 't', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    const view = (minutes: number) => ({ now: T0 + minutes * MINUTE, locale: 'en' as const, days: [], today: '2026-10-12' })
    const five = (minutes: number) => instrumentOf(readingsOf(c, view(minutes)), 'five', 34, 'full')
    const spec = (minutes: number) => { const g = five(minutes).graphic; return g?.kind === 'dial' ? g.spec : undefined }
    expect(five(31).words.map(plain).at(-1)).toBe('read 1 min ago')
    expect(spec(31)?.isGrey).toBe(false)
    // Gone stale, the readings' age comes second, before the forecast: the needle is grey.
    expect(five(52).words.map(plain)[1]).toBe('read 22 min ago')
    expect(spec(52)?.isGrey).toBe(true)
  })

  test('the dials are instruments: full, 13 by 4, where two cells of 33 fit across; small, 9 by 3, in a narrower pane; every word inside its cell, in every language', () => {
    let c = readFive([[0, 40], [10, 45], [20, 50], [30, 55]], 180)
    c = { ...c, reading: c.reading && { ...c.reading, sevenDay: { pct: 61, resetsAt: T0 + 50 * HOUR } }, recent: [[T0 + 25 * MINUTE, 900_000]], cache: { read: 95, write: 4, input: 1 } }
    for (const L of ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant'] as const) {
      const days = [1, 2, 3].map(d => ({ day: `2026-10-0${d}`, tokens: 1_000_000, activeMin: 60 }))
      const r = readingsOf(c, { now: T0 + 30 * MINUTE, locale: L, days, today: '2026-10-12' })
      for (const [width, size, columns, rows] of [[33, 'full', 13, 4], [26, 'small', 9, 3]] as const) {
        for (const id of ['pace', 'five'] as const) {
          const cell = instrumentOf(r, id, width, size)
          expect([cell.graphic?.columns, cell.graphic?.rows], `${L} ${id} ${size}`).toEqual([columns, rows])
          expect(cell.words.length, `${L} ${id} rows`).toBeLessThanOrEqual(rows)
          for (const line of cell.words) {
            expect(lineWidth(line), `${L} ${plain(line)}`).toBeLessThanOrEqual(width - columns - 1)
            expect(plain(line), `${L} beside`).not.toContain('…')
          }
          expect(lineWidth(cell.title) + 2, `${L} ${plain(cell.title)}`).toBeLessThanOrEqual(width)
        }
      }
      const pace = instrumentOf(r, 'pace', 34, 'full').words.map(plain)
      const five = instrumentOf(r, 'five', 34, 'full').words.map(plain)
      if (L === 'en') {
        // 900k new tokens five minutes ago reads 3.7M an hour now; with no turn running, how long it has been idle.
        expect(pace).toEqual(['3.7M/h', '3.7× usual', 'idle 3h30m', '95% from cache'])
        expect(five).toEqual(['55% used', 'runs out ~16:00', '1h00 before reset', 'read just now'])
      } else if (L === 'ko') {
        expect(five).toEqual(['55% 사용', '~16:00 소진', '초기화 1h00 전', '방금 측정'])
      }
    }
  })

  test("until 3 past days are kept the pace dial says what it compares with: this session's own average", () => {
    const c: Cockpit = { ...newCockpit(T0 - HOUR, 's'), recent: [[T0 - MINUTE, 200_000]], activeMs: 30 * MINUTE, tokens: 1_000_000, turn: { id: 't', n: 3, startedAt: T0 - 5 * MINUTE, tools: 2, edits: 0, subTokens: 0, stepTokens: 0, inFlight: [] } }
    const words = (width: number, L: 'en' | 'ko' = 'en') => instrumentOf(readingsOf(c, { now: T0, locale: L, days: [], today: '2026-10-12' }), 'pace', width, 'full').words.map(plain)
    expect(words(46)[1]).toMatch(/^\d\.\d× this session's average$/)
    expect(words(34)[1]).toMatch(/^\d\.\d× session avg$/)
    // A session of 30 active minutes and a million new tokens: a million an hour (it counts at least an hour).
    expect(words(34)[2]).toBe('average 1M/h')
    expect(words(34, 'ko')[1]).toMatch(/^이 세션 평균의 \d\.\d배$/)
  })

  test('the seven-day window, where it runs out before its reset, joins the five-hour words in amber', () => {
    let c = readFive([[0, 52], [10, 53], [20, 54], [30, 55]], 180)
    c = { ...c, reading: c.reading && { ...c.reading, sevenDay: { pct: 90, resetsAt: T0 + 50 * HOUR } } }
    const cell = instrumentOf(readingsOf(c, { now: T0 + 30 * MINUTE, locale: 'en', days: [], today: '2026-10-12' }), 'five', 46, 'full')
    const last = cell.words.at(-1) ?? []
    expect(plain(last)).toMatch(/^7d runs out in ~(\d+d\d+h|\d+h\d\d)$/)
    expect(last[0]?.tone).toBe('warn')
  })

  test('drawn as quadrant cells in the terminal, a picture where it shows them, SVG on the desktop, the tachometer in designed text', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { fiveHour: 30, fiveResetsIn: 180 } })
    await start($, w)
    await turn($, w)
    const keys = async (surface: 'terminal' | 'desktop', type: string) => {
      const pane = await $.ui.mount({ plugin: 'quackpit', surface, ...paneAt(70) })
      // An Svg keeps no key on the desktop: a dial's is the one whose document draws its arc.
      const all = await pane.findAll({ type })
      const found = all.map(el => el.key ?? (String(el.props.source).includes('.t{stroke') ? 'dial' : undefined)).filter(key => key?.startsWith('dial'))
      await pane.unmount()
      return found
    }
    // Three dials: the pace, the five-hour window, health's score.
    expect(await keys('terminal', 'Raster')).toEqual(['dial-pace', 'dial-five', 'dial-health'])
    expect(await keys('desktop', 'Svg')).toEqual(['dial', 'dial', 'dial'])
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...paneAt(70) })
    expect(await pane.find({ type: 'Text', text: 'PACE' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '5H WINDOW' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '30% used' })).toBeDefined()
    // What the dial covers, and its scale, are its detail's now: a press away.
    expect(await pane.find({ type: 'Text', text: /all sessions/ })).toBeUndefined()
    await pane.unmount()
  })

  test('with graphics set to text the dials are the tachometer, no pixels', { options: { locale: 'en', graphics: 'text' }, timeoutMs: LIMIT_MS }, async ($, on) => {
    const w = world(on, { now: T0, usage: { fiveHour: 30, fiveResetsIn: 180 } })
    await start($, w)
    await turn($, w)
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...paneAt(70) })
    expect(await pane.find({ type: 'Raster', key: 'dial-pace' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /[▁▂▃▄▅▆▇█]{4,}/ })).toBeDefined()
    await pane.unmount()
  })
})
