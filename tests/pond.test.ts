import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_COLOR } from '../src/cells'
import { newCockpit, onToolEnd, onToolStart, type Cockpit } from '../src/model'
import { bigPondCells, pixelsSvg, pondCells, pondPixels, POND_RGB } from '../src/pond'
import { DUCK_RGB } from '../src/sprites'
import { heroFace, readingsOf } from '../src/tiles'
import { plain } from '../src/text'
import { at, band, call, decode, EN, MINUTE, PANE, start, world } from './kit'

const T0 = at(2026, 10, 12, 9)
const view = (now: number) => ({ now, locale: 'en' as const, days: [], today: '2026-10-12' })
const glyphs = (cells: string) => decode(cells).map(cell => cell[0]).join('')

/** Claude's TodoWrite at `minutes` past T0, each item with its status. */
function todo(c: Cockpit, minutes: number, statuses: ('pending' | 'in_progress' | 'completed')[]): Cockpit {
  const callArgs = { at: T0 + minutes * MINUTE, id: `w${minutes}`, tool: 'TodoWrite', input: { todos: statuses.map((status, i) => ({ content: `Task ${i + 1}`, status, activeForm: `Doing ${i + 1}` })) } }
  return onToolEnd(onToolStart(c, callArgs), { ...callArgs, outcome: 'ok', text: 'ok', result: { oldTodos: [], newTodos: callArgs.input.todos } })
}

