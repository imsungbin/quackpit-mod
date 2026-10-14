import { describe, expect, test, type Engine } from 'claude-code/testing'

import { estimate } from '../src/eta'
import { newCockpit, onAgentSpawn, onAgentTurnEnd, onStepStart, onToolEnd, onToolStart, onTurnEnd, onTurnStart, onWaitStart, turnWorkMs, type Cockpit } from '../src/model'
import { readingsOf } from '../src/tiles'
import { topSection } from '../src/top'
import { plain } from '../src/text'
import { addRun } from '../src/jobs'
import { activeMs, endWaits, heldMs, MAX_WAITS, startWait, waitingNow, type Wait } from '../src/waits'
import { at, band, bash, EN, HOUR, LIMIT_MS, MINUTE, PANE, start, step, usage, world } from './kit'

const T0 = at(2026, 10, 13, 10)
const S = 1000
const view = (now: number, L: 'en' | 'ko' = 'en') => ({ now, locale: L, days: [], today: '2026-10-13' })

/** A TodoWrite of these items, started and answered at `at`. */
function todo(c: Cockpit, at: number, items: [string, 'pending' | 'in_progress' | 'completed'][]): Cockpit {
  const id = `todo-${at}`
  const input = { todos: items.map(([content, status]) => ({ content, status, activeForm: content })) }
  const started = onToolStart(c, { at, id, tool: 'TodoWrite', input })
  return onToolEnd(started, { at, id, tool: 'TodoWrite', input, outcome: 'ok', text: 'ok', result: {} })
}

/** A list of four tasks, the first two done three minutes each, the third running since 6:00. */
function listAtSix(): Cockpit {
  let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'Build it' })
  c = todo(c, T0, [['A', 'in_progress'], ['B', 'pending'], ['C', 'pending'], ['D', 'pending']])
  c = todo(c, T0 + 3 * MINUTE, [['A', 'completed'], ['B', 'in_progress'], ['C', 'pending'], ['D', 'pending']])
  return todo(c, T0 + 6 * MINUTE, [['A', 'completed'], ['B', 'completed'], ['C', 'in_progress'], ['D', 'pending']])
}

