import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_COLOR, QUADRANTS, quadrantCells } from '../src/cells'
import { cautionsOf, cautionText, duckState, NOTIFY_PER_DAY, takeNotifySlot } from '../src/duck'
import { duckCells } from '../src/gauges'
import { guideRows } from '../src/guide'
import { t } from '../src/i18n'
import { DUCK_12x4, DUCK_16, DUCK_COLUMNS, QUACK_FRAMES, STEADY } from '../src/sprites'
import { acknowledge, hasRunningAgents, newCockpit, onReading, onToolEnd, onToolStart, onTurnEnd, onTurnStart, type Cockpit } from '../src/model'
import { at, band, bash, command, decode, EN, LIMIT_MS, MINUTE, start, turn, world } from './kit'

const T0 = at(2026, 10, 11, 10)

describe('the duck (Master Caution)', () => {
  test('it raises its head only at the thresholds: five_hour 80%, context 90%, a failed check, a runaway turn', () => {
    const idle = newCockpit(T0, 's')
    expect(duckState(idle).pose).toBe('idle')
    const five79 = onReading(idle, { at: T0, fiveHour: { pct: 79.9 }, contextPct: 89 })
    expect(cautionsOf(five79)).toEqual([])
    const five80 = onReading(idle, { at: T0, fiveHour: { pct: 80, resetsAt: T0 + 60 * MINUTE } })
    expect(cautionsOf(five80)).toMatchObject([{ kind: 'five', level: 'warn', isNotify: false }])
    const five90 = onReading(idle, { at: T0, fiveHour: { pct: 90, resetsAt: T0 + 60 * MINUTE } })
    expect(cautionsOf(five90)).toMatchObject([{ kind: 'five', level: 'bad', isNotify: true }])
    const ctx90 = onReading(idle, { at: T0, contextPct: 90 })
    expect(cautionsOf(ctx90)).toMatchObject([{ kind: 'context', level: 'bad', isNotify: false }])
    // A runaway: over 3x the median of 5 earlier turns.
    let c = idle
    for (let i = 0; i < 6; i++) {
      c = onTurnStart(c, { at: T0 + i * MINUTE, turnId: `t${i}`, text: 'go' })
      c = onTurnEnd(c, { at: T0 + i * MINUTE + 1000, turnId: `t${i}`, tokens: i === 5 ? 3100 : 1000, durationMs: 1000, isAborted: false })
    }
    expect(cautionsOf(c)).toMatchObject([{ kind: 'runaway', turn: 6 }])
    const state = duckState(c)
    expect(state.pose).toBe('alert')
    // Pressed (acknowledged), it settles; the cause is still listed.
    const pressed = acknowledge(c, cautionsOf(c).map(k => k.key))
    expect(duckState(pressed)).toMatchObject({ pose: 'idle', live: 1 })
  })

  test('aborted turns and turns without usage stay out of the median a runaway is judged against', () => {
    let c: Cockpit = newCockpit(T0, 's')
    let i = 0
    const turnOf = (tokens: number, isAborted = false) => {
      c = onTurnStart(c, { at: T0 + i * MINUTE, turnId: `t${i}`, text: 'go' })
      c = onTurnEnd(c, { at: T0 + i * MINUTE + 1000, turnId: `t${i}`, tokens, durationMs: 1000, isAborted })
      i++
    }
    for (const tokens of [40_000, 50_000, 60_000, 45_000, 55_000]) turnOf(tokens)
    for (let n = 0; n < 5; n++) turnOf(0, true)
    expect(c.turnTokens).toEqual([40_000, 50_000, 60_000, 45_000, 55_000])
    // Against 50k, 70k is an ordinary turn (with the empty ones counted, the median was 20k).
    turnOf(70_000)
    expect(cautionsOf(c)).toEqual([])
    turnOf(200_000)
    const [runaway] = cautionsOf(c)
    expect(runaway).toMatchObject({ kind: 'runaway', turn: 12 })
    expect(runaway && cautionText(runaway, 'en')).toBe('turn 12 cost 3.8× the median')
  })

  test('the duck names the same caution from one reading to the next', () => {
    let c: Cockpit = onReading(newCockpit(T0, 's'), { at: T0, contextPct: 95 })
    const call = { at: T0 + MINUTE, id: 'x', tool: 'Bash', input: { command: 'pnpm test' } }
    c = onToolEnd(onToolStart(c, call), { ...call, outcome: 'error', text: 'Exit code 1\nTests  1 failed (1)' })
    expect(duckState(c).caution?.kind).toBe('check')
    c = onReading(c, { at: T0 + 2 * MINUTE, contextPct: 96 })
    expect(duckState(c).caution?.kind).toBe('check')
  })

  test('two cautions that notify in one moment take two of the day\'s three slots, not more', EN, async ($, on) => {
    const w = world(on, { now: T0, store: { notify: { day: '2026-10-11', count: 2 } }, usage: { fiveHour: 50, fiveResetsIn: 120 } })
    // The test fails while the 5h window passes 90%: one event raises both.
    w.bashMs = 2500
    w.bash = () => {
      w.usage.fiveHour = 92
      return { ok: false, stdout: 'Tests  1 failed (1)' }
    }
    await start($, w)
    await turn($, w, { tools: [bash('pnpm test')] })
    expect(w.notified).toEqual([{ text: 'pnpm test', title: 'Quack: tests failed' }])
    expect(w.store.get('notify')).toEqual({ day: '2026-10-11', count: 3 })
    expect(w.toasts).toContain('Quack: 5h window at 92%')
  })

  test('the quack plays once for each caution announced; new readings never replay it', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { ctxPct: 50 } })
    await start($, w)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    await w.clock.advance(2000)
    const quacks = () => w.blits.filter(b => b.key === 'duck-g').length
    w.usage.ctxPct = 95
    await turn($, w)
    // The quack's frames after the first: alert, shut, alert, shut.
    expect(quacks()).toBe(4)
    w.bash = () => ({ ok: false, stdout: 'Tests  1 failed (1)' })
    await turn($, w, { tools: [bash('pnpm test')] })
    expect(quacks()).toBe(8)
    // Readings move, nothing new is wrong: the duck holds its pose.
    for (const pct of [96, 97, 98]) {
      w.usage.ctxPct = pct
      await turn($, w)
    }
    expect(quacks()).toBe(8)
    await ui.unmount()
  })

  test('a cloud agent counts as launched: it keeps nothing ticking and nothing running', () => {
    const call = { at: T0, id: 'a1', tool: 'Agent', input: { description: 'Port the API', subagent_type: 'general-purpose' } }
    let c: Cockpit = onToolStart(newCockpit(T0, 's'), call)
    expect(hasRunningAgents(c)).toBe(true)
    const launched = { status: 'remote_launched', taskId: 'task-1', sessionUrl: 'https://claude.ai/code/x', description: 'Port the API', prompt: 'port it', outputFile: '/tmp/x' }
    c = onToolEnd(c, { ...call, at: T0 + 2000, outcome: 'ok', text: 'Launched in the cloud', result: launched })
    expect(c.agents).toMatchObject([{ id: 'a1', status: 'remote' }])
    expect(hasRunningAgents(c)).toBe(false)
  })

  test('a failed check: the band says "Quack:" and one OS notification goes out', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    w.bash = () => ({ ok: false, stdout: 'Tests  1 failed | 3 passed (4)' })
    await start($, w)
    await turn($, w, { tools: [bash('pnpm test')] })
    expect(w.notified).toEqual([{ text: 'pnpm test', title: 'Quack: tests failed' }])
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: 'Quack:' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'tests failed' })).toBeDefined()
    // It quacked once: the head came up and the bill flapped, by blits, then it held still.
    await w.clock.advance(2000)
    expect(w.blits.filter(b => b.key === 'duck-g')).toHaveLength(4)
    await w.clock.advance(60_000)
    expect(w.blits.filter(b => b.key === 'duck-g')).toHaveLength(4)
    // Pressing it acknowledges, as a pilot presses the caution light.
    await ui.press({ key: 'duck-ack' })
    expect(await ui.find({ type: 'Text', text: 'Quack:' })).toBeUndefined()
    await ui.unmount()
  })

  test('"Quack" is quackpit\'s own word: the Korean band, notification and guide say it too', { options: { locale: 'ko' }, timeoutMs: LIMIT_MS }, async ($, on) => {
    const w = world(on, { now: T0 })
    w.bash = () => ({ ok: false, stdout: 'Tests  1 failed | 3 passed (4)' })
    await start($, w)
    await turn($, w, { tools: [bash('pnpm test')] })
    expect(w.notified).toEqual([{ text: 'pnpm test', title: 'Quack: 테스트 실패' }])
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: 'Quack:' })).toBeDefined()
    await ui.unmount()
    const guide = guideRows('ko').find(row => row.name === 'duck')?.text ?? ''
    expect(guide).toContain('Quack:')
    for (const key of ['duck.quack', 'guide.duck'] as const) expect(t('ko', key)).not.toContain('꽥')
  })

  test('OS notifications stop at 3 a day across sessions; the 4th is a toast', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    w.bash = () => ({ ok: false, stdout: 'Tests  1 failed (1)' })
    await start($, w)
    for (let i = 0; i < 4; i++) {
      await turn($, w, { tools: [bash('pnpm test')] })
      w.bash = () => ({ ok: true, stdout: 'Tests  1 passed (1)' })
      await turn($, w, { tools: [bash('pnpm test')] })
      w.bash = () => ({ ok: false, stdout: 'Tests  1 failed (1)' })
    }
    expect(w.notified).toHaveLength(NOTIFY_PER_DAY)
    expect(w.toasts.filter(text => text === 'Quack: tests failed')).toHaveLength(1)
    expect(w.store.get('notify')).toEqual({ day: '2026-10-11', count: 3 })
    // A new day has its own 3.
    expect(takeNotifySlot({ day: '2026-10-11', count: 3 }, '2026-10-12')).toEqual({ record: { day: '2026-10-12', count: 1 }, isTaken: true })
  })

  test('five_hour at 90% notifies; 80% only toasts; without $.ui.notify it falls back to a toast', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { fiveHour: 70, fiveResetsIn: 90 } })
    w.notify = 'throws'
    await start($, w)
    w.usage.fiveHour = 81
    await turn($, w)
    expect(w.toasts).toContain('Quack: 5h window at 81%')
    w.usage.fiveHour = 91
    await turn($, w)
    expect(w.notified).toEqual([])
    expect(w.toasts).toContain('Quack: 5h window at 91%')
    // The slot a failed notification took is given back.
    expect(w.store.get('notify')).toEqual({ day: '2026-10-11', count: 0 })
  })

  test('/quackpit duck off removes the duck and silences it; the gauges still turn red', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { ctxPct: 50 } })
    await start($, w)
    await command($, 'duck off')
    expect(w.toasts.at(-1)).toBe('The duck is off. Cautions still turn their gauges amber and red.')
    w.usage.ctxPct = 95
    await turn($, w)
    expect(w.toasts.filter(text => text.startsWith('Quack:'))).toEqual([])
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Raster', key: 'duck-g' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: '95%' }))?.props.color).toBe('error')
    await ui.unmount()
    await command($, 'duck on')
    const back = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await back.find({ type: 'Raster', key: 'duck-g' })).toBeDefined()
    await back.unmount()
  })

  test('the quack sound is off by default and plays when turned on', { options: { locale: 'en', sound: true }, timeoutMs: LIMIT_MS }, async ($, on) => {
    const w = world(on, { now: T0, usage: { ctxPct: 50 } })
    await start($, w)
    w.usage.ctxPct = 93
    await turn($, w)
    expect(w.played).toBe(1)
  })

  test('the idle duck never animates: no timer redraws it, no picture is swapped', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    // Let the one-time picture probe settle first: it is no animation.
    await w.clock.advance(2000)
    const before = JSON.stringify(await ui.drawn())
    await w.clock.advance(10 * MINUTE)
    expect(w.blits.filter(b => b.key.startsWith('duck'))).toEqual([])
    expect(JSON.stringify(await ui.drawn())).toBe(before)
    await ui.unmount()
  })

  test('the quadrant encoder draws each 2x2 cell as its mask, at most two colours, clear behind', () => {
    const Y = 0xffd23f
    const K = 0x2b1d18
    // Every mask of one colour on clear: its quadrant glyph, the colour over the terminal's own.
    for (let mask = 0; mask < 16; mask++) {
      const px = (bit: number) => (mask & bit ? Y : undefined)
      const [cell] = decode(quadrantCells([[px(1), px(2)], [px(4), px(8)]], 2).cells)
      expect(cell?.[0]).toBe(QUADRANTS[mask])
      if (mask !== 0) expect(cell?.slice(1)).toEqual([Y, DEFAULT_COLOR])
    }
    // Two colours: the one with fewer pixels drawn over the other (an eye in a face).
    expect(decode(quadrantCells([[Y, Y], [Y, K]], 2).cells)).toEqual([['▗', K, Y]])
    // A third colour gives way to the second: never more than two in a cell.
    const [three] = decode(quadrantCells([[Y, Y], [K, 0x00ff00]], 2).cells)
    expect(new Set(three?.slice(1)).size).toBe(2)
  })

  test('the duck: 12x4 in quadrants, 6 columns, two colours a cell, neither long nor round, the body the same in every frame', () => {
    const frames = Object.entries(DUCK_12x4)
    for (const [name, rows] of frames) {
      expect(rows.map(row => row.length), name).toEqual([12, 12, 12, 12])
      for (let cy = 0; cy < 2; cy++) {
        for (let cx = 0; cx < DUCK_COLUMNS; cx++) {
          const cell = [rows[cy * 2]?.[cx * 2], rows[cy * 2]?.[cx * 2 + 1], rows[cy * 2 + 1]?.[cx * 2], rows[cy * 2 + 1]?.[cx * 2 + 1]]
          expect(new Set(cell).size <= 2, `${name} cell ${cx},${cy}: ${cell.join('')}`).toBe(true)
        }
      }
      // The body (the two lower rows) never moves.
      expect(rows.slice(2)).toEqual(DUCK_12x4.idle.slice(2))
    }
    // A quadrant pixel is twice as tall as wide: 12x4 of them draw about 1.5 wide to 1 tall, between 16x4's 2 and 10x4's 1.25.
    expect(DUCK_COLUMNS).toBe(6)
    // An open eye is a plain dark mark with the head on every side of it, and face between it and the bill.
    for (const name of ['shut', 'alert'] as const) {
      const rows = DUCK_12x4[name]
      const y = rows.findIndex(row => row.includes('K'))
      const x = rows[y]?.indexOf('K') ?? -1
      expect([rows[y - 1]?.[x], rows[y + 1]?.[x], rows[y]?.[x + 1], rows[y]?.[x - 1]]).toEqual(['Y', 'Y', 'Y', 'Y'])
      expect(rows[y]?.[x + 2]).toBe('O')
    }
    // The 16x16 duck for pictures and SVG: square, its eye dark with no glint.
    for (const rows of Object.values(DUCK_16)) {
      expect(rows.map(row => row.length)).toEqual(Array.from({ length: 16 }, () => 16))
      expect(rows.join('')).not.toMatch(/[WP]/)
    }
  })

  test('the frames as the terminal draws them: asleep with a shut eye, alert with the bill open, shut, and the one-row duck', () => {
    const glyphs = (cells: string) => {
      const all = decode(cells).map(cell => cell[0])
      return [all.slice(0, 6).join(''), all.slice(6).join('')]
    }
    expect(glyphs(duckCells('idle', 2).cells)).toEqual(['▖  █-▄', '▀███▛ '])
    expect(glyphs(duckCells('alert', 2).cells)).toEqual(['▖  █▖█', '▀███▛ '])
    expect(glyphs(duckCells('shut', 2).cells)).toEqual(['▖  █▖▄', '▀███▛ '])
    // The shut eye: a dash of eye-dark over yellow. The open one: a quadrant of it.
    expect(decode(duckCells('idle', 2).cells)[4]).toEqual(['-', 0x2b1d18, 0xffd23f])
    expect(decode(duckCells('shut', 2).cells)[4]).toEqual(['▖', 0x2b1d18, 0xffd23f])
    // The bill closed, then open to the head's full height.
    expect(decode(duckCells('shut', 2).cells)[5]).toEqual(['▄', 0xff8a1f, DEFAULT_COLOR])
    expect(decode(duckCells('alert', 2).cells)[5]).toEqual(['█', 0xff8a1f, DEFAULT_COLOR])
    expect(decode(duckCells('idle', 1).cells).map(cell => cell[0]).join('')).toBe('▙▄█▄')
    // The quack: up, bill open and shut twice, then it holds shut, the pose a standing caution keeps.
    expect(QUACK_FRAMES).toEqual(['idle', 'alert', 'shut', 'alert', 'shut'])
    expect(STEADY).toEqual({ idle: 'idle', alert: 'shut' })
  })
})

/** Raster cells back to `[glyph, foreground, background]` triplets. */
