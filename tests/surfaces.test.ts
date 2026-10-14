import { describe, expect, test } from 'claude-code/testing'

import { buildHandover } from '../src/handover'
import { newCockpit } from '../src/model'
import { addToDay, loadDays, rollUp, type KV } from '../src/store'
import { quackWav } from '../src/sound'
import { at, band, bash, command, EN, MINUTE, PANE, start, todo, turn, world } from './kit'

const T0 = at(2026, 10, 11, 10)

describe('surfaces', () => {
  test('the terminal draws text gauges and a pixel duck; the desktop draws SVG', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { ctxPct: 40, fiveHour: 20, sevenDay: 5 } })
    await start($, w)
    await turn($, w, { tools: [todo([['One', 'completed'], ['Two', 'in_progress']])] })
    const term = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await term.find({ type: 'Raster', key: 'duck-g' })).toBeDefined()
    expect(await term.find({ type: 'Svg' })).toBeUndefined()
    expect(await term.find({ type: 'Text', text: '40%' })).toBeDefined()
    await term.unmount()
    const desk = await $.ui.mount({ plugin: 'quackpit', surface: 'desktop', ...band() })
    expect(await desk.find({ type: 'Raster' })).toBeUndefined()
    const svgs = await desk.findAll({ type: 'Svg' })
    expect(svgs.length).toBeGreaterThanOrEqual(4)
    expect(String(svgs[0]?.props.source)).toStartWith('<svg')
    expect(await desk.find({ type: 'Button', key: 'tile-pace' })).toBeDefined()
    await desk.unmount()
  })

  test('where the terminal shows pictures (the probe blit is taken) the gauges become kitty images', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    w.pictures = 'shown'
    await start($, w)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Image', key: 'qp-probe' })).toBeDefined()
    await w.clock.advance(1000)
    expect(w.blits.map(b => b.key)).toContain('qp-probe')
    expect(await ui.find({ type: 'Image', key: 'pace-g' })).toBeDefined()
    expect(await ui.find({ type: 'Image', key: 'duck-g' })).toBeDefined()
    expect(await ui.find({ type: 'Image', key: 'qp-probe' })).toBeUndefined()
    await ui.unmount()
  })

  test('the pane draws its instruments and each view, the turns and the handover among them, on every surface', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    for (let i = 0; i < 3; i++) await turn($, w, { prompt: `step ${i}`, tokens: 1000 * (i + 1) })
    await command($, '')
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      let pane = await $.ui.mount({ plugin: 'quackpit', surface, ...PANE })
      // Tiles not in the band are there at full size: health, which judges from the first reading, and the session.
      expect(await pane.find({ type: 'Text', text: 'HEALTH' }), surface).toBeDefined()
      expect(await pane.find({ type: 'Text', text: 'SESSION' }), surface).toBeDefined()
      await pane.press({ key: 'pane-view-turns' })
      await pane.unmount()
      pane = await $.ui.mount({ plugin: 'quackpit', surface, ...PANE })
      expect(await pane.find({ type: 'Text', text: 'LAST 3 TURNS' }), surface).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /step 2/ }), surface).toBeDefined()
      await pane.press({ key: 'pane-view-handover' })
      await pane.unmount()
      pane = await $.ui.mount({ plugin: 'quackpit', surface, ...PANE })
      expect(await pane.find({ type: 'Text', text: 'Handover' }), surface).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'pane-write' }), surface).toBeDefined()
      await pane.press({ key: 'pane-view-overview' })
      await pane.unmount()
    }
    // The pane's buttons: add a tile, then write the handover.
    await command($, 'tab band')
    let pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    await pane.press({ key: 'pane-add-files' })
    expect((w.store.get('layout') as { tiles: string[] }).tiles).toContain('files')
    await pane.press({ key: 'pane-view-handover' })
    await pane.unmount()
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    await pane.press({ key: 'pane-write' })
    expect(w.written.map(f => f.path)).toEqual(['/work/.claude/handover.md'])
    await pane.unmount()
  })

  test("while a task list runs, the spinner's ellipsis carries its count", EN, async ($, on) => {
    const w = world(on, { now: T0 })
    // The engine's own spinner, beneath the plugin: it draws what it is handed.
    on('ui.render', { component: 'Spinner' }, ($2, e) => $2.ui.resolve(e).Text({ children: `${e.props.word}${e.props.suffix}` }))
    await start($, w)
    await $.turn.start({ text: 'go', turnId: 'live' })
    await $.tool.call(todo([['One', 'completed'], ['Two', 'in_progress'], ['Three', 'pending']]))
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', component: 'Spinner', props: { word: 'Quacking', message: null, suffix: '…', mode: 'tool-use' } })
    expect(await ui.find({ type: 'Text', text: 'Quacking… 1/3' })).toBeDefined()
    await ui.unmount()
  })

  test('there is no demo: /quackpit demo is an unknown word, answered with the help, and the band shows only this session', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await command($, 'demo')
    expect(w.toasts.at(-1)).toMatch(/^\/quackpit opens the pane/)
    await w.clock.advance(20_000)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: ' demo' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Quack:' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /No turns yet/ })).toBeDefined()
    await ui.unmount()
  })

  test('a resumed session is rebuilt from its transcript, and the duck stays quiet about its history', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    w.messages = [
      { role: 'user', text: 'Fix the flaky login test', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'a', tool: 'TodoWrite', input: { todos: [{ content: 'Find the race', status: 'in_progress', activeForm: 'Finding' }] }, text: 'ok', result: {} },
          { tool_use_id: 'b', tool: 'Bash', input: { command: 'pnpm test' }, text: 'Tests  1 failed (1)', isError: true },
          { tool_use_id: 'c', tool: 'Edit', input: { file_path: '/work/src/login.ts' }, text: 'ok', result: {} },
        ],
      },
    ]
    await start($, w)
    await command($, 'handover')
    const text = w.written[0]?.text ?? ''
    expect(text).toContain('> Fix the flaky login test')
    expect(text).toContain('- [ ] Find the race _(in progress)_')
    expect(text).toContain('- `src/login.ts` (×1)')
    expect(text).toContain('✗ `pnpm test`')
    expect(w.notified).toEqual([])
    expect(w.toasts.filter(t => t.startsWith('Quack:'))).toEqual([])
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: 'Quack:' })).toBeUndefined()
    await ui.unmount()
  })

  test('after /clear the cockpit starts over at turn 1, whatever the new transcript counts', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await turn($, w, { prompt: 'Fix the flaky login test' })
    await turn($, w)
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    // As the engine has it after /clear: a new id, and a transcript holding /clear and the new prompt.
    w.sid = 'session-2'
    w.messages = [
      { role: 'user', text: '<command-name>/clear</command-name>', toolUses: [] },
      { role: 'user', text: 'Now the signup form', toolUses: [] },
    ]
    await turn($, w, { prompt: 'Now the signup form' })
    await command($, 'handover')
    const text = w.written.at(-1)?.text ?? ''
    expect(text).toContain('> Now the signup form')
    expect(text).toContain('over 1 turn ·')
    // The cleared cockpit starts with no model or project: they are read again (the session instrument says the model).
    await command($, 'overview')
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: 'test-model' })).toBeDefined()
    await pane.unmount()
  })

  test('after /clear with the session state started afresh, as Claude Code does, the next turn is turn 1 and nothing before it carries on', EN, async ($, on) => {
    // A state of its own for quackpit's values once the session's state is new: empty, then what is written.
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
    await turn($, w, { prompt: 'Fix the flaky login test', tools: [bash('pnpm test')] })
    await turn($, w)
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    fresh = true
    w.sid = 'session-2'
    // Claude Code counts the commands as turns; by the first event the new prompt is in the transcript too.
    w.messages = [
      { role: 'user', text: '<command-name>/clear</command-name>', toolUses: [] },
      { role: 'user', text: '<command-name>/quackpit</command-name>', toolUses: [] },
      { role: 'user', text: 'Now the signup form', toolUses: [] },
    ]
    await $.prompt.submit({ text: 'Now the signup form', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'Now the signup form', turnId: 'after-clear' })
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: 'turn 1 · 0 tools' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Watching since/ })).toBeUndefined()
    await ui.unmount()
    // The new prompt is the new session's mission.
    // The mission heads the turns view.
    await command($, 'view turns')
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: 'Now the signup form' })).toBeDefined()
    await pane.unmount()
  })

  test('the store keeps one small record per session-day and rolls finished days up', async () => {
    const map = new Map<string, unknown>()
    const kv: KV = {
      get: async key => map.get(key),
      set: async (key, value) => void map.set(key, value),
      delete: async key => void map.delete(key),
      keys: async () => [...map.keys()],
    }
    await addToDay(kv, '2026-10-09', 'a', 1_000_000, 60)
    await addToDay(kv, '2026-10-09', 'b', 500_000, 30)
    await addToDay(kv, '2026-10-10', 'a', 2_000_000, 120)
    await addToDay(kv, '2026-08-01', 'a', 1, 1)
    await rollUp(kv, '2026-10-10')
    await rollUp(kv, '2026-10-10')
    expect(await loadDays(kv, '2026-10-11')).toEqual([{ day: '2026-10-09', tokens: 1_500_000, activeMin: 90 }])
    expect([...map.keys()].sort()).toEqual(['nd:2026-10-09', 'np:2026-10-10:a'])
    expect(JSON.stringify([...map.entries()]).length).toBeLessThan(2048)
  })

  test('the handover of an empty session and the synthesised quack are well-formed', () => {
    const text = buildHandover({ c: newCockpit(T0, 's'), now: T0 + MINUTE, locale: 'ko' })
    expect(text).toStartWith('# 인수인계\n')
    expect(text).toContain('## 다음 교대')
    const wav = quackWav()
    expect(wav.startsWith('UklGR')).toBe(true)
    expect(wav.length).toBeLessThan(16_000)
  })
})
