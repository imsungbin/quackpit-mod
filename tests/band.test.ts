import type { Register } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { sharedRows } from '../src/layout'
import { at, band, EN, LIMIT_MS, start, world } from './kit'

const T0 = at(2026, 10, 11, 10)

/**
 * Another mod's one-row band, asked after quackpit (as token-detox is when
 * quackpit is asked first). It runs in an environment of its own, so it says
 * each draw in the log rather than in a variable of the test's.
 */
const otherBand: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    $.ui.log('other band drawn', { to: 'debug' })
    return $.ui.resolve(e).Text({ children: 'the other band' })
  })
}

const WITH_OTHER = { options: { locale: 'en' }, timeoutMs: LIMIT_MS, plugins: [{ name: 'other-band', tier: 'append' as const, register: otherBand }] }

const drawsOfOther = (logs: readonly string[]) => logs.filter(line => line === 'other band drawn').length

describe('sharing the band', () => {
  test('the band beneath is drawn, quackpit asks for it once, and its rows sit nearest the prompt', WITH_OTHER, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    const before = drawsOfOther(w.logs)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band(150, 8) })
    expect(drawsOfOther(w.logs) - before).toBe(1)
    const drawn = (await ui.drawn()) as { type: string; children?: { type: string; children?: unknown[] }[] }
    expect(drawn.type).toBe('Box')
    // First the band beneath, then quackpit's, nearest the prompt.
    expect(drawn.children?.[0]).toMatchObject({ type: 'Text', children: ['the other band'] })
    expect(await ui.find({ type: 'Button', key: 'tile-pace' })).toBeDefined()
    await ui.unmount()
  })

  test("quackpit's own failure leaves the band beneath, asked once", WITH_OTHER, async ($, on) => {
    let broken = false
    // What quackpit reads back is malformed (a day that is no record), so its drawing throws.
    const malformed = { layout: { tiles: ['progress', 'pace'], rows: 2, duck: true }, days: [null] }
    on('state.get', ($2, e, next) => {
      if (broken && e.plugin === 'quackpit' && e.key === 'ui') return { value: { value: malformed as never, version: 1 } }
      return next(e)
    })
    const w = world(on, { now: T0 })
    await start($, w)
    broken = true
    const before = drawsOfOther(w.logs)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band(150, 8) })
    expect(drawsOfOther(w.logs) - before).toBe(1)
    expect(await ui.drawn()).toMatchObject({ type: 'Text', children: ['the other band'] })
    expect(await ui.find({ type: 'Button', key: 'tile-pace' })).toBeUndefined()
    expect(w.logs.some(line => line.startsWith('quackpit band:'))).toBe(true)
    await ui.unmount()
  })

  test('beside another band quackpit keeps within the rows: the grid from 6, the dense row below, nothing under 2', WITH_OTHER, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    const roomy = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band(150, 6) })
    expect(await roomy.find({ type: 'Button', key: 'tile-pace' })).toBeDefined()
    await roomy.unmount()
    const tight = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band(150, 5) })
    expect(await tight.find({ type: 'Button', key: 'band-dense' })).toBeDefined()
    expect(await tight.find({ type: 'Button', key: 'tile-pace' })).toBeUndefined()
    await tight.unmount()
    const none = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band(150, 1) })
    expect(await none.drawn()).toMatchObject({ type: 'Text', children: ['the other band'] })
    await none.unmount()
    // The budget: what the person allows, while 4 rows stay for the band beneath.
    expect([sharedRows(2, 6), sharedRows(4, 7), sharedRows(4, 9), sharedRows(1, 9), sharedRows(2, 5), sharedRows(4, 2), sharedRows(2, 1)]).toEqual([2, 3, 4, 1, 1, 1, 0])
  })

  test('alone, with nothing beneath, quackpit draws its band as before', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band(150, 6) })
    const drawn = (await ui.drawn()) as { children?: { type: string }[] }
    // No engine element in it: the empty band beneath is left out.
    expect(JSON.stringify(drawn)).not.toContain('"engine"')
    expect(await ui.find({ type: 'Button', key: 'tile-pace' })).toBeDefined()
    await ui.unmount()
  })
})