describe('the swimming duck', () => {
  test('the band pond: the duckling crosses from the first column to the checkered flag, the water behind it pale', () => {
    // 12 columns: the duckling's 4, the flag in the last, 7 to swim.
    expect(glyphs(pondCells(12, 0).cells)).toBe('▙▄█▄▄▄▄▄▄▄▄▞')
    expect(glyphs(pondCells(12, 1).cells)).toBe('▄▄▄▄▄▄▄▙▄█▄▞')
    const start = decode(pondCells(12, 0).cells)
    expect(start[4]).toEqual(['▄', POND_RGB.water, DEFAULT_COLOR])
    expect(start[11]).toEqual(['▞', POND_RGB.flagDark, POND_RGB.flagLight])
    const end = decode(pondCells(12, 1).cells)
    expect(end[0]).toEqual(['▄', POND_RGB.wake, DEFAULT_COLOR])
    expect(end[8]).toEqual(['▄', DUCK_RGB.Y, DEFAULT_COLOR])
    // Halfway: crossed water before the duckling, still water after it.
    const half = decode(pondCells(12, 0.5).cells)
    expect(half.slice(0, 4).map(cell => cell[1])).toEqual([POND_RGB.wake, POND_RGB.wake, POND_RGB.wake, POND_RGB.wake])
    expect(half[9]?.[1]).toBe(POND_RGB.water)
    // Out of range or not a number: the nearest shore.
    expect(pondCells(12, -3).cells).toBe(pondCells(12, 0).cells)
    expect(pondCells(12, 7).cells).toBe(pondCells(12, 1).cells)
    expect(pondCells(12, Number.NaN).cells).toBe(pondCells(12, 0).cells)
  })

  test("the pane's pond: water on the bottom line from the work's start, the duck on it eye open, the flag on its pole", () => {
    const cells = decode(bigPondCells(20, 0.5, 2).cells)
    const top = cells.slice(0, 20)
    const bottom = cells.slice(20)
    // Before the work began: nothing.
    expect(top.slice(0, 2).map(cell => cell[0]).join('')).toBe('  ')
    expect(bottom.slice(0, 2).map(cell => cell[0]).join('')).toBe('  ')
    // The duck (6 columns) halfway across the 18 from the start: its eye, open, a quadrant of eye-dark.
    expect(top.some(cell => cell[0] === '▖' && cell[1] === DUCK_RGB.K)).toBe(true)
    expect(bottom[2]).toEqual(['▄', POND_RGB.wake, DEFAULT_COLOR])
    expect(bottom[18]).toEqual(['▄', POND_RGB.water, DEFAULT_COLOR])
    expect(top[19]).toEqual(['▞', POND_RGB.flagDark, POND_RGB.flagLight])
    expect(bottom[19]).toEqual(['▌', POND_RGB.flagDark, DEFAULT_COLOR])
  })

  test('as SVG for the desktop: the same pixels, one rect a run, stretched to the cells', () => {
    const svg = pixelsSvg(pondPixels(8, 0), 64, 18)
    expect(svg).toMatch(/^<svg [^>]*width="64" height="18" viewBox="0 0 16 2" preserveAspectRatio="none"/)
    expect(svg).toContain(`fill="#${POND_RGB.water.toString(16)}"`)
    expect(svg).toContain(`fill="#${DUCK_RGB.O?.toString(16)}"`)
  })

  test("the hero's pond: the time of the whole once anything has a pace, the tasks done before, the far shore when done", () => {
    let c = todo(newCockpit(T0, 's'), 0, ['in_progress', 'pending', 'pending', 'pending'])
    c = todo(c, 4, ['completed', 'in_progress', 'pending', 'pending'])
    // One task done: no pace yet, so the duckling has crossed a quarter, by the tasks.
    const early = heroFace(readingsOf(c, view(T0 + 5 * MINUTE)), 48)
    expect(early.pond).toMatchObject({ fraction: 0.25, tail: [] })
    c = todo(c, 10, ['completed', 'completed', 'in_progress', 'pending'])
    // Two done (4m, 6m): 5 minutes a task; the third ends at 15, the fourth at 20; 12 of 20 minutes gone.
    const mid = heroFace(readingsOf(c, view(T0 + 12 * MINUTE)), 48)
    expect(mid.pond?.fraction).toBe(0.6)
    expect(plain(mid.pond?.tail ?? [])).toBe(' ~8m left')
    expect(mid.width).toBe(early.width)
    // Too narrow a tile for 8 columns of pond beside its words keeps the text meter.
    expect(heroFace(readingsOf(c, view(T0 + 12 * MINUTE)), 16).pond).toBeUndefined()
    c = todo(c, 21, ['completed', 'completed', 'completed', 'completed'])
    expect(heroFace(readingsOf(c, view(T0 + 21 * MINUTE)), 48).pond).toMatchObject({ fraction: 1, tail: [] })
  })

  test('with no list, subagents of a known length still get a crossing', () => {
    const launch = (c: Cockpit, id: string, from: number, to?: number) => {
      const callArgs = { at: T0 + from * MINUTE, id, tool: 'Agent', input: { subagent_type: 'Explore', description: 'Map it', prompt: 'go' } }
      const started = onToolStart(c, callArgs)
      if (to === undefined) return started
      const result = { status: 'completed', agentId: `a-${id}`, totalDurationMs: (to - from) * MINUTE, totalTokens: 10, totalToolUseCount: 1, content: [], usage: {}, prompt: '' }
      return onToolEnd(started, { ...callArgs, at: T0 + to * MINUTE, outcome: 'ok', text: 'done', result })
    }
    let c = launch(newCockpit(T0, 's'), 'a', 0, 4)
    c = launch(c, 'b', 4, 8)
    c = launch(c, 'c', 10)
    const hero = heroFace(readingsOf(c, view(T0 + 12 * MINUTE)), 48)
    expect(hero.pond?.fraction).toBe(0.5)
    expect(plain(hero.lines[1])).toMatch(/ ~2m left$/)
  })

  test('drawn in the band and the pane: a Raster pond in the terminal, an SVG on the desktop', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    const write = (statuses: ('pending' | 'in_progress' | 'completed')[]) => call($, w, { tool: 'TodoWrite', todos: statuses.map((status, i) => ({ content: `Task ${i + 1}`, status, activeForm: `Doing ${i + 1}` })) } as never)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await write(['in_progress', 'pending', 'pending'])
    await w.clock.advance(3 * MINUTE)
    await write(['completed', 'in_progress', 'pending'])
    await w.clock.advance(3 * MINUTE)
    await write(['completed', 'completed', 'in_progress'])
    await w.clock.advance(MINUTE)
    const bandUi = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await bandUi.find({ type: 'Raster', key: 'progress-pond' })).toBeDefined()
    expect(await bandUi.find({ type: 'Text', text: / ~\dm left/ })).toBeDefined()
    await bandUi.unmount()
    let pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    // On top of the pane the duck swims across its whole width, the time left beside it, once.
    expect(await pane.find({ type: 'Raster', key: 'top-pond' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^~\dm left$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^done ~\d\d:\d\d$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'ETA    ' })).toBeUndefined()
    await pane.press({ key: 'pane-view-turns' })
    await pane.unmount()
    // While the first turn runs there are no turns yet to list.
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: 'TURNS' })).toBeDefined()
    await pane.unmount()
    const desk = await $.ui.mount({ plugin: 'quackpit', surface: 'desktop', ...band() })
    expect(JSON.stringify(await desk.drawn())).toMatch(/"alt":"duck \d+% across"/)
    await desk.unmount()
  })
})
