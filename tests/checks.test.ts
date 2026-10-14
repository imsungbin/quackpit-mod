import { describe, expect, test } from 'claude-code/testing'

import { checkKind, checkKinds, exitIsPipe, failingLines, judgeCheck, masksExit, parseCounts } from '../src/checks'
import { maskSecrets } from '../src/mask'
import { toolKind } from '../src/metrics'
import { newCockpit, onToolEnd, onToolStart, onTurnStart, unverified, type Cockpit } from '../src/model'
import { historyStrip } from '../src/panes'
import { checksFace, readingsOf, receiptText } from '../src/tiles'
import { plain } from '../src/text'
import { at, band, bash, BASH_BLOCKED, DIALOG_NO, EN, MINUTE, PANE, RULE_NO, start, turn, world } from './kit'

const T0 = at(2026, 10, 11, 10)

describe('check detection', () => {
  test('test, typecheck, lint and build commands are checks; reading a config file is not', () => {
    expect(checkKind('pnpm test')).toBe('test')
    expect(checkKind('npx vitest run src')).toBe('test')
    expect(checkKind('cd app && FORCE_COLOR=0 pytest -q')).toBe('test')
    expect(checkKind('claude plugin test .')).toBe('test')
    expect(checkKind('npx -y -p typescript@5.9.3 tsc -p .')).toBe('typecheck')
    expect(checkKind('pnpm typecheck')).toBe('typecheck')
    expect(checkKind('npm run lint -- --fix')).toBe('lint')
    expect(checkKind('ruff check .')).toBe('lint')
    expect(checkKind('pnpm build')).toBe('build')
    expect(checkKind('cargo build --release')).toBe('build')
    expect(checkKind('cat jest.config.js')).toBeUndefined()
    expect(checkKind('git commit -m "fix tests"')).toBeUndefined()
    expect(checkKind('ls')).toBeUndefined()
  })

  test('the summary line of common runners is read: passed, failed, errors', () => {
    expect(parseCounts(' Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 10 passed (12)')).toMatchObject({ passed: 10, failed: 2 })
    expect(parseCounts('Tests:       1 failed, 11 passed, 12 total')).toMatchObject({ passed: 11, failed: 1 })
    expect(parseCounts('===== 3 failed, 9 passed in 1.20s =====')).toMatchObject({ passed: 9, failed: 3 })
    expect(parseCounts('test result: ok. 12 passed; 0 failed; 0 ignored')).toMatchObject({ passed: 12, failed: 0 })
    expect(parseCounts('src/a.ts(3,1): error TS2304: x\nFound 3 errors in 2 files.')).toMatchObject({ errors: 3 })
    expect(parseCounts('✖ 5 problems (3 errors, 2 warnings)')).toMatchObject({ errors: 3, warnings: 2 })
  })

  test('a failing exit is a fail; so is a summary naming failures behind a pipe', () => {
    expect(judgeCheck({ isError: true, text: 'Exit code 1' }).status).toBe('fail')
    expect(judgeCheck({ isError: false, text: 'Tests  1 failed | 4 passed (5)' }).status).toBe('fail')
    expect(judgeCheck({ isError: false, text: 'Tests  5 passed (5)' }).status).toBe('pass')
    expect(judgeCheck({ isError: false, interrupted: true, text: '' }).status).toBe('interrupted')
  })

  test('a clean exit is a pass whatever the output mentions; where a pipe may hide the exit, the summary decides', () => {
    expect(masksExit('pnpm test 2>&1 | tail -5')).toBe(true)
    expect(masksExit('pnpm test || true')).toBe(true)
    expect(masksExit('pnpm test; echo done')).toBe(true)
    expect(masksExit('pnpm typecheck && pnpm test')).toBe(false)
    expect(masksExit("grep -c 'a|b' notes.txt && pnpm test")).toBe(false)
    // "2 failed attempts" in a passing log is no summary line.
    expect(parseCounts('retrying: 2 failed attempts\nok  \texample.com/pkg\t0.4s').failed).toBeUndefined()
    expect(parseCounts('3 errors retried, all recovered').errors).toBeUndefined()
    expect(judgeCheck({ isError: false, text: 'Tests  1 failed | 4 passed (5)', exitMasked: false }).status).toBe('pass')
    expect(judgeCheck({ isError: false, text: 'Tests  1 failed | 4 passed (5)', exitMasked: true }).status).toBe('fail')
  })

  test('a test refused at the dialog, by a rule or by the Bash tool itself, or stopped with Esc, is no failed test', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    for (const words of [DIALOG_NO, RULE_NO, BASH_BLOCKED]) {
      w.bash = () => ({ ok: false, refused: words })
      await turn($, w, { tools: [bash(words === BASH_BLOCKED ? 'sleep 25 && pnpm test' : 'pnpm test')] })
    }
    // It never ran: no check to show.
    expect(await ui.find({ type: 'Text', text: / · none run yet/ })).toBeDefined()
    w.bash = () => ({ ok: false, interrupted: true, stdout: ' ✓ src/a.test.ts (3 tests)' })
    await turn($, w, { tools: [bash('pnpm test')] })
    expect(await ui.find({ type: 'Text', text: '– interrupted' })).toBeDefined()
    // The duck has nothing to say about any of it.
    expect(w.notified).toEqual([])
    expect(w.toasts.filter(text => text.startsWith('Quack:'))).toEqual([])
    expect(w.store.get('notify')).toBeUndefined()
    await ui.unmount()
  })

  test('a passing run shows its count, measured time and age in the band', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    w.bash = command => (command.includes('test') ? { ok: true, stdout: ' ✓ 12 tests\n      Tests  12 passed (12)\n   Duration  2.9s' } : { ok: true })
    await start($, w)
    await turn($, w, { tools: [bash('pnpm test')], minutes: 4 })
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: '✓ 12 passed' })).toBeDefined()
    // The tool call took 1.5 s on the mock clock: the time is measured, not printed.
    expect(await ui.find({ type: 'Text', text: ' 1.5 s' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'tests · 4 min ago' })).toBeDefined()
    await ui.unmount()
  })

  test("a run that waited on a permission dialog shows no time: the wait was the person's, not the run's", EN, async ($, on) => {
    const w = world(on, { now: T0 })
    w.bash = () => ({ ok: true, stdout: '      Tests  12 passed (12)' })
    w.askMs = 40_000
    await start($, w)
    await turn($, w, { tools: [bash('pnpm test')] })
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: '✓ 12 passed' })).toBeDefined()
    // Measured around the call it would read 42 s, the dialog's 40 s with the run's 1.5 s.
    expect(await ui.find({ type: 'Text', text: /^ [\d.]+ s$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('one error is "1 error"', () => {
    const call = { at: T0, id: 'l', tool: 'Bash', input: { command: 'pnpm lint' } }
    const output = 'src/a.ts\n  3:1  error  no-unused-vars\n✖ 1 problem (1 error, 0 warnings)'
    const c = onToolEnd(onToolStart(newCockpit(T0, 's'), call), { ...call, outcome: 'error', text: `Exit code 1\n${output}`, result: `Exit code 1\n${output}` })
    expect(plain(checksFace(readingsOf(c, { now: T0 + MINUTE, locale: 'en', days: [], today: '2026-10-11' })).lines[0])).toMatch(/^✗ 1 error\b(?!s)/)
  })

  test('a failing run turns the tile red with what failed', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    w.bash = () => ({ ok: false, stdout: 'FAIL src/a.test.ts\n      Tests  3 failed | 9 passed (12)' })
    await start($, w)
    await turn($, w, { tools: [bash('pnpm vitest run')] })
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    const fail = await ui.find({ type: 'Text', text: '✗ 3 failed' })
    expect(fail?.props.color).toBe('error')
    await ui.unmount()
  })

  test("a subagent's tool calls never count: not as checks, edits or progress", () => {
    expect(toolKind({ tool: 'Bash', command: 'pnpm test', agentId: 'agent-7' })).toBeUndefined()
    expect(toolKind({ tool: 'Bash', command: 'pnpm test' })).toBe('verify')
    let c = newCockpit(T0, 's')
    const call = { at: T0, id: 'x', tool: 'Bash', input: { command: 'pnpm test' }, agentId: 'agent-7' }
    c = onToolStart(c, call)
    c = onToolEnd(c, { ...call, at: T0 + MINUTE, outcome: 'error', text: 'Tests  1 failed (1)' })
    const edit = { at: T0, id: 'y', tool: 'Edit', input: { file_path: '/work/a.ts' }, agentId: 'agent-7' }
    c = onToolEnd(onToolStart(c, edit), { ...edit, outcome: 'ok', text: 'ok' })
    const plan = { at: T0, id: 'z', tool: 'TodoWrite', input: { todos: [{ content: 'x', status: 'pending', activeForm: 'x' }] }, agentId: 'agent-7' }
    c = onToolEnd(onToolStart(c, plan), { ...plan, outcome: 'ok', text: 'ok' })
    expect(c.checks).toEqual([])
    expect(c.files).toEqual([])
    expect(c.tasks).toBeUndefined()
    expect(c.commands).toEqual([])
  })

  test('credentials in a command are masked before anything shows or keeps it', () => {
    expect(maskSecrets('API_TOKEN=abc123 pnpm test --token xyz')).toBe('API_TOKEN=*** pnpm test --token ***')
    expect(maskSecrets('curl https://user:hunter2@example.com')).toBe('curl https://***@example.com')
    expect(maskSecrets('echo sk-ant-api03-abcdefghijklmnop')).toBe('echo ***')
  })

  test('credentials in curl flags, headers, mysql, JSON and known token shapes are masked; ordinary flags are not', () => {
    expect(maskSecrets('curl -u admin:hunter2 https://api.example.com')).toBe('curl -u *** https://api.example.com')
    expect(maskSecrets('curl -H "X-Api-Key: abc123def456" https://x.io')).toBe('curl -H "X-Api-Key: ***" https://x.io')
    expect(maskSecrets("curl -H 'Authorization: token abcdef123456' https://x.io")).toBe("curl -H 'Authorization: ***' https://x.io")
    expect(maskSecrets('mysql -u root -pS3cret shop')).toBe('mysql -u root -p*** shop')
    expect(maskSecrets('{"user": "me", "password": "hunter2"}')).toBe('{"user": "me", "password": "***"}')
    expect(maskSecrets('db:\n  password: hunter2')).toBe('db:\n  password: ***')
    const tokens = [
      'sk_live_51Habcdefghijklmnop',
      'npm_abcdefghijklmnopqrstuvwxyz0123456789',
      'glpat-abcdefghijklmnopqrst',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ]
    for (const token of tokens) expect(maskSecrets(`use ${token} here`)).toBe('use *** here')
    for (const plain of ['git push -u origin main', 'mkdir -p src/a && tsc -p .', 'fix the token counting bug', 'docker run -p 8080:80 app']) {
      expect(maskSecrets(plain)).toBe(plain)
    }
  })

  test('after a pass, the checks tile says how many edits no check has seen yet', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    w.bash = () => ({ ok: true, stdout: 'Tests  12 passed (12)' })
    await start($, w)
    const edit = (n: number) => ({ tool: 'Edit' as const, file_path: `/work/src/f${n}.ts`, old_string: 'a', new_string: 'b' })
    await turn($, w, { tools: [bash('pnpm test'), edit(1), edit(2), edit(1)] })
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: 'tests · 3 edits since' })).toBeDefined()
    await ui.unmount()
    await turn($, w, { tools: [bash('pnpm test')] })
    const after = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await after.find({ type: 'Text', text: 'tests · just now' })).toBeDefined()
    await after.unmount()
    await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE }).then(async pane => {
      // The pane's checks instrument: its runs a row a kind, then what the band says beside them.
      expect(await pane.find({ type: 'Text', text: 'test ' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: 'tests · just now' })).toBeDefined()
      await pane.unmount()
    })
  })

  test('an edit made while a check ran is one it did not see; one before it is', () => {
    let c: Cockpit = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
    const run = { at: T0, id: 'run', tool: 'Bash', input: { command: 'pnpm test' } }
    const before = { at: T0, id: 'e0', tool: 'Edit', input: { file_path: '/work/a.ts' } }
    const during = { at: T0 + 1000, id: 'e1', tool: 'Edit', input: { file_path: '/work/b.ts' } }
    c = onToolEnd(onToolStart(c, before), { ...before, outcome: 'ok', text: 'ok' })
    c = onToolStart(c, run)
    c = onToolEnd(onToolStart(c, during), { ...during, outcome: 'ok', text: 'ok' })
    c = onToolEnd(c, { ...run, at: T0 + 5000, outcome: 'ok', text: 'Tests  3 passed (3)', result: { stdout: 'Tests  3 passed (3)', stderr: '', interrupted: false } })
    expect(unverified(c)).toEqual({ count: 1, paths: ['/work/b.ts'] })
  })

  test("the pane's history strip: one square a run, green or red, newest on the right", () => {
    let c: Cockpit = newCockpit(T0, 's')
    const answers: [string, boolean, boolean][] = [['1', true, false], ['2', false, false], ['3', false, true], ['4', true, false]]
    for (const [id, ok, interrupted] of answers) {
      const call = { at: T0, id, tool: 'Bash', input: { command: 'pnpm test' } }
      c = onToolStart(c, call)
      c = onToolEnd(c, interrupted ? { ...call, outcome: 'interrupted', text: '[Request interrupted by user for tool use]' } : ok ? { ...call, outcome: 'ok', text: 'Tests  1 passed (1)', result: { stdout: 'Tests  1 passed (1)', stderr: '', interrupted: false } } : { ...call, outcome: 'error', text: 'Exit code 1' })
    }
    expect(historyStrip(c).map(span => [span.text, span.tone])).toEqual([['■', 'ok'], ['■', 'bad'], ['□', 'muted'], ['■', 'ok']])
  })

  test('a chain or a loop runs every check in it, each once: a loop\'s `do` and an `if`\'s words are no command', () => {
    expect(checkKinds('npx -y -p typescript@5.9.3 tsc -p . && claude plugin test . 2>&1 | grep -E "pass|fail"')).toEqual(['typecheck', 'test'])
    expect(checkKinds('pnpm lint && pnpm typecheck && pnpm test && pnpm build')).toEqual(['lint', 'typecheck', 'test', 'build'])
    expect(checkKinds('for d in a b; do (cd $d && node --test); done')).toEqual(['test'])
    expect(checkKinds('for f in tests/*.test.ts; do node --test "$f"; done 2>&1 | tail -3')).toEqual(['test'])
    expect(checkKinds('while ! pnpm test; do sleep 5; done')).toEqual(['test'])
    expect(checkKinds('if pnpm typecheck; then pnpm test; else echo no; fi')).toEqual(['typecheck', 'test'])
    expect(checkKinds('pnpm test && pnpm test:e2e')).toEqual(['test'])
    expect(checkKind('for x in 1 2; do echo $x; done')).toBeUndefined()
    // The exit is a filter's where the line ends in a pipe joined only by `&&`.
    expect(exitIsPipe('pnpm typecheck && pnpm test 2>&1 | grep -E "pass|fail"')).toBe(true)
    expect(exitIsPipe('pnpm test; pnpm lint | tail -3')).toBe(false)
    expect(exitIsPipe('pnpm test || true')).toBe(false)
    expect(exitIsPipe("pnpm test && echo 'a|b'")).toBe(false)
  })

  test('a loop that printed its summary more than once is counted whole; a failing run keeps the lines that say what failed', () => {
    expect(parseCounts('# pass 3\n# fail 0\n# pass 2\n# fail 1')).toMatchObject({ passed: 5, failed: 1 })
    expect(parseCounts('      Tests  4 passed (4)\n      Tests  1 failed | 2 passed (3)')).toMatchObject({ passed: 6, failed: 1 })
    // A clean summary that came through a filter decides, whatever the filter's own exit said.
    expect(judgeCheck({ isError: true, text: 'Exit code 1\n# pass 175\n# fail 0', exitMasked: true, exitIsPipe: true }).status).toBe('pass')
    expect(judgeCheck({ isError: true, text: 'Exit code 1\n# pass 175\n# fail 0', exitMasked: true, exitIsPipe: false }).status).toBe('fail')
    const out = 'Exit code 1\n▶ sum\n  ✖ adds (1.2ms)\n    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n# pass 4\n# fail 1'
    expect(failingLines(out)).toBe('✖ adds (1.2ms)\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n# fail 1')
    // Cut by `tail`, a run keeps only its counts: the failures' count, never the zero counts and the timing.
    expect(failingLines('Exit code 1\n# pass 1\n# fail 3\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 12162.89')).toBe('# fail 3')
  })

  test("a chain's failure falls on the check its output names; naming none, on every check in it until each passes again", () => {
    const run = (c: Cockpit, id: string, command: string, ok: boolean, text: string) => {
      const call = { at: T0, id, tool: 'Bash', input: { command } }
      return onToolEnd(onToolStart(c, call), ok ? { ...call, outcome: 'ok', text, result: { stdout: text, stderr: '', interrupted: false } } : { ...call, outcome: 'error', text: `Exit code 1\n${text}`, result: `Exit code 1\n${text}` })
    }
    // tsc's errors name the typecheck: the tests in the chain never ran, so nothing is said of them.
    let c = run(newCockpit(T0, 's'), 'a', 'pnpm typecheck && pnpm test', false, "src/a.ts(3,1): error TS2304: Cannot find name 'x'.")
    expect(c.failures.map(f => f.kind)).toEqual(['typecheck'])
    expect(c.checks.at(-1)).toMatchObject({ kind: 'typecheck', kinds: ['typecheck', 'test'], judged: ['typecheck'] })
    c = run(c, 'b', 'pnpm typecheck', true, '')
    expect(c.failures).toEqual([])
    // A failure the output does not name is the whole chain's: each check clears with its own pass.
    c = run(c, 'c', 'pnpm lint && pnpm build', false, 'something went wrong')
    expect(c.failures.map(f => f.kind).sort()).toEqual(['build', 'lint'])
    c = run(c, 'd', 'pnpm lint', true, '')
    expect(c.failures.map(f => f.kind)).toEqual(['build'])
    c = run(c, 'e', 'pnpm lint && pnpm build', true, '')
    expect(c.failures).toEqual([])
    expect(c.passing.map(p => p.kind).sort()).toEqual(['build', 'lint', 'typecheck'])
  })

  test("the screenshot's case: an old failure clears once tests pass inside a chain or a loop, and the cell says what the caution says", EN, async ($, on) => {
    const w = world(on, { now: T0 })
    const failing = 'not ok 2 - adds\n# tests 4\n# pass 3\n# fail 1'
    const passing = '# tests 175\n# pass 175\n# fail 0'
    await start($, w)
    // A failing run behind a pipe, as `node --test 2>&1 | tail -9` in another folder.
    w.bash = () => ({ ok: true, stdout: failing })
    await turn($, w, { prompt: 'run the tests', tools: [bash('node --test 2>&1 | tail -9')] })
    expect(w.notified.at(-1)?.title).toBe('Quack: tests failed')
    // A typecheck passes on its own: the tests are still failing, and the cell says so, with its age.
    w.bash = () => ({ ok: true, stdout: '' })
    await turn($, w, { tools: [bash('npx -y -p typescript@5.9.3 tsc -p .')], minutes: 3 })
    let ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: '✗ 1 failed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^tests · \d+ min ago$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Quack:' })).toBeDefined()
    await ui.unmount()
    // Then the tests pass inside a chain whose exit a filter decides: the failure clears.
    w.bash = () => ({ ok: true, stdout: passing })
    await turn($, w, { tools: [bash('cd /work && npx -y -p typescript@5.9.3 tsc -p . && claude plugin test . 2>&1 | grep -E "^# (pass|fail)"')] })
    ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: '✓ 175 passed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'types+tests · just now' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Quack:' })).toBeUndefined()
    await ui.unmount()
    // A failure in a loop, then the loop passing: each clears and raises as a run of tests.
    w.bash = () => ({ ok: false, stdout: `${passing}\n${failing}` })
    await turn($, w, { tools: [bash('for d in a b; do (cd $d && node --test); done')] })
    expect(w.notified.filter(n => n.title === 'Quack: tests failed')).toHaveLength(2)
    w.bash = () => ({ ok: true, stdout: `${passing}\n${passing}` })
    const id = await turn($, w, { tools: [bash('for d in a b; do (cd $d && node --test); done')] })
    // All quiet: the overview draws no line of cautions.
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Button', key: 'pane-ack' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: 'Quack: ' })).toBeUndefined()
    await pane.unmount()
    void id
  })

  test("a turn's receipt names each kind a chain checked", () => {
    let c: Cockpit = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
    const call = { at: T0, id: 'a', tool: 'Bash', input: { command: 'pnpm typecheck && pnpm test' } }
    c = onToolEnd(onToolStart(c, call), { ...call, outcome: 'ok', text: 'Tests  3 passed (3)', result: { stdout: 'Tests  3 passed (3)', stderr: '', interrupted: false } })
    c = { ...c, history: [{ n: 1, startedAt: T0, endedAt: T0 + MINUTE, tokens: 1000, durationMs: 60_000, tools: 1, edits: 0 }] }
    expect(receiptText(c, 60_000, 'en')).toBe('1k tokens · types ✓ tests ✓')
  })

  test('a chain that failed with no check named in its output is one announcement, not one a check', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    w.bash = () => ({ ok: false, stdout: 'something went wrong' })
    await turn($, w, { tools: [bash('pnpm typecheck && pnpm test')] })
    expect(w.notified.map(n => n.title)).toEqual(['Quack: types+tests failed'])
    // Each clears with its own pass: the typecheck alone passing leaves the tests failing.
    w.bash = () => ({ ok: true, stdout: '' })
    await turn($, w, { tools: [bash('pnpm typecheck')] })
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Button', key: 'pane-ack' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'tests failed' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /types failed/ })).toBeUndefined()
    await pane.unmount()
  })

  test("a test run whose summary a pipe cut away gives no verdict: it never clears a failure it cannot show passing", EN, async ($, on) => {
    const cut = '# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 12162.89'
    expect(judgeCheck({ isError: false, text: cut, exitMasked: true, kinds: ['test'] }).status).toBe('hidden')
    // Its own exit shows, or a summary got through: a verdict as before.
    expect(judgeCheck({ isError: false, text: cut, exitMasked: false, kinds: ['test'] }).status).toBe('pass')
    expect(judgeCheck({ isError: false, text: '', exitMasked: true, kinds: ['typecheck'] }).status).toBe('pass')
    const w = world(on, { now: T0 })
    await start($, w)
    w.bash = () => ({ ok: false, stdout: 'not ok 1 - adds\n# pass 3\n# fail 1' })
    await turn($, w, { tools: [bash('node --test')] })
    w.bash = () => ({ ok: true, stdout: cut })
    await turn($, w, { tools: [bash('node --test 2>&1 | tail -4')] })
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    // The failure stands: the cell still says what the caution says.
    expect(await ui.find({ type: 'Text', text: '✗ 1 failed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Quack:' })).toBeDefined()
    await ui.unmount()
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: 'tests failed' })).toBeDefined()
    await pane.unmount()
  })
})
