import { describe, expect, test } from 'claude-code/testing'

import { detailOf } from '../src/details'
import { newCockpit, onCompact, onMeta, onPrompt, onReading, onStep, onToolEnd, onToolStart, onTurnEnd, onTurnStart, type AgentRun, type Cockpit } from '../src/model'
import { lineWidth, plain } from '../src/text'
import { readingsOf } from '../src/tiles'
import { at, HOUR, MINUTE } from './kit'

const T0 = at(2026, 10, 13, 15)
const VIEW = { now: T0, locale: 'en' as const, days: [1, 2, 3, 4].map(d => ({ day: `2026-10-0${d}`, tokens: 2_000_000, activeMin: 120 })), today: '2026-10-13' }

/** Eight turns of a session: prompts, edits, a passing then a failing run, a compaction, a subagent. */
function session(): Cockpit {
  let c = onMeta(newCockpit(T0 - 3 * HOUR, 's'), { model: 'claude-opus-5-5', effort: 'max', mode: 'auto', root: '/work/app', repo: 'app' })
  for (let i = 0; i < 8; i++) {
    const t0 = T0 - 160 * MINUTE + i * 20 * MINUTE
    c = onPrompt(c, { at: t0, text: `step ${i}: refactor the lexer`, isPersonal: true })
    c = onTurnStart(c, { at: t0, turnId: `t${i}`, text: `step ${i}: refactor the lexer` })
    c = onStep(c, { at: t0 + MINUTE, startedAt: t0, turnId: `t${i}`, usage: { input_tokens: 3000, output_tokens: 400, cache_read_input_tokens: 40_000 + i * 15_000, cache_creation_input_tokens: 2000 } })
    const edit = { at: t0 + 2 * MINUTE, id: `e${i}`, tool: 'Edit', input: { file_path: `/work/app/src/${['lexer', 'parser', 'index'][i % 3]}.ts` } }
    c = onToolEnd(onToolStart(c, edit), { ...edit, outcome: 'ok', text: 'ok' })
    if (i === 3) c = onCompact(c, { at: t0 + 3 * MINUTE, isSkipped: false, isPrecompute: false })
    // A chain passes in turn 6; the tests fail behind a pipe in turn 8, two edits later.
    if (i === 5) {
      const pass = { at: t0 + 3 * MINUTE, id: 'p', tool: 'Bash', input: { command: 'pnpm typecheck && pnpm test' } }
      c = onToolEnd(onToolStart(c, pass), { ...pass, outcome: 'ok', text: 'Tests  48 passed (48)', result: { stdout: 'Tests  48 passed (48)', stderr: '', interrupted: false } })
    }
    if (i === 7) {
      const failing = 'FAIL src/lexer.test.ts > reads a number\nAssertionError: expected 12 to be 1.2\n Tests  1 failed | 47 passed (48)'
      const fail = { at: t0 + 3 * MINUTE, id: 'f', tool: 'Bash', input: { command: 'pnpm test 2>&1 | tail -20' } }
      c = onToolEnd(onToolStart(c, fail), { ...fail, outcome: 'ok', text: failing, result: { stdout: failing, stderr: '', interrupted: false } })
    }
    c = onTurnEnd(c, { at: t0 + 5 * MINUTE, turnId: `t${i}`, tokens: 5400, durationMs: 5 * MINUTE, isAborted: false })
  }
  const agent: AgentRun = { id: 'a1', type: 'Explore', description: 'Map the grammar', startedAt: T0 - 50 * MINUTE, endedAt: T0 - 47 * MINUTE, status: 'done', tokens: 88_000, durationMs: 180_000, toolUses: 12 }
  c = { ...c, agents: [agent] }
  for (const [m, pct] of [[-80, 20], [-60, 24], [-40, 28], [-20, 31], [0, 34]] as const) {
    c = onReading(c, { at: T0 + m * MINUTE, fiveHour: { pct, resetsAt: T0 + 100 * MINUTE }, sevenDay: { pct: 44, resetsAt: T0 + 100 * HOUR }, costUsd: 4.2 + (m + 80) / 40, contextPct: 7, contextTokens: 140_000, contextWindow: 1_000_000, pushed: true })
  }
  return { ...c, autoCompact: { at: T0, turn: 8, isOn: true, threshold: 967_000 } }
}