const question = { questions: [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Red' }, { label: 'Blue' }] }] }

describe('waits on the person', () => {
  test('the ledger: held time counts overlapping waits once, an open wait up to now, and only the clock it holds', () => {
    const waits: Wait[] = [
      { from: 10, to: 20, kind: 'question', main: true },
      { from: 15, to: 30, kind: 'permission', main: true },
      { from: 50, kind: 'permission', main: false, agentId: 'a1' },
    ]
    expect(heldMs(waits, 0, 100)).toBe(20)
    expect(heldMs(waits, 12, 18)).toBe(6)
    expect(heldMs(waits, 0, 100, { agentId: 'a1' })).toBe(50)
    expect(activeMs(waits, 0, 100)).toBe(80)
    expect(waitingNow(waits)).toBeUndefined()
    expect(waitingNow(waits, { agentId: 'a1' })?.from).toBe(50)
    // Closing by call, by loop, or all; the closed ones past the limit are dropped, never an open one.
    expect(endWaits(waits, { agentId: 'a1' }, 70).at(-1)?.to).toBe(70)
    let many: Wait[] = []
    for (let i = 0; i < MAX_WAITS + 5; i++) many = startWait(many, { from: i, to: i + 0.5, kind: 'question', main: true })
    many = startWait(many, { from: 999, kind: 'plan', main: true })
    expect(many).toHaveLength(MAX_WAITS + 1)
    expect(many.at(-1)?.to).toBeUndefined()
  })

  test("a question waits on the person: the top says so, nothing counts down, and every end moves on by the wait's length", () => {
    let c = listAtSix()
    // At 6:00 the running task (3 minutes each) should end at 9:00 and the last at 12:00.
    expect(estimate(c, T0 + 6 * MINUTE)?.endsAt).toBe(T0 + 12 * MINUTE)
    c = onToolStart(c, { at: T0 + 7 * MINUTE, id: 'ask', tool: 'AskUserQuestion', input: question })
    expect(waitingNow(c.waits)?.kind).toBe('question')
    // While it waits, the time left stands still and so does the duck.
    const a = estimate(c, T0 + 7 * MINUTE + 30 * S)
    const b = estimate(c, T0 + 8 * MINUTE + 5 * S)
    expect(b?.leftMs).toBe(a?.leftMs)
    expect(b?.fraction).toBe(a?.fraction)
    for (const [L, wait, why] of [
      ['en', '⏸ waiting on you · 1m05', 'Claude asked you a question: nothing counts down until you answer'],
      ['ko', '⏸ 답을 기다리는 중 · 1m05', 'Claude가 질문했어요: 답할 때까지 아무것도 줄지 않아요'],
    ] as const) {
      const top = topSection(readingsOf(c, view(T0 + 8 * MINUTE + 5 * S, L)), 96)
      expect(plain(top.pond?.words[0] ?? []), L).toBe(wait)
      // The running task had worked a minute of its three, the last one three more: 5 minutes, held.
      expect(plain(top.pond?.words[1] ?? []), L).toBe(L === 'en' ? 'paused at ~5m left' : '~5m 남은 채 멈춤')
      expect(top.under.map(plain), L).toContain(why)
      // With a list the head stays the task running; the line under says what the turn waits on.
      expect(plain(top.head), L).toMatch(/^▸ C /)
    }
    // Answered at 9:00, after 2 minutes: the running task and the one after it end 2 minutes later.
    c = onToolEnd(c, { at: T0 + 9 * MINUTE, id: 'ask', tool: 'AskUserQuestion', input: question, outcome: 'ok', text: 'answered', result: {} })
    expect(waitingNow(c.waits)).toBeUndefined()
    expect(estimate(c, T0 + 9 * MINUTE)?.endsAt).toBe(T0 + 14 * MINUTE)
    // The task finishes at 10:00: 4 minutes from its start, 2 of them waiting: its length is 2 minutes.
    c = todo(c, T0 + 10 * MINUTE, [['A', 'completed'], ['B', 'completed'], ['C', 'completed'], ['D', 'in_progress']])
    expect(c.tasks?.items[2]?.heldMs).toBe(2 * MINUTE)
    expect(c.durations.tasks.at(-1)).toBe(2 * MINUTE)
    // The turn's working time leaves the wait out, as Claude Code's own turn length does.
    const ended = onTurnEnd(c, { at: T0 + 11 * MINUTE, turnId: 't', tokens: 100, durationMs: 9 * MINUTE, isAborted: false })
    expect(ended.activeMs).toBe(9 * MINUTE)
    expect(turnWorkMs({ waits: c.waits }, T0, T0 + 11 * MINUTE, undefined)).toBe(9 * MINUTE)
    // Its wait ended with it; none is left open.
    expect(ended.waits.every(w => w.to !== undefined)).toBe(true)
  })

  test('a background job runs on through a wait: beside the wait, its time left, never "paused"', () => {
    let c: Cockpit = { ...onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' }), meta: { root: '/work' } }
    const run = { at: T0, id: 'call-sh', tool: 'Bash', input: { command: 'make test-all', run_in_background: true } }
    c = onToolEnd(onToolStart(c, run), { ...run, at: T0 + 500, outcome: 'ok', text: 'running', result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'sh1' } })
    c = onToolStart(c, { at: T0 + MINUTE, id: 'q', tool: 'AskUserQuestion', input: question })
    // The command took 4 minutes last time: at 2:00, with a minute waited on the person, 2 minutes are left all the same.
    const lengths = addRun(undefined, '/work', 'make test-all', 4 * MINUTE, T0 - HOUR)
    const top = topSection(readingsOf(c, { ...view(T0 + 2 * MINUTE), lengths }), 70)
    expect(plain(top.pond?.words[0] ?? [])).toBe('⏸ waiting on you · 1m00')
    expect(plain(top.pond?.words[1] ?? [])).toBe('~2m left')
  })

  test("a subagent's dialog holds that agent, and the main loop too only while it waits on that agent in the foreground", () => {
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
    const input = { description: 'Map the parser', subagent_type: 'Explore', prompt: 'map' }
    c = onToolStart(c, { at: T0, id: 'call-1', tool: 'Agent', input })
    c = onAgentSpawn(c, { at: T0, toolUseId: 'call-1', agentId: 'fg', type: 'Explore', description: 'Map the parser', background: false, by: 'main' })
    c = onWaitStart(c, { at: T0 + MINUTE, kind: 'permission', tool: 'Bash', agentId: 'fg', agentType: 'Explore' })
    expect(waitingNow(c.waits)?.agentId).toBe('fg')
    c = onAgentTurnEnd(c, { at: T0 + 3 * MINUTE, agentId: 'fg', isAborted: false })
    expect(waitingNow(c.waits)).toBeUndefined()
    // Its length leaves its own wait out: 3 minutes, 2 of them waiting.
    expect(c.agents[0]?.heldMs).toBe(2 * MINUTE)
    // A background agent's dialog holds it alone: the main loop's clock runs on.
    const bg = onAgentSpawn(onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' }), { at: T0, toolUseId: 'x', agentId: 'bg', type: 'Explore', description: 'Scan', background: true, by: 'main' })
    const held = onWaitStart(bg, { at: T0 + MINUTE, kind: 'permission', tool: 'Bash', agentId: 'bg', agentType: 'Explore' })
    expect(waitingNow(held.waits)).toBeUndefined()
    expect(waitingNow(held.waits, { agentId: 'bg' })).toBeDefined()
    // The pane says it aside: the rest goes on.
    const top = topSection(readingsOf(held, view(T0 + MINUTE + 40 * S)), 96)
    expect(top.under.map(plain)).toContain('⏸ Explore waits on you · 40s')
    // The loop's next request ends whatever dialog held it.
    expect(waitingNow(onStepStart(held, { at: T0 + 2 * MINUTE, agentId: 'bg' }).waits, { agentId: 'bg' })).toBeUndefined()
  })

  test('in a session: a question holds the turn, the band and the pane say so, the clock ticks each second, and the AI is not asked meanwhile', { options: { locale: 'en', aiEta: true }, timeoutMs: LIMIT_MS }, async ($, on) => {
    const w = world(on, { now: T0 })
    w.askUserMs = 3 * MINUTE
    await start($, w)
    await $.prompt.submit({ text: 'Pick a theme and apply it', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'Pick a theme and apply it', turnId: 't1' })
    await step($, w, 't1', usage(2000), 0, "I'll ask which theme you want.")
    await w.clock.advance(50 * S)
    const asked = $.tool.call({ tool: 'AskUserQuestion', ...question } as never)
    await w.clock.advance(65 * S)
    // 1:55 into the turn, 1:05 into the wait: the band and the pane say how long it has waited.
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: /⏸ waiting on you · 1m05/ })).toBeDefined()
    await ui.unmount()
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: 'Claude asked you a question: nothing counts down until you answer' })).toBeDefined()
    await pane.unmount()
    // Its clock is the one thing that ticks: a redraw each second.
    const before = w.invalidates
    await w.clock.advance(3 * S)
    expect(w.invalidates - before).toBeGreaterThanOrEqual(3)
    // No call while the person is being waited on, though the turn is long past its minute.
    await w.clock.advance(MINUTE)
    expect(w.modelCalls).toEqual([])
    // Answered at 3:50: the turn has worked 50 seconds; the call comes once it has worked a minute, at 4:00.
    await w.clock.advance(55 * S)
    await asked
    expect(w.modelCalls).toEqual([])
    await w.clock.advance(12 * S)
    expect(w.modelCalls).toHaveLength(1)
    expect(w.modelCalls[0]?.prompt).toContain('This turn has worked 1m00 so far (time spent waiting on the person left out)')
    // The redraws slow back to the 30-second tick.
    const after = w.invalidates
    await w.clock.advance(10 * S)
    expect(w.invalidates - after).toBeLessThanOrEqual(1)
  })

  test("a permission dialog that really shows is a wait; an ask the auto-mode classifier settles, or a hook beneath answers, is none", EN, async ($, on) => {
    const w = world(on, { now: T0 })
    w.askMs = 90 * S
    w.dialog = true
    await start($, w)
    await $.turn.start({ text: 'Run the suite', turnId: 't1' })
    const ran = $.tool.call(bash('make test-all'))
    await w.clock.advance(60 * S)
    // Claude Code draws no band while a dialog shows (a band drawn is a dialog answered): the pane says so.
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: '⏸ waiting on you · 1m00' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Claude waits for your OK to use Bash: nothing counts down meanwhile' })).toBeDefined()
    await pane.unmount()
    // Approved at 1:30: the command's first progress ends the wait, before the command does.
    await w.clock.advance(31 * S)
    const id = w.calls.find(call => call.tool === 'Bash')?.id ?? ''
    const progress = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', component: 'ToolProgress', requestId: id, props: { tool_use_id: id, kind: 'background_hint', hint: '(ctrl+b to run in background)' } })
    await progress.unmount()
    await w.clock.settle()
    expect(await bandWord($)).toBeUndefined()
    await w.clock.advance(5 * S)
    await ran
    // The auto-mode classifier settles an ask with no dialog: no wait.
    w.dialog = false
    await $.turn.complete({ answer: 'done', durationMs: MINUTE, isAborted: false, turnId: 't1', reason: 'answer', usage: usage(10) })
    await $.turn.start({ text: 'Again', turnId: 't2' })
    const again = $.tool.call(bash('make test-all'))
    await w.clock.advance(60 * S)
    expect(await bandWord($)).toBeUndefined()
    await w.clock.advance(40 * S)
    await again
  })

  test("a subagent's permission dialog ends when Claude Code draws the band again: its call's progress is never drawn", EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await $.turn.start({ text: 'Map the code', turnId: 't1' })
    await $.tool.call({ tool: 'Agent', description: 'Map the parser', prompt: 'map', subagent_type: 'Explore', run_in_background: true } as never)
    await $.turn.complete({ answer: 'It runs in the background.', durationMs: 5 * S, isAborted: false, turnId: 't1', reason: 'answer', usage: usage(10) })
    // The agent's command asks: its dialog shows 40 seconds, then the command runs 2 minutes.
    w.askMs = 40 * S
    w.dialog = true
    w.bashMs = 2 * MINUTE
    const ran = $.tool.call({ ...bash('make test-all'), agentId: 'agent-1' } as never)
    await w.clock.advance(20 * S)
    expect(await paneWord($, /waits on you/)).toBe('⏸ Explore waits on you · 20s')
    // Answered at 0:40. A subagent's call draws no progress row; the band is drawn again, and that ends it.
    await w.clock.advance(20 * S)
    await bandWord($)
    await w.clock.settle()
    expect(await paneWord($, /waits on you/)).toBeUndefined()
    await w.clock.advance(2 * MINUTE)
    await ran
    await $.turn.complete({ answer: 'mapped', durationMs: 160 * S, isAborted: false, turnId: 'sub', reason: 'answer', usage: usage(10), agentId: 'agent-1' })
    await w.clock.settle()
    // Its length: 2m40 on the clock less the 40-second dialog, never less the command's 2 minutes too.
    expect(await paneWord($, /Explore · Map the parser/)).toMatch(/ 2m00 /)
  })

  test('a dialog a hook beneath settles shows nothing, and no wait begins', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    w.askMs = 60 * S
    w.dialog = true
    w.isSettledByHook = true
    await start($, w)
    await $.turn.start({ text: 'Run it', turnId: 't1' })
    const ran = $.tool.call(bash('pnpm test'))
    await w.clock.advance(30 * S)
    expect(await bandWord($)).toBeUndefined()
    await w.clock.advance(40 * S)
    await ran
  })
})

/** The band's wait words, if it shows any. */
/** The pane's Text matching `pattern`: in the overview, else in the timeline, where the agents and the waits are. */
async function paneWord($: Engine, pattern: RegExp): Promise<string | undefined> {
  let text: string | undefined
  for (const view of ['overview', 'timeline']) {
    let pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    await pane.press({ key: `pane-view-${view}` })
    await pane.unmount()
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    text = (await pane.find({ type: 'Text', text: pattern }))?.text?.trim()
    await pane.unmount()
    if (text !== undefined) break
  }
  return text
}

async function bandWord($: Engine): Promise<string | undefined> {
  const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
  const text = (await ui.find({ type: 'Text', text: /⏸/ }))?.text?.trim()
  await ui.unmount()
  return text
}

