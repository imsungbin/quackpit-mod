import { describe, expect, test } from 'claude-code/testing'

import { blockDigits } from '../src/font'
import { newCockpit, onToolEnd, onToolStart, onTurnEnd, onTurnStart } from '../src/model'
import { applyTaskCall, isListLive, progressOf, timeLeft, type TaskList } from '../src/progress'
import { heroFace, phaseText, readingsOf } from '../src/tiles'
import { plain } from '../src/text'
import { at, band, call, EN, MINUTE, start, todo, turn, world } from './kit'

const T0 = at(2026, 10, 11, 10)

describe('progress (the hero)', () => {
  test('TodoWrite calls build the task list: done / total and the current item', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await turn($, w, {
      prompt: 'Add a dark mode toggle',
      tools: [
        todo([
          ['Read the settings', 'completed'],
          ['Add a theme context', 'completed'],
          ['Wire the toggle', 'in_progress'],
          ['Persist the choice', 'pending'],
          ['Update tests', 'pending'],
        ]),
      ],
    })
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: 'Wire the toggle' })).toBeDefined()
    // The big number is drawn in half blocks, two rows tall.
    const [top, bottom] = blockDigits('2/5')
    expect(await ui.find({ type: 'Text', text: top })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: bottom })).toBeDefined()
    await ui.unmount()
  })

  test('TaskCreate and TaskUpdate build the list too; a deleted task leaves it', () => {
    let list = applyTaskCall(undefined, { tool: 'TaskCreate', input: { subject: 'Write the model', description: '' }, result: { task: { id: '1', subject: 'Write the model' } }, isError: false }, 1, T0)
    list = applyTaskCall(list, { tool: 'TaskCreate', input: { subject: 'Draw the band', description: '' }, result: { task: { id: '2', subject: 'Draw the band' } }, isError: false }, 1, T0)
    list = applyTaskCall(list, { tool: 'TaskCreate', input: { subject: 'Scratch', description: '' }, result: { task: { id: '3', subject: 'Scratch' } }, isError: false }, 1, T0)
    list = applyTaskCall(list, { tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, result: { success: true, taskId: '1', updatedFields: ['status'] }, isError: false }, 2, T0)
    list = applyTaskCall(list, { tool: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' }, result: { success: true, taskId: '2', updatedFields: ['status'] }, isError: false }, 2, T0)
    list = applyTaskCall(list, { tool: 'TaskUpdate', input: { taskId: '3', status: 'deleted' }, result: { success: true, taskId: '3', updatedFields: ['status'] }, isError: false }, 2, T0)
    // A failed call changes nothing.
    list = applyTaskCall(list, { tool: 'TaskUpdate', input: { taskId: '2', status: 'completed' }, isError: true }, 2, T0)
    const p = progressOf(list)
    expect(p).toMatchObject({ done: 1, total: 2, isCurrentRunning: true, isComplete: false })
    expect(p?.current?.title).toBe('Draw the band')
  })

  test('a finished list stays until a later turn starts; then the hero shows the turn phase', () => {
    let c = newCockpit(T0, 's')
    c = onTurnStart(c, { at: T0, turnId: 't1', text: 'go' })
    c = onToolEnd(onToolStart(c, { at: T0, id: 'a', tool: 'TodoWrite', input: { todos: [{ content: 'One thing', status: 'completed', activeForm: 'Doing it' }] } }), {
      at: T0,
      id: 'a',
      tool: 'TodoWrite',
      input: { todos: [{ content: 'One thing', status: 'completed', activeForm: 'Doing it' }] },
      outcome: 'ok',
      text: 'ok',
    })
    expect(isListLive(c.tasks, 1)).toBe(true)
    expect(isListLive(c.tasks, 2)).toBe(false)
    const ctx = { now: T0 + 60_000, locale: 'en' as const, days: [], today: '2026-10-11' }
    const face = heroFace(readingsOf(c, ctx), 40)
    expect(plain(face.lines[0])).toContain('All 1 done')
    expect(face.digits?.text).toBe('1/1')
  })

  test('with no task list the hero shows what the turn is doing, and no clock: no big digits at all', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await $.turn.start({ text: 'look at it', turnId: 'live' })
    await call($, w, { tool: 'Read', file_path: '/work/src/band.tsx' })
    await call($, w, { tool: 'Bash', command: 'git status' })
    await w.clock.advance(MINUTE)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: /Thinking/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'turn 1 · 2 tools' })).toBeDefined()
    // Claude Code's spinner shows the turn's clock just above: the band shows none, big or small.
    for (const clock of ['1:03', '0:00']) {
      const [top] = blockDigits(clock)
      expect(await ui.find({ type: 'Text', text: top })).toBeUndefined()
    }
    expect(await ui.find({ type: 'Text', text: /\b\d+:\d\d\b/ })).toBeUndefined()
    await ui.unmount()
    // Between turns, the last one at minute resolution.
    const between = readingsOf(onTurnEnd(onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' }), { at: T0 + 4 * MINUTE + 25_000, turnId: 't', tokens: 10, durationMs: 0, isAborted: false }), { now: T0 + 6 * MINUTE, locale: 'en', days: [], today: '2026-10-11' })
    const idle = heroFace(between)
    expect(idle.digits).toBeUndefined()
    expect(plain(idle.lines[1])).toBe('last turn 4m · 0 tools · 1 min ago')
    // A narrow tile drops the age whole rather than cutting it, then the tools.
    expect(plain(heroFace(between, 30).lines[1])).toBe('last turn 4m · 0 tools')
    expect(plain(heroFace(between, 20).lines[1])).toBe('last turn 4m')
  })

  test('the time left is the median of the finished tasks times the tasks open, less the running one\'s time', () => {
    const write = (list: TaskList | undefined, at: number, statuses: ('pending' | 'in_progress' | 'completed')[]) =>
      applyTaskCall(list, { tool: 'TodoWrite', input: { todos: ['A', 'B', 'C', 'D'].map((content, i) => ({ content, status: statuses[i], activeForm: content })) }, isError: false }, 1, at)
    let list = write(undefined, T0, ['in_progress', 'pending', 'pending', 'pending'])
    list = write(list, T0 + 4 * MINUTE, ['completed', 'in_progress', 'pending', 'pending'])
    // One finished task is no pace yet.
    expect(timeLeft(list, T0 + 5 * MINUTE)).toBeUndefined()
    list = write(list, T0 + 10 * MINUTE, ['completed', 'completed', 'in_progress', 'pending'])
    expect(list?.items.map(t => [t.startedAt, t.doneAt])).toEqual([
      [T0, T0 + 4 * MINUTE],
      [T0 + 4 * MINUTE, T0 + 10 * MINUTE],
      [T0 + 10 * MINUTE, undefined],
      [undefined, undefined],
    ])
    // A took 4 min and B 6: 5 min a task, two open, C 2 min in: 8 min left.
    expect(timeLeft(list, T0 + 12 * MINUTE)).toBe(8 * MINUTE)
    // Overrun: no estimate rather than a negative one.
    expect(timeLeft(list, T0 + 25 * MINUTE)).toBeUndefined()
    const r = readingsOf({ ...newCockpit(T0, 's'), tasks: list, turnCount: 1 }, { now: T0 + 12 * MINUTE, locale: 'en', days: [], today: '2026-10-11' })
    const hero = heroFace(r, 40)
    expect(hero.digits?.text).toBe('2/4')
    expect(plain(hero.lines[0])).toBe('▸ C')
    expect(plain(hero.lines[1])).toMatch(/^▰+▱+ ~8m left$/)
    // Done: no estimate, the meter full and green.
    list = write(list, T0 + 20 * MINUTE, ['completed', 'completed', 'completed', 'completed'])
    expect(timeLeft(list, T0 + 20 * MINUTE)).toBeUndefined()
  })

  test('the band redraws every 30 seconds, not every second, while a turn runs', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await $.turn.start({ text: 'go', turnId: 'live' })
    const before = w.invalidates
    await w.clock.advance(20_000)
    expect(w.invalidates - before).toBe(0)
    await w.clock.advance(41_000)
    expect(w.invalidates - before).toBe(2)
  })

  test("what the turn is doing: Claude's own description of a command as written, a bare command as running", () => {
    const at = T0
    expect(phaseText({ kind: 'tool', tool: 'Bash', subject: 'Run wait.py with 120 (run 1 of 5)', since: at }, 'en')).toBe('Run wait.py with 120 (run 1 of 5)')
    expect(phaseText({ kind: 'tool', tool: 'Bash', subject: 'pnpm test', since: at }, 'en')).toBe('Running pnpm test')
    expect(phaseText({ kind: 'tool', tool: 'Bash', subject: 'pnpm test', since: at }, 'ko')).toBe('실행 중: pnpm test')
  })

  test('a question or a plan put to the person reads as one, never as the tool name', () => {
    const at = T0
    expect(phaseText({ kind: 'tool', tool: 'AskUserQuestion', subject: 'Which colour should I use?', since: at }, 'en')).toBe('Asking you: Which colour should I use?')
    expect(phaseText({ kind: 'tool', tool: 'AskUserQuestion', since: at }, 'en')).toBe('Asking you a question')
    expect(phaseText({ kind: 'tool', tool: 'ExitPlanMode', since: at }, 'en')).toBe('Showing you the plan')
    expect(phaseText({ kind: 'tool', tool: 'AskUserQuestion', subject: '어떤 색?', since: at }, 'ko')).toBe('질문: 어떤 색?')
    expect(phaseText({ kind: 'tool', tool: 'ExitPlanMode', since: at }, 'ko')).toBe('계획을 보여주는 중')
  })
})
