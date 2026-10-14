import { describe, expect, test } from 'claude-code/testing'

import { hudTiles, layerHud, parseHudConfig } from '../src/hud'
import { at, band, EN, start, world } from './kit'

const T0 = at(2026, 10, 11, 10)
const SHARED = '/home/test/.claude/plugins/claude-hud/config.json'
const LOCAL = '/home/test/.claude/claude-hud.json'

describe('claude-hud', () => {
  test("claude-hud's enabled lines map to tiles: todos, usage, tools, agents, git", () => {
    expect(hudTiles({})).toEqual(['progress', 'pace', 'context', 'limits', 'session'])
    const all = { display: { showTodos: true, showTools: true, showAgents: true, showCost: true, showUsage: true }, gitStatus: { enabled: true } }
    expect(hudTiles(all)).toEqual(['progress', 'pace', 'context', 'limits', 'checks', 'cost', 'agents', 'files', 'session'])
    expect(hudTiles({ display: { showUsage: false }, gitStatus: { enabled: false } })).toEqual(['progress', 'context'])
    // The per-directory file is layered over the shared one, as claude-hud does.
    const merged = layerHud(parseHudConfig('{"display":{"showTools":true,"showAgents":true}}'), parseHudConfig('{"display":{"showAgents":false}}'))
    expect(merged).toEqual({ display: { showTools: true, showAgents: false } })
    expect(parseHudConfig('not json')).toBeUndefined()
  })

  test('first run: a claude-hud config becomes the layout, said once in a toast; the files are never written', EN, async ($, on) => {
    const w = world(on, { now: T0, files: { [SHARED]: JSON.stringify({ display: { showTools: true, showAgents: true, showTodos: true } }) } })
    await start($, w)
    expect(w.toasts.filter(text => text.startsWith('quackpit: mapped your claude-hud lines'))).toHaveLength(1)
    expect(w.store.get('layout')).toMatchObject({ source: 'claude-hud', tiles: ['progress', 'pace', 'context', 'limits', 'checks', 'agents', 'files', 'session'] })
    expect(w.written).toEqual([])
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band(220, 8) })
    expect(await ui.find({ type: 'Button', key: 'tile-agents' })).toBeDefined()
    await ui.unmount()
    // The next session does not ask again.
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await w.clock.settle()
    expect(w.toasts.filter(text => text.startsWith('quackpit: mapped'))).toHaveLength(1)
  })

  test('without claude-hud the defaults stand and nothing is said', EN, async ($, on) => {
    const w = world(on, { now: T0, files: { [LOCAL]: '{oops' } })
    await start($, w)
    expect(w.toasts).toEqual([])
    expect(w.store.get('layout')).toBeUndefined()
    expect(w.store.get('hud')).toMatchObject({ checkedAt: T0 })
  })
})
