import { describe, expect, test } from 'claude-code/testing'

import { at, band, bash, call, command, EN, start, turn, world } from './kit'

const T0 = at(2026, 10, 11, 10)

describe('fail-open, and nothing in the model context', () => {
  test('a throwing $.session.usage changes nothing: turns, prompts and tools pass through, the band still draws', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { fiveHour: 50, costUsd: 2 } })
    w.usageThrows = true
    await start($, w)
    await turn($, w, { prompt: 'keep going', tools: [bash('pnpm test')], tokens: 5000 })
    const sent = await $.prompt.submit({ text: 'still here', wait: false, origin: { kind: 'composer' } })
    expect(sent.text).toBe('still here')
    const ran = await call($, w, { tool: 'Bash', command: 'pnpm test' })
    expect(ran.deny).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: '✓ passed' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tile-limits' })).toBeDefined()
    await ui.unmount()
  })

  test('a broken store changes nothing either', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    w.storeThrows = true
    await start($, w)
    await turn($, w, { tools: [bash('pnpm test')] })
    await command($, 'add agents')
    const ran = await call($, w, { tool: 'Bash', command: 'ls' })
    expect(ran.deny).toBeUndefined()
    expect(w.storeWrites).toEqual([])
  })

  test('every command answers with an empty result, so nothing reaches the model; prompts go through untouched', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    for (const args of ['', 'add files', 'remove files', 'move pace 1', 'rows 3', 'reset', 'handover', 'duck off', 'duck on', 'help', 'nonsense']) {
      const answer = await command($, args)
      expect(answer.text, args).toBeUndefined()
      expect(answer.context, args).toBeUndefined()
    }
    const sent = await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
    expect(sent.text).toBe('hello')
    expect(w.prompts).toEqual([{ text: 'hello' }])
  })
})
