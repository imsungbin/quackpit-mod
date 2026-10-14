import { describe, expect, test } from 'claude-code/testing'

import { clockText } from '../src/format'
import { buildHandover } from '../src/handover'
import { endingQuestion, MODEL_VERSION, newCockpit, onToolEnd, onToolStart, type Cockpit } from '../src/model'
import { at, band, bash, command, EN, MINUTE, PANE, start, todo, turn, world } from './kit'

const T0 = at(2026, 10, 11, 10)

describe('handover', () => {
  test('the handover has Mission, Telemetry, Anomalies and Next shift, built from events alone', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { costUsd: 0, ctxPct: 64, ctxTokens: 128_000 } })
    w.bash = cmd =>
      cmd === 'pnpm test'
        ? { ok: false, stdout: 'FAIL src/theme.test.ts > toggles\nAssertionError: expected "light" to be "dark"\n      Tests  1 failed | 11 passed (12)' }
        : { ok: true, stdout: 'Found 0 errors.' }
    await start($, w)
    await turn($, w, {
      prompt: 'Add a dark mode toggle to the settings page and keep the tests green',
      tools: [
        todo([
          ['Add a theme context', 'completed'],
          ['Wire the toggle', 'in_progress'],
          ['Persist the choice', 'pending'],
        ]),
        { tool: 'Edit', file_path: '/work/src/theme.tsx', old_string: 'a', new_string: 'b' },
        { tool: 'Edit', file_path: '/work/src/theme.tsx', old_string: 'b', new_string: 'c' },
        { tool: 'Write', file_path: '/work/src/Settings.tsx', content: 'x' },
        bash('pnpm typecheck'),
        bash('pnpm test'),
      ],
      tokens: 120_000,
      costUsd: 0.4,
    })
    await command($, 'handover')
    const file = w.written.find(f => f.path === '/work/.claude/handover.md')
    expect(file).toBeDefined()
    const text = file?.text ?? ''
    expect(text).toStartWith('# Handover\n')
    for (const heading of ['## Mission', '## Telemetry', '## Anomalies', '## Next shift']) expect(text).toContain(heading)
    expect(text).toContain('> Add a dark mode toggle to the settings page and keep the tests green')
    expect(text).toContain('Tasks, 1 of 3 done:')
    expect(text).toContain('- [x] Add a theme context')
    expect(text).toContain('- [ ] Wire the toggle _(in progress)_')
    expect(text).toContain('- `src/theme.tsx` (×2)')
    expect(text).toContain('✓ `pnpm typecheck`')
    expect(text).toContain('✗ `pnpm test`')
    expect(text).toContain('Tokens 120k over 1 turn · cost $0.40')
    expect(text).toContain('tests failed: `pnpm test`')
    expect(text).toContain('Open tasks, verbatim:')
    expect(text).toContain('AssertionError: expected "light" to be "dark"')
    // Copied to the clipboard, said in a toast, shown in the pane: never sent to the model.
    expect(w.copied).toEqual([text])
    expect(w.toasts.at(-1)).toBe('Handover written to .claude/handover.md and sent to the clipboard (some terminals, Warp among them, ask before they let it in).')
    expect(w.prompts.map(p => p.text)).toEqual(['Add a dark mode toggle to the settings page and keep the tests green'])
    // The handover view sets the note as lines: its headings bold, its lists and quotes set in.
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: 'Next shift' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^## / })).toBeUndefined()
    await pane.unmount()
  })

  test('turns over 3x the median and compactions are anomalies; with no failure outstanding the handover says so', () => {
    const base = {
      v: MODEL_VERSION as typeof MODEL_VERSION,
      sid: 's',
      startedAt: T0,
      lastAt: T0,
      phase: { kind: 'idle' as const, since: T0 },
      turnCount: 6,
      history: [1, 2, 3, 4, 5].map(n => ({ n, startedAt: T0, endedAt: T0 + 1000, tokens: 1000, costUsd: 0.1, tools: 1, edits: 0 })).concat([{ n: 6, startedAt: T0, endedAt: T0 + 1000, tokens: 9000, costUsd: 0.9, tools: 1, edits: 0, runaway: true } as never]),
      turnTokens: [],
      turnUsd: [],
      recent: [],
      tokens: 14_000,
      activeMs: 0,
      cache: { read: 0, write: 0, input: 0 },
      fiveSamples: [],
      compactions: 2,
      seq: 0,
      edits: [],
      prompts: [],
      passing: [],
      durations: { tasks: [], agents: {}, turns: [] },
      checks: [
        { id: 'a', kind: 'test' as const, command: 'pnpm test', status: 'fail' as const, startedAt: T0, endedAt: T0, turn: 1 },
        { id: 'b', kind: 'test' as const, command: 'pnpm test', status: 'pass' as const, startedAt: T0, endedAt: T0, turn: 2 },
      ],
      failures: [],
      commands: [],
      files: [],
      agents: [],
      meta: {},
      ack: [],
      seen: [],
      shift: { state: 'armed' as const },
      waits: [],
      jobs: [],
    }
    const text = buildHandover({ c: base, now: T0, locale: 'en' })
    expect(text).toContain('Turn 6 cost $0.90, over 3× the session median.')
    expect(text).toContain('The context was compacted 2 times.')
    expect(text).toContain('No failing check is outstanding.')
    expect(text).not.toContain('boom')
    expect(text).toContain('No prompt was seen.')
  })

  test('a failure stays outstanding until a run of its own kind passes; another kind passing does not clear it', () => {
    let c: Cockpit = newCockpit(T0, 's')
    const run = (id: string, command: string, ok: boolean, output: string, when: number) => {
      const call = { at: when, id, tool: 'Bash', input: { command } }
      c = onToolStart(c, call)
      c = onToolEnd(c, ok ? { ...call, outcome: 'ok', text: output, result: { stdout: output, stderr: '', interrupted: false } } : { ...call, outcome: 'error', text: `Exit code 1\n${output}`, result: `Exit code 1\n${output}` })
    }
    run('1', 'pnpm test', false, 'FAIL src/a.test.ts\n      Tests  1 failed | 4 passed (5)', T0)
    run('2', 'pnpm lint', false, 'src/a.ts\n  3:1  error  no-unused-vars\n✖ 1 problem (1 error, 0 warnings)', T0 + MINUTE)
    run('3', 'pnpm lint', true, '', T0 + 2 * MINUTE)
    let text = buildHandover({ c, now: T0 + 3 * MINUTE, locale: 'en' })
    expect(text).toContain('Last failing output, `pnpm test`')
    expect(text).toContain('Tests  1 failed | 4 passed (5)')
    expect(text).not.toContain('no-unused-vars')
    expect(text).not.toContain('No failing check is outstanding.')
    run('4', 'pnpm test', true, '      Tests  5 passed (5)', T0 + 4 * MINUTE)
    text = buildHandover({ c, now: T0 + 5 * MINUTE, locale: 'en' })
    expect(text).toContain('No failing check is outstanding.')
    expect(text).not.toContain('Last failing output')
  })

  test('what a resumed transcript gave back is marked "earlier", never given the resume\'s time', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    const failing = 'Exit code 1\n      Tests  1 failed | 2 passed (3)'
    w.messages = [
      { role: 'user', text: 'Fix the flaky upload test', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'old-1', tool: 'Bash', input: { command: 'pnpm test' }, isError: true, text: failing, result: failing }] },
    ]
    await start($, w)
    await w.clock.advance(5 * MINUTE)
    await command($, 'handover')
    const text = w.written.at(-1)?.text ?? ''
    expect(text).toContain('- ✗ `pnpm test` (earlier)')
    expect(text).toContain('Last failing output, `pnpm test` (earlier):')
    expect(text).not.toContain(`(${clockText(T0)})`)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: 'tests · earlier' })).toBeDefined()
    // History, not news: the duck does not quack about it.
    expect(w.notified).toEqual([])
    await ui.unmount()
  })

  test('past 80% context the band says "shift change soon" once', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { ctxPct: 50 } })
    await start($, w)
    await turn($, w)
    w.usage.ctxPct = 82
    await turn($, w)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: 'shift change soon · /quackpit handover' })).toBeDefined()
    await ui.unmount()
    // Shown for the next turn, then not again this session.
    await turn($, w)
    await turn($, w)
    const later = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await later.find({ type: 'Text', text: /shift change soon/ })).toBeUndefined()
    await later.unmount()
  })

  test('the handover says to treat each line as a starting point, and keeps your words: the later prompts masked, the last whole', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    const last = `Now the docs. ${'Explain the toggle, the storage key and the fallback to the system theme. '.repeat(5)}Thanks.`
    await turn($, w, { prompt: 'Add a dark mode toggle' })
    await turn($, w, { prompt: 'Keep it in the header, not the sidebar' })
    await turn($, w, { prompt: 'Use the storage helper with API_TOKEN=abc123 set' })
    await turn($, w, { prompt: last })
    await command($, 'handover')
    const text = w.written.at(-1)?.text ?? ''
    expect(text).toContain('Treat every line as a starting point, not a fact.')
    expect(text).toContain('## Your words')
    expect(text).toContain('- Keep it in the header, not the sidebar\n- Use the storage helper with API_TOKEN=*** set')
    expect(last.length).toBeGreaterThan(300)
    expect(text).toContain(`Your last prompt, verbatim (credentials masked):\n\n> ${last}`)
    // The goal is the mission, not one of the later words.
    expect(text).not.toContain('- Add a dark mode toggle')
  })

  test('how to run: the last passing command of each kind; unverified: what was edited after the last pass', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    w.bash = cmd => (cmd.includes('lint') ? { ok: false, stdout: '✖ 2 problems (2 errors, 0 warnings)' } : { ok: true, stdout: cmd.includes('test') ? 'Tests  4 passed (4)' : 'Found 0 errors.' })
    await start($, w)
    await turn($, w, {
      prompt: 'Fix the toggle',
      tools: [bash('pnpm typecheck'), bash('pnpm vitest run'), bash('pnpm lint'), { tool: 'Edit', file_path: '/work/src/a.ts', old_string: 'a', new_string: 'b' }, { tool: 'Write', file_path: '/work/src/b.ts', content: 'x' }],
    })
    await command($, 'handover')
    const text = w.written.at(-1)?.text ?? ''
    expect(text).toContain('## How to run\n\nThe last passing command of each kind of check:\n- types: `pnpm typecheck`')
    expect(text).toContain('- tests: `pnpm vitest run`')
    expect(text).not.toContain('- lint: `pnpm lint`')
    expect(text).toMatch(/## Unverified\n\nEdited after the last passing check \(`pnpm vitest run`, \d\d:\d\d\):\n- `src\/a.ts`\n- `src\/b.ts`/)
  })

  test("waiting on you: the question Claude's last answer ended on, until you write again", EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await turn($, w, { prompt: 'Add the toggle', answer: 'The toggle is in.\n\nShould it follow the system theme until someone picks one?' })
    await command($, 'handover')
    expect(w.written.at(-1)?.text).toContain("## Waiting on you\n\nClaude's last answer ended on a question:\n\n> Should it follow the system theme until someone picks one?")
    await turn($, w, { prompt: 'Yes', answer: 'Done: it follows the system theme.' })
    await command($, 'handover')
    expect(w.written.at(-1)?.text).not.toContain('## Waiting on you')
    expect(endingQuestion('Two ways:\n1. Keep it\n2. Drop it\n\nWhich do you want? ')).toBe('Which do you want?')
    expect(endingQuestion('I changed three files. Want me to run the tests too?')).toBe('Want me to run the tests too?')
    expect(endingQuestion('- Should I push to main?')).toBe('Should I push to main?')
    expect(endingQuestion('설정을 바꿨어요. 테스트도 돌릴까요？')).toBe('테스트도 돌릴까요？')
    expect(endingQuestion('Is it fixed? Yes. All 12 tests pass.')).toBeUndefined()
  })
})

