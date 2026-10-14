import { describe, expect, test } from 'claude-code/testing'

import { cacheClock, forcedTtl, ttlOf } from '../src/cache'
import { formatUsd } from '../src/format'
import { newCockpit, onStep, onTurnEnd, onTurnStart, type Cockpit } from '../src/model'
import { availableTiles, readingsOf, tileFace } from '../src/tiles'
import { timeSection } from '../src/timeline'
import { plain } from '../src/text'
import { at, band, bash, command, EN, LIMIT_MS, MINUTE, PANE, start, turn, world } from './kit'

const T0 = at(2026, 10, 11, 10)

/** One turn whose last response went out at `T0 + 1 min` with a 490k prompt. */
function afterTurn(): Cockpit {
  let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
  c = onStep(c, { at: T0 + 90_000, startedAt: T0 + MINUTE, turnId: 't', usage: { input_tokens: 3, output_tokens: 900, cache_read_input_tokens: 486_000, cache_creation_input_tokens: 4000 } })
  return onTurnEnd(c, { at: T0 + 2 * MINUTE, turnId: 't', tokens: 4903, durationMs: 2 * MINUTE, isAborted: false })
}

describe('the smaller things', () => {
  test('a cost under a tenth of a cent reads as under $0.001, never as $0.000', () => {
    expect([formatUsd(0), formatUsd(0.0004), formatUsd(0.0042), formatUsd(0.41), formatUsd(85.2)]).toEqual(['$0', '<$0.001', '$0.004', '$0.41', '$85.2'])
  })

  test('the health tile judges from what quackpit measured, and with nothing to judge yet says so', () => {
    const r = readingsOf(newCockpit(T0, 's'), { now: T0, locale: 'en', days: [], today: '2026-10-11' })
    expect(plain(tileFace(r, 'health').lines[0])).toBe('—')
    expect(plain(tileFace(r, 'health').lines[1])).toBe('health · nothing to judge yet')
    const read = readingsOf({ ...newCockpit(T0, 's'), reading: { at: T0, contextPct: 20, contextTokens: 40_000, contextWindow: 200_000 } }, { now: T0, locale: 'en', days: [], today: '2026-10-11' })
    expect(tileFace(read, 'health').lines.map(plain)).toEqual(['100 smooth', 'health · all parts clear'])
  })

  test('streak is no tile any more and health is one: a saved layout drops the one and draws the other; /quackpit add names the tiles', EN, async ($, on) => {
    // A layout saved by an older build, holding both of its placeholders.
    const settingsBase = { tiles: 'progress,pace,context,limits,checks,cost', rows: 2, duck: true }
    const layout = { v: 1, tiles: ['progress', 'health', 'pace', 'streak', 'cost'], base: settingsBase, source: 'command' }
    const w = world(on, { now: T0, store: { layout } })
    await start($, w)
    await turn($, w, { prompt: 'Fix the parser' })
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Button', key: 'tile-pace' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tile-health' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tile-streak' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /arrives in a later version/ })).toBeUndefined()
    await ui.unmount()
    await command($, 'add streak')
    expect(w.toasts.at(-1)).toBe('No tile called "streak". Tiles: progress, pace, context, limits, checks, cost, agents, files, session, health.')
    expect(availableTiles()).toEqual(['progress', 'pace', 'context', 'limits', 'checks', 'cost', 'agents', 'files', 'session', 'health'])
  })

  test("Claude Code's turn line carries the turn's receipt: its tokens, cost and checks", EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { costUsd: 1 } })
    w.bash = () => ({ ok: true, stdout: 'Tests  6 passed (6)' })
    await start($, w)
    await turn($, w, { tokens: 48_000, costUsd: 0.41, minutes: 1, tools: [bash('pnpm test')] })
    const line = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', component: 'TurnDuration', requestId: 'm1', props: { word: 'Baked', durationMs: MINUTE } })
    expect(await line.find({ type: 'Text', text: '  48k tokens · $0.41 · tests ✓' })).toBeDefined()
    // The engine's own words stay first, the receipt on a line of its own beneath them.
    expect(await line.drawn()).toMatchObject({ type: 'Box', props: { flexDirection: 'column' }, children: [{ type: 'engine', ref: 0 }, { type: 'Text' }] })
    await line.unmount()
    // A line that matches no turn quackpit saw is left as the engine drew it.
    const other = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', component: 'TurnDuration', requestId: 'm0', props: { word: 'Baked', durationMs: 4321 } })
    expect(await other.drawn()).toEqual({ type: 'engine', ref: 0 })
    await other.unmount()
  })

  test('the prompt cache: warm while a turn runs, then minutes left, then what the next prompt rewrites', () => {
    const c = afterTurn()
    expect(cacheClock(onTurnStart(c, { at: T0 + 3 * MINUTE, turnId: 'u', text: 'go' }), T0 + 3 * MINUTE, '1h')).toEqual({ state: 'turn', ttl: '1h' })
    // The lifetime counts from the start of the request that last read or wrote it.
    expect(cacheClock(c, T0 + 11 * MINUTE, '1h')).toEqual({ state: 'warm', ttl: '1h', left: 50 * MINUTE })
    expect(cacheClock(c, T0 + 7 * MINUTE, '5m')).toEqual({ state: 'cold', ttl: '5m', rewrite: 490_003 })
    expect(timeSection(c, T0 + 7 * MINUTE, 'en', 100, '5m').map(plain)[1]).toBe('CACHE  cold: the next prompt rewrites ~490k')
    expect(timeSection(c, T0 + 11 * MINUTE, 'en', 100, '1h').map(plain)[1]).toBe('CACHE  warm: 50m left (1h cache)')
  })

  test("the cache's lifetime is decided as Claude Code decides it: env, then the setting, then the account", () => {
    expect(forcedTtl({ force5m: '1', ttlVar: '1h', setting: '1h', enable1h: '1' })).toBe('5m')
    expect(forcedTtl({ ttlVar: '1h', setting: '5m' })).toBe('1h')
    expect(forcedTtl({ setting: '5m', enable1h: 'true' })).toBe('5m')
    expect(forcedTtl({ enable1h: 'true' })).toBe('1h')
    expect(forcedTtl({})).toBeUndefined()
    const reading = (pct: number) => ({ at: T0, fiveHour: { pct }, sevenDay: { pct: 20 } })
    // A subscription within its plan: an hour. Out of plan (credits) or no plan windows at all: 5 minutes.
    expect(ttlOf(undefined, reading(40))).toBe('1h')
    expect(ttlOf(undefined, reading(100))).toBe('5m')
    expect(ttlOf(undefined, { at: T0 })).toBe('5m')
    expect(ttlOf('5m', reading(40))).toBe('5m')
  })

  test('/config refuses a tile that does not exist and names the ones that do', { options: { locale: 'en' }, timeoutMs: LIMIT_MS }, async ($, on) => {
    // Beneath the plugin the kit writes a row as asked (config.set); the menu's own description comes back as given.
    on('config.describe', ($2, e) => ({ label: e.label, isHidden: e.isHidden, ...(e.description !== undefined ? { description: e.description } : {}) }))
    const w = world(on, { now: T0 })
    await start($, w)
    // The row as the /config menu changes it: the person, at the menu.
    const row = (value: string) => ({ key: 'quackpit.tiles', value, previous: 'progress,pace,context,limits,checks,cost', provider: { plugin: 'quackpit', tier: 'user' as const }, origin: { kind: 'composer' as const } })
    const refused = await $.config.set(row('progress, weather,pace'))
    expect(refused.deny).toBe('No tile called "weather". Tiles: progress, pace, context, limits, checks, cost, agents, files, session, health.')
    // The older build's placeholder is no tile; health is one.
    expect((await $.config.set(row('progress,streak'))).deny).toBe('No tile called "streak". Tiles: progress, pace, context, limits, checks, cost, agents, files, session, health.')
    expect((await $.config.set(row('progress,health'))).value).toBe('progress,health')
    expect((await $.config.set(row('progress,files'))).value).toBe('progress,files')
    const described = await $.config.describe({ key: 'quackpit.tiles', label: 'Tiles', description: 'old words', isHidden: false, provider: { plugin: 'quackpit', tier: 'user' } })
    expect(described.description).toContain('Tiles: progress, pace, context, limits, checks, cost, agents, files, session, health.')
  })

  test('the first run says once where the pane is', { options: { locale: 'en' }, timeoutMs: LIMIT_MS }, async ($, on) => {
    const w = world(on, { now: T0, store: { welcomed: undefined } })
    await start($, w)
    expect(w.toasts).toEqual(['quackpit is above the prompt: /quackpit opens its pane (so does a click on any gauge), and /quackpit help explains each gauge.'])
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await w.clock.settle()
    expect(w.toasts).toHaveLength(1)
    expect(w.store.get('welcomed')).toBe(T0)
  })
})
