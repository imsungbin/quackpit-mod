import { describe, expect, test } from 'claude-code/testing'

import { newCockpit, onToolEnd, onToolStart, onTurnEnd, onTurnStart, type Cockpit } from '../src/model'
import { KEEP_SESSIONS, staleRecords, toRecord, type SessionRecord } from '../src/record'
import { at, band, bash, command, EN, HOUR, MINUTE, PANE, start, todo, turn, world } from './kit'

const T0 = at(2026, 10, 11, 10)
const DAY = 24 * HOUR

describe("the session's record", () => {
  test('the record is written once a turn, holding the turns, tasks and checks', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    w.bash = () => ({ ok: false, stdout: 'Tests  2 failed | 8 passed (10)' })
    await start($, w)
    await turn($, w, { prompt: 'Port the parser', tools: [todo([['Read the grammar', 'completed'], ['Port the lexer', 'in_progress'], ['Port the parser', 'pending']])] })
    await turn($, w, { tools: [bash('pnpm test')] })
    await turn($, w)
    expect(w.storeWrites.filter(key => key.startsWith('s:'))).toEqual(['s:session-1', 's:session-1', 's:session-1'])
    const kept = w.store.get('s:session-1') as SessionRecord
    expect(kept.cockpit.history.map(h => h.n)).toEqual([1, 2, 3])
    expect(kept.cockpit.tasks?.items.map(t => t.title)).toEqual(['Read the grammar', 'Port the lexer', 'Port the parser'])
    expect(kept.cockpit.checks).toMatchObject([{ kind: 'test', status: 'fail', failed: 2 }])
    expect(kept.cockpit.turn).toBeUndefined()
  })

  test('a restarted process brings them back from the record, with their real times, before any transcript', EN, async ($, on) => {
    // What the process before wrote: three turns, a task list, a failed test run 10 minutes ago.
    let c = newCockpit(T0, 'session-1')
    for (let i = 0; i < 3; i++) {
      c = onTurnStart(c, { at: T0 + i * MINUTE, turnId: `t${i}`, text: 'go' })
      if (i === 0) {
        const plan = { at: T0, id: 'p', tool: 'TodoWrite', input: { todos: [{ content: 'Read the grammar', status: 'completed', activeForm: 'Reading' }, { content: 'Port the lexer', status: 'in_progress', activeForm: 'Porting' }] } }
        c = onToolEnd(onToolStart(c, plan), { ...plan, outcome: 'ok', text: 'ok' })
      }
      if (i === 1) {
        const run = { at: T0 + MINUTE, id: 'r', tool: 'Bash', input: { command: 'pnpm test' } }
        c = onToolEnd(onToolStart(c, run), { ...run, at: T0 + MINUTE + 3000, outcome: 'error', text: 'Exit code 1\nTests  2 failed | 8 passed (10)' })
      }
      c = onTurnEnd(c, { at: T0 + i * MINUTE + 30_000, turnId: `t${i}`, tokens: 1000, durationMs: 30_000, isAborted: false })
    }
    // Restarted 10 minutes after that test run ended.
    const w = world(on, { now: T0 + 11 * MINUTE + 3000, store: { 's:session-1': toRecord(c, T0 + 2 * MINUTE) } })
    // The transcript would give a thinner picture, with no times: the record wins.
    w.messages = [{ role: 'user', text: 'Port the parser', toolUses: [] }]
    await start($, w)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: 'Port the lexer' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'tests · 10 min ago' })).toBeDefined()
    await ui.unmount()
    await command($, 'tab turns')
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: 'LAST 3 TURNS' })).toBeDefined()
    await pane.unmount()
  })

  test('old records are pruned: the 20 written last, none older than 7 days', EN, async ($, on) => {
    const record = (sid: string, savedAt: number) => toRecord({ ...newCockpit(savedAt - HOUR, sid) }, savedAt)
    const store: Record<string, unknown> = { 's:junk': { not: 'a record' } }
    for (let i = 0; i < 22; i++) store[`s:recent-${i}`] = record(`recent-${i}`, T0 - i * HOUR)
    for (let i = 0; i < 2; i++) store[`s:old-${i}`] = record(`old-${i}`, T0 - 8 * DAY - i * HOUR)
    const w = world(on, { now: T0, store })
    await start($, w)
    const kept = [...w.store.keys()].filter(key => key.startsWith('s:')).sort()
    expect(kept).toHaveLength(KEEP_SESSIONS)
    expect(kept.some(key => key.startsWith('s:old') || key === 's:junk' || key === 's:recent-20' || key === 's:recent-21')).toBe(false)
    expect(staleRecords([{ key: 'a', savedAt: T0 }, { key: 'b', savedAt: T0 - 8 * DAY }], T0)).toEqual(['b'])
  })

  test('the store stays small: a full record is a few KiB, twenty well under 2 MiB', () => {
    const long = (n: number) => 'x'.repeat(n)
    const c: Cockpit = {
      ...newCockpit(T0, 'big'),
      goal: long(600),
      history: Array.from({ length: 20 }, (_, i) => ({ n: i + 1, startedAt: T0, endedAt: T0 + MINUTE, tokens: 123_456, costUsd: 1.23, durationMs: 60_000, tools: 40, edits: 9, prompt: long(80) })),
      turnTokens: Array.from({ length: 50 }, () => 123_456),
      turnUsd: Array.from({ length: 50 }, () => 1.23),
      recent: Array.from({ length: 60 }, (_, i) => [T0 + i * MINUTE, 99_999] as [number, number]),
      fiveSamples: Array.from({ length: 120 }, (_, i) => [T0 + i * MINUTE, 55.5] as [number, number]),
      checks: Array.from({ length: 30 }, (_, i) => ({ id: `toolu_${i}_${long(20)}`, kind: 'test' as const, command: long(200), status: 'fail' as const, failed: 3, passed: 97, startedAt: T0, endedAt: T0 + 9000, durationMs: 9000, turn: i })),
      failures: (['test', 'typecheck', 'lint', 'build'] as const).map(kind => ({ kind, command: long(200), at: T0, output: long(2000) })),
      commands: Array.from({ length: 40 }, () => ({ command: long(160), at: T0, ok: false })),
      files: Array.from({ length: 200 }, (_, i) => ({ path: `/work/${long(80)}/${i}.ts`, edits: 12, lastAt: T0 })),
      agents: Array.from({ length: 20 }, (_, i) => ({ id: `toolu_${i}`, description: long(60), type: 'general-purpose', startedAt: T0, endedAt: T0 + MINUTE, status: 'done' as const, tokens: 412_000 })),
      tasks: { source: 'todo', items: Array.from({ length: 100 }, (_, i) => ({ id: `todo-${i}`, title: long(200), active: long(200), status: 'completed' as const, startedAt: T0, doneAt: T0 + MINUTE })), turn: 3, updatedAt: T0 },
      prompts: Array.from({ length: 8 }, () => long(300)),
      lastPrompt: long(4000),
      question: long(400),
      passing: (['test', 'typecheck', 'lint', 'build'] as const).map(kind => ({ kind, command: long(200), at: T0 })),
      ack: Array.from({ length: 50 }, (_, i) => `check:test:${T0 + i}`),
      seen: Array.from({ length: 50 }, (_, i) => `check:test:${T0 + i}`),
    }
    // Every list at its longest and every text at its widest: the worst a record can be.
    const size = JSON.stringify(toRecord(c, T0)).length
    expect(size).toBeLessThan(24 * 1024)
    // Twenty of them stay under a quarter of the store's 2 MiB.
    expect(size * KEEP_SESSIONS).toBeLessThan(512 * 1024)
  })
})
