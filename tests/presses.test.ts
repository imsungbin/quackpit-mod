import { describe, expect, test, type Engine } from 'claude-code/testing'

import { parseCommand } from '../src/commands'
import { endNarrow, plain } from '../src/text'
import { barWidth, DEFAULT_VIEW, viewBar } from '../src/views'
import { at, band, command, EN, MINUTE, PANE, start, turn, world } from './kit'

const T0 = at(2026, 10, 13, 15)

/** The pane at a width: 80 columns drills in place, 110 beside the list of instruments. */
const paneAt = (bodyColumns: number) => ({ ...PANE, props: { ...PANE.props, bodyColumns } })

/** The pane's button keyed `key`, if drawn. */
async function paneButton($: Engine, key: string, bodyColumns = 80) {
  const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...paneAt(bodyColumns) })
  const found = await pane.find({ type: 'Button', key })
  await pane.unmount()
  return found
}

describe('the pane: its views, instruments and details', () => {
  test("an instrument pressed drills into its detail in the overview's place, under a back press keyed b; back returns; beside the list of instruments where the pane is wide", EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { ctxTokens: 30_000, ctxPct: 15 } })
    await start($, w)
    await turn($, w, { prompt: 'Fix the parser' })
    let pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...paneAt(80) })
    expect(await pane.find({ type: 'Button', key: 'pane-back' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '▸ ' })).toBeDefined()
    await pane.press({ key: 'cell-context' })
    await pane.unmount()
    expect(w.store.get('pane')).toEqual({ view: 'overview', detail: 'context' })
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...paneAt(80) })
    // The detail stands in the overview's place: its back press (b), its name marked open, its lines; no instruments.
    expect((await pane.find({ type: 'Button', key: 'pane-back' }))?.props).toMatchObject({ plain: true, hotkey: 'b' })
    expect(await pane.find({ type: 'Text', text: '▾ ' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^each turn as it ended, against/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'cell-health' })).toBeUndefined()
    await pane.press({ key: 'pane-back' })
    await pane.unmount()
    expect(w.store.get('pane')).toEqual({ view: 'overview' })
    expect(await paneButton($, 'pane-back')).toBeUndefined()
    // Wide, the detail sits beside the instruments, a line each, the open one marked; another press switches.
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...paneAt(110) })
    await pane.press({ key: 'cell-health' })
    await pane.unmount()
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...paneAt(110) })
    expect(await pane.find({ type: 'Text', text: /^A judgement, not a measurement: 100 less what each part/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'cell-pace' })).toBeDefined()
    await pane.press({ key: 'cell-pace' })
    await pane.unmount()
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...paneAt(110) })
    expect(await pane.find({ type: 'Text', text: /^now: new tokens at the last few minutes' pace/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^A judgement/ })).toBeUndefined()
    await pane.unmount()
  })

  test("a tile pressed in the band opens the pane on that tile's detail; the hero's opens the timeline", EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { ctxTokens: 30_000, ctxPct: 15 } })
    await start($, w)
    await turn($, w, { prompt: 'Fix the parser' })
    await command($, 'view turns')
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    await ui.press({ key: 'tile-checks' })
    expect(w.opened.at(-1)?.id).toBe('quackpit')
    expect(w.store.get('pane')).toEqual({ view: 'overview', detail: 'checks' })
    await ui.press({ key: 'tile-limits' })
    expect(w.store.get('pane')).toEqual({ view: 'overview', detail: 'limits' })
    await ui.press({ key: 'tile-progress' })
    expect(w.store.get('pane')).toEqual({ view: 'timeline' })
    await ui.press({ key: 'tile-limits' })
    await ui.unmount()
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...paneAt(80) })
    expect(await pane.find({ type: 'Text', text: /^no plan reading yet/ })).toBeDefined()
    await pane.unmount()
  })

  test('the views: a press each, digits 1 to 6 as their keys, the open one bold where the focus ring starts, one line at 56 columns in every language', EN, async ($, on) => {
    for (const L of ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant'] as const) {
      const bar = viewBar(L, 'overview', 56)
      expect(barWidth(bar), L).toBeLessThanOrEqual(56)
      expect(bar.tabs.map(tab => tab.hotkey)).toEqual(['1', '2', '3', '4', '5', '6'])
    }
    expect(viewBar('en', 'turns', 80).tabs.map(tab => tab.label)).toEqual(['overview', 'timeline', 'turns', 'band', 'handover', 'guide'])
    // At 56 columns the short names: they fit, and the open one is still bold over the heavy rule.
    expect(viewBar('en', 'turns', 56).tabs.map(tab => tab.label)).toEqual(['gauges', 'time', 'turns', 'band', 'handoff', 'help'])
    expect(viewBar('ko', 'turns', 80).tabs.map(tab => tab.label)).toEqual(['개요 ', '타임라인 ', '턴 ', '밴드 ', '인수인계 ', '안내 '])
    // The rule under the bar is heavy under the open view alone: `1: overview  2: timeline  ` come first.
    expect(plain(viewBar('en', 'turns', 80).rule)).toBe(`${'─'.repeat(26)}${'━'.repeat(8)}${'─'.repeat(46)}`)
    // A press whose label ends on a wide character carries a narrow space, so a focus ring never ends on one
    // (Warp leaves its second half unlit); a Korean cell title ends on a space too.
    expect([endNarrow('▸ 컨텍스트'), endNarrow('▸ CONTEXT')]).toEqual(['▸ 컨텍스트 ', '▸ CONTEXT'])
    const w = world(on, { now: T0 })
    await start($, w)
    await turn($, w, { prompt: 'Fix the parser' })
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...paneAt(80) })
    expect((await pane.find({ type: 'Button', key: 'pane-view-overview' }))?.props).toMatchObject({ plain: true, hotkey: '1', autoFocus: true })
    expect((await pane.find({ type: 'Button', key: 'pane-view-band' }))?.props).toMatchObject({ plain: true, hotkey: '4', dimColor: true })
    await pane.press({ key: 'pane-view-band' })
    expect(w.store.get('pane')).toEqual({ view: 'band' })
    await pane.unmount()
    expect(await paneButton($, 'pane-add-health')).toBeDefined()
  })

  test('/quackpit view <name or number> and the views by name bring them up; /quackpit <tile> drills into its detail; help opens the guide; handover its view', EN, async ($, on) => {
    expect([parseCommand('view 3'), parseCommand('tab handover'), parseCommand('turns'), parseCommand('overview'), parseCommand('view'), parseCommand('view 9')]).toEqual([
      { kind: 'view', view: 'turns' },
      { kind: 'view', view: 'handover' },
      { kind: 'view', view: 'turns' },
      { kind: 'view', view: 'overview' },
      { kind: 'view' },
      { kind: 'view' },
    ])
    expect([parseCommand('health'), parseCommand('limits'), parseCommand('handover'), parseCommand('weather')]).toEqual([{ kind: 'detail', tile: 'health' }, { kind: 'detail', tile: 'limits' }, { kind: 'handover' }, { kind: 'help' }])
    const w = world(on, { now: T0 })
    await start($, w)
    await command($, 'view')
    expect(w.toasts.at(-1)).toBe('Views: 1 overview · 2 timeline · 3 turns · 4 band · 5 handover · 6 guide. /quackpit view <name or number> opens one.')
    await command($, 'view 5')
    expect(w.store.get('pane')).toEqual({ view: 'handover' })
    expect(w.opened.at(-1)?.id).toBe('quackpit')
    await command($, 'session')
    expect(w.store.get('pane')).toEqual({ view: 'overview', detail: 'session' })
    await command($, 'help')
    expect(w.store.get('pane')).toEqual({ view: 'guide' })
    await command($, 'band')
    await command($, 'handover')
    expect(w.store.get('pane')).toEqual({ view: 'handover' })
    expect(w.written).toHaveLength(1)
  })

  test('the view in front and the detail are kept: through a redraw, a reload and /clear, and the next session opens on them; an older tab opens the overview', EN, async ($, on) => {
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
    const w = world(on, { now: T0, usage: { ctxTokens: 30_000, ctxPct: 15 } })
    await start($, w)
    await turn($, w, { prompt: 'Fix the parser' })
    await command($, 'view turns')
    await command($, 'cost')
    // A reload: session.start again, the state as it was.
    await start($, w)
    expect(await paneButton($, 'pane-back')).toBeDefined()
    expect(await paneButton($, 'pane-view-overview').then(b => b?.props.autoFocus)).toBe(true)
    // /clear: the session's state starts afresh; the store gives the view back.
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    fresh = true
    w.sid = 'session-2'
    w.messages = [{ role: 'user', text: '<command-name>/clear</command-name>', toolUses: [] }]
    await turn($, w, { prompt: 'Now the signup form' })
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...paneAt(80) })
    expect((await pane.find({ type: 'Button', key: 'pane-view-overview' }))?.props.autoFocus).toBe(true)
    expect(await pane.find({ type: 'Button', key: 'pane-back' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^session [—$]/ })).toBeDefined()
    await pane.unmount()
    expect(DEFAULT_VIEW).toEqual({ view: 'overview' })
    // An older build kept a tab and a detail under the grid: the pane opens on the overview.
    w.store.set('pane', { tab: 'turns', detail: 'cost' })
    await start($, w)
    fresh = false
    await $.session.end({ reason: 'clear', sessionId: 'session-2', resume: { id: 'session-2' } })
    fresh = true
    held.clear()
    w.sid = 'session-3'
    await turn($, w, { prompt: 'And the login page' })
    expect(await paneButton($, 'pane-view-overview').then(b => b?.props.autoFocus)).toBe(true)
    expect(await paneButton($, 'pane-back')).toBeUndefined()
  })

  test('on top: during a list the big count, the pond and the time left; a turn with nothing to estimate in a line or two; between turns, a line', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await turn($, w, { prompt: 'Fix the parser', minutes: 2 })
    let pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: /^ · last turn 2m · 0 tools · just now$/ })).toBeDefined()
    expect(await pane.find({ type: 'Raster', key: 'top-pond' })).toBeUndefined()
    await pane.unmount()
    await $.turn.start({ text: 'go on', turnId: 'live' })
    const write = (statuses: ('pending' | 'in_progress' | 'completed')[]) => $.tool.call({ tool: 'TodoWrite', todos: statuses.map((status, i) => ({ content: `Task ${i + 1}`, status, activeForm: `Doing ${i + 1}` })) } as never)
    await write(['in_progress', 'pending', 'pending', 'pending'])
    await w.clock.advance(2 * MINUTE)
    await write(['completed', 'in_progress', 'pending', 'pending'])
    await w.clock.advance(2 * MINUTE)
    await write(['completed', 'completed', 'in_progress', 'pending'])
    await w.clock.advance(MINUTE)
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Raster', key: 'top-pond' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Task 3' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^turn 2 · 3 tools$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '~3m left' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: "2 open, ~2m each · at this list's pace" })).toBeDefined()
    // The top's words come before the instruments'.
    const drawn = JSON.stringify(await pane.drawn())
    expect(drawn.indexOf('~3m left')).toBeLessThan(drawn.indexOf('PACE'))
    await pane.unmount()
    // Outside the overview the progress is one line under the bar, the band's one-row pond in it.
    await command($, 'view timeline')
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Raster', key: 'summary-pond' })).toBeDefined()
    expect(await pane.find({ type: 'Raster', key: 'top-pond' })).toBeUndefined()
    await pane.unmount()
  })

  test('a detail asked for shows even before its instrument joins the overview: the agents tile pressed before any subagent ran says so', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await command($, 'add agents')
    await turn($, w, { prompt: 'Fix the parser' })
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band(220) })
    await ui.press({ key: 'tile-agents' })
    await ui.unmount()
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Button', key: 'cell-agents' })).toBeUndefined()
    expect(await pane.find({ type: 'Button', key: 'pane-back' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'none running' })).toBeDefined()
    await pane.unmount()
  })
})