describe("the pane's details", () => {
  test('health lists every part: its value, its rule, its weight and what it took off, adding up to the score', () => {
    const r = readingsOf(session(), VIEW)
    const d = detailOf(r, 'health', 80)
    expect(plain(d.title)).toBe(`${r.health.score} ${r.health.word === 'smooth' ? 'smooth' : r.health.word === 'light' ? 'light chop' : r.health.word}`)
    const text = d.lines.map(plain)
    expect(text.slice(0, 2).join(' ')).toBe('A judgement, not a measurement: 100 less what each part takes off, its measured value turned into a share by its rule, times its weight.')
    for (const name of ['checks', 'context', '5h window', 'runaway turns', 'pace', 'breaks', 'night']) expect(text.some(line => line.startsWith(name)), name).toBe(true)
    expect(text.find(line => line.startsWith('checks'))).toMatch(/^checks +2 edits since a check last passed +0 \/ 25$/)
    expect(text).toContain('               whole to 2 unverified edits, nothing from 15')
    expect(text.at(-1)).toBe(`= ${r.health.score}: ${100 - r.health.score} off in all`)
    // Every line inside the pane, in both languages, at its narrowest.
    for (const L of ['en', 'ko'] as const) for (const line of detailOf(readingsOf(session(), { ...VIEW, locale: L }), 'health', 56).lines) expect(lineWidth(line), L).toBeLessThanOrEqual(56)
  })

  test('checks: every run newest first, its kinds, verdict, time and command, and a failed run its failing lines', () => {
    const d = detailOf(readingsOf(session(), VIEW), 'checks', 80)
    expect(plain(d.title)).toBe('2 runs')
    const text = d.lines.slice(1).map(plain)
    expect(plain(d.lines[0] ?? [])).toBe('1 passed, 1 failed')
    expect(text[0]).toBe('2 edits since the last pass')
    expect(text[1]).toBe('failing now: tests')
    expect(text[2]).toMatch(/^✗ tests {2}1 failed, 47 passed · 0\.0 s · \d\d:\d\d \(17 min ago\)$/)
    expect(text[3]).toBe('  pnpm test 2>&1 | tail -20')
    expect(text[4]).toBe('  │ FAIL src/lexer.test.ts > reads a number')
    expect(text[5]).toBe('  │ AssertionError: expected 12 to be 1.2')
    expect(text[7]).toMatch(/^✓ types\+tests {2}48 passed · 0\.0 s · \d\d:\d\d \(57 min ago\)$/)
  })

  test("context turn by turn against the auto-compact point, its compaction marked; files with what no pass has seen; the session's model and time", () => {
    const r = readingsOf(session(), VIEW)
    const context = detailOf(r, 'context', 80)
    expect(plain(context.title)).toBe('7% · 140k of 1M')
    const lines = context.lines.map(plain)
    expect(lines[0]).toBe('auto-compacts at 967k: 827k to go')
    // Nothing measured yet to split it by: it says when it will be (the split is tested in context.test.ts).
    expect(lines[1]).toBe('What fills it shows once a turn has ended: quackpit measures it then.')
    // Three rows of columns, two cells a turn, then the compaction's mark under the turn it came in.
    expect(lines.slice(2, 5).every(line => /^ {2}[ ▁▂▃▄▅▆▇█]+$/.test(line))).toBe(true)
    expect(lines[5]).toMatch(/^ {2} +⟲ *$/)
    expect(lines.at(-1)).toMatch(/^1 compaction: \d\d:\d\d$/)
    const files = detailOf(r, 'files', 80).lines.map(plain)
    expect(files[0]).toBe('2 edited since the last passing check')
    expect(files.slice(1)).toEqual(['  ×3  src/parser.ts  unverified', '  ×3  src/lexer.ts  unverified', '  ×2  src/index.ts'])
    const s = detailOf(r, 'session', 80)
    expect(plain(s.title)).toBe('Opus 5.5 · max')
    expect(s.lines.map(plain)).toEqual([
      'model    Opus 5.5 (claude-opus-5-5)',
      'effort   max · mode auto',
      'up       3h00 · since 12:00 · working 40m · 8 turns',
      'project  app  /work/app',
    ])
  })

  test('cost by turn, the subagents, the pace behind its dial and the five-hour readings behind the other, with their age', () => {
    const r = readingsOf(session(), VIEW)
    const cost = detailOf(r, 'cost', 80)
    expect(plain(cost.title)).toBe('session $6.20')
    expect(plain(cost.lines[0] ?? [])).toMatch(/^\d+ turns priced$/)
    const agents = detailOf(r, 'agents', 80).lines.map(plain)
    expect(agents).toEqual(['0 running · 1 done', '✓ Explore · Map the grammar  3m00 · 88k tokens · 12 tools'])
    const pace = detailOf(r, 'pace', 80).lines.map(plain)
    expect(pace).toContain('usual: the median of your last 4 days')
    // The scale's two ends and its marks, which no longer sit under the dial.
    expect(pace.some(line => /^the dial: 0 to \S+\/h, its top mark \S+\/h; amber from 1\.5×, red from 1\.8×$/.test(line))).toBe(true)
    expect(pace.at(-1)).toBe('latest response 2h20 ago'.replace('2h20 ago', pace.at(-1)?.split('response ')[1] ?? ''))
    const window = detailOf(r, 'limits', 80)
    expect(plain(window.title)).toBe('34% used · whole account')
    const lines = window.lines.map(plain)
    expect(lines[0]).toMatch(/^resets \d\d:\d\d, in 1h40$/)
    expect(lines[1]).toBe('the window is 3h20 in, of 5h')
    // The rate, here alone, in plain words, and what it means.
    expect(lines).toContain('+11 points an hour (the last 90 minutes, whole account)')
    expect(lines.join(' ')).toContain('That is how fast the window has filled lately: a line through 5 readings of the last 90 minutes')
    expect(lines.find(line => line.startsWith('readings:'))).toMatch(/^readings: \d\d:\d\d 20% · \d\d:\d\d 24% · \d\d:\d\d 28% · \d\d:\d\d 31% · \d\d:\d\d 34%$/)
    expect(lines.find(line => line.startsWith('7d'))).toMatch(/^7d 44% used · resets in 4d4h( → .+)?$/)
    expect(lines.slice(-2).join(' ')).toBe("read just now: the windows arrive with this session's own responses, so they go stale while it is idle")
  })
})
