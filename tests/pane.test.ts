import { describe, expect, test } from 'claude-code/testing'

import { newCockpit, onReading, onToolEnd, onToolStart, onTurnEnd, onTurnStart, type AgentRun, type Cockpit } from '../src/model'
import { parseCommand } from '../src/commands'
import { estimate } from '../src/eta'
import { instrumentIds, instrumentOf } from '../src/instruments'
import { cellOf, historyRows, overviewPlan } from '../src/panes'
import type { Task } from '../src/progress'
import { filesText, readingsOf } from '../src/tiles'
import { axisLabels, timeSection } from '../src/timeline'
import { topSection } from '../src/top'
import { lineWidth, plain } from '../src/text'
import { at, command, EN, HOUR, MINUTE, PANE, start, turn, world } from './kit'

const T0 = at(2026, 10, 11, 16, 0)

const paneAt = (bodyColumns: number) => ({ ...PANE, props: { ...PANE.props, bodyColumns } })

/** A session 45 minutes in: 7 tasks, 3 done and one running; three subagents. */
function shift(): Cockpit {
  const task = (i: number, title: string, status: Task['status'], from?: number, to?: number): Task => ({
    id: `todo-${i}`,
    title,
    status,
    ...(from !== undefined ? { startedAt: T0 + from * MINUTE } : {}),
    ...(to !== undefined ? { doneAt: T0 + to * MINUTE } : {}),
  })
  const agents: AgentRun[] = [
    { id: 'a1', type: 'Explore', description: 'Map settings', startedAt: T0 + 1 * MINUTE, endedAt: T0 + 3.5 * MINUTE, status: 'done', tokens: 412_000, durationMs: 151_000, toolUses: 23 },
    { id: 'a2', type: 'Review', description: 'Re-check toggle', startedAt: T0 + 16 * MINUTE, endedAt: T0 + 22 * MINUTE, status: 'done', tokens: 139_000, durationMs: 353_000, toolUses: 41, added: 120, removed: 30 },
    { id: 'a3', type: 'general', description: 'B7 pre-flight', startedAt: T0 + 30 * MINUTE, status: 'background', agentId: 'bg-1', isBackground: true },
  ]
  let c: Cockpit = {
    ...newCockpit(T0, 's'),
    sessionStartedAt: T0 - 15 * MINUTE,
    agents,
    tasks: {
      source: 'todo',
      turn: 3,
      updatedAt: T0,
      items: [
        task(0, 'Add a theme context', 'completed', 0, 4.2),
        task(1, 'Wire the toggle into Settings', 'completed', 4.2, 13.9),
        task(2, 'Persist the choice', 'completed', 13.9, 18.4),
        task(3, 'Write tests', 'in_progress', 43),
        task(4, 'Update the docs', 'pending'),
        task(5, 'Bump the version', 'pending'),
        task(6, 'Ship it', 'pending'),
      ],
    },
  }
  for (let i = 0; i < 3; i++) {
    c = onTurnStart(c, { at: T0 + i * 10 * MINUTE, turnId: `t${i}`, text: 'go' })
    c = onTurnEnd(c, { at: T0 + i * 10 * MINUTE + 8 * MINUTE, turnId: `t${i}`, tokens: 1000, durationMs: 8 * MINUTE, isAborted: false })
  }
  return { ...c, turnCount: 3, reading: { at: T0, costUsd: 5.3 } }
}

describe('the pane', () => {
  test('the instruments in pairs: pace|5h, context|cost, checks|files, health|session, then the subagents once one ran; full two across from 69 columns, small from 55, then compact cells or a line each', EN, async ($, on) => {
    const view = { now: T0, locale: 'en' as const, days: [], today: '2026-10-11' }
    const fresh = readingsOf(newCockpit(T0, 's'), view)
    expect(instrumentIds(fresh)).toEqual(['pace', 'five', 'context', 'cost', 'checks', 'files', 'health', 'session'])
    expect(instrumentIds(readingsOf(shift(), view))).toEqual(['pace', 'five', 'context', 'cost', 'checks', 'files', 'health', 'session', 'agents'])
    // Sized to the pane: the largest form whose rows fit, progress kept whole as long as the instruments stay instruments.
    const plan = (width: number, rows: number) => {
      const p = overviewPlan(fresh, width, rows)
      return `${p.top} ${p.form} ${p.across}`
    }
    expect([plan(96, 43), plan(80, 43), plan(69, 43), plan(68, 43), plan(56, 43), plan(54, 43)]).toEqual(['full full 2', 'full full 2', 'full full 2', 'full small 2', 'full small 2', 'full compact 2'])
    // Fewer rows, a list running with its pond on top and a ninth instrument for the subagents: the instruments get
    // smaller, then progress gives way to its line, then compact cells, then progress whole over a line an instrument;
    // in an inline pane's 11 rows, progress as a line too.
    const busy = readingsOf(shift(), { ...view, now: T0 + 45 * MINUTE })
    const rows = (width: number, n: number) => {
      const p = overviewPlan(busy, width, n)
      return `${p.top} ${p.form} ${p.across}`
    }
    expect([rows(80, 43), rows(80, 30), rows(80, 24), rows(80, 20), rows(80, 11), rows(160, 11), rows(56, 11)]).toEqual(['full full 2', 'line small 2', 'line compact 2', 'full lines 2', 'line lines 2', 'line lines 2', 'line lines 1'])
    const w = world(on, { now: T0, usage: { ctxTokens: 24_000, ctxPct: 12 } })
    await start($, w)
    await turn($, w)
    await command($, '')
    const rule = async (bodyColumns: number) => {
      const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...paneAt(bodyColumns) })
      // The rules between the rows of instruments run the pane's whole width (the view bar's rule is another).
      const found = (await pane.findAll({ type: 'Text', text: /^─+([┼┴]─+)*$/ })).map(el => el.text).filter(text => text.length >= bodyColumns - 1)
      expect(await pane.find({ type: 'Text', text: 'HEALTH' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: 'COST' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '5H WINDOW' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: 'PROGRESS' })).toBeUndefined()
      expect(await pane.find({ type: 'Text', text: 'LIMITS' })).toBeUndefined()
      await pane.unmount()
      return found
    }
    // Eight instruments two across: three rules between four rows, every one a crossing.
    const wide = await rule(96)
    expect(wide).toHaveLength(3)
    expect(wide.every(line => line.split('┼').length === 2)).toBe(true)
    const middle = await rule(70)
    expect(middle).toHaveLength(3)
    // Too narrow for two compact cells: one across, a rule between each.
    const narrow = await rule(46)
    expect(narrow[0]).not.toContain('┼')
    expect(narrow).toHaveLength(7)
  })

  test('TIME, TASKS and SUBAGENTS: the session in plain words, each task and subagent on one time axis', () => {
    const now = T0 + 45 * MINUTE
    const lines = timeSection(shift(), now, 'en', 110, undefined, estimate(shift(), now)).map(plain)
    expect(lines[0]).toBe('TIME   elapsed 1h00 · working 24m · 3 turns · $5.30')
    // Joined late (a reload, a resume): the session's elapsed time and cost are whole, the rest is since quackpit watched.
    const late = timeSection({ ...shift(), joinedLate: true }, T0 + 45 * MINUTE, 'en', 110).map(plain)
    expect(late[0]).toBe('TIME   elapsed 1h00 · $5.30 · since 16:00: working 24m · 3 turns')
    // From the first start to the expected end of the whole: the running task 4.5 minutes (the median)
    // after it began, then the three still to come at 4.5 minutes each, at 17:01.
    expect(lines[1]).toMatch(/^ {42}│16:00 +16:30 +17:01│$/)
    // The estimate is the top section's, said once: here the tasks still to come are drawn where it expects them.
    const top = topSection(readingsOf(shift(), { now, locale: 'en', days: [], today: '2026-10-11' }), 96)
    expect(top.pond?.words.map(plain)).toEqual(['~16m left', 'done ~17:01'])
    // The background agent with no usual length runs on with no expected end: listed, adding nothing.
    expect(top.under.map(plain)).toEqual(["4 open, ~5m each · at this list's pace", 'general · running 15m, no usual length yet'])
    expect(lines.some(line => line.startsWith('ETA'))).toBe(false)
    expect(lines[2]).toBe('TASKS  3 of 7 done')
    expect(lines[3]).toMatch(/^ ✓ Add a theme context +4m12  │█+[▏▎▍▌▋▊▉]? +│$/)
    expect(lines[6]).toMatch(/^ ▸ Write tests +2m…  │ +[▕▐]?█*[▏▎▍▌▋▊▉]?░+ *│$/)
    // A task still to come: where it should run, all in the light shade, and how long.
    expect(lines[7]).toMatch(/^ · Update the docs +~5m  │ +░+ *│$/)
    expect(lines.some(line => line.startsWith('SUBAGENTS  1 running · 2 done'))).toBe(true)
    expect(lines.find(line => line.includes('Explore · Map settings'))).toMatch(/2m31 +│.*│ 412k · 23 tools$/)
    expect(lines.find(line => line.includes('Review · Re-check toggle'))).toMatch(/│ 139k · 41 tools · \+120 −30$/)
  })

  test('a background subagent shows "background", never a token count, running or done', () => {
    const c = shift()
    const running = timeSection(c, T0 + 45 * MINUTE, 'en', 110).map(plain).find(line => line.includes('B7 pre-flight'))
    expect(running).toMatch(/15m… +│.*│ background · no usual length yet$/)
    const done = { ...c, agents: c.agents.map(a => (a.id === 'a3' ? { ...a, status: 'done' as const, endedAt: T0 + 44 * MINUTE } : a)) }
    const finished = timeSection(done, T0 + 45 * MINUTE, 'en', 110).map(plain).find(line => line.includes('B7 pre-flight'))
    expect(finished).toMatch(/│ background$/)
    expect(finished).not.toMatch(/\d+k/)
  })

  test('long lists fold: tasks around the one running, finished subagents into one line', () => {
    const c = shift()
    const many: Cockpit = {
      ...c,
      tasks: c.tasks && { ...c.tasks, items: [...c.tasks.items, ...Array.from({ length: 6 }, (_, i): Task => ({ id: `x${i}`, title: `Later ${i}`, status: 'pending' }))] },
      agents: [...c.agents, ...Array.from({ length: 6 }, (_, i): AgentRun => ({ id: `d${i}`, type: 'Explore', description: `Done ${i}`, startedAt: T0 + i * MINUTE, endedAt: T0 + i * MINUTE + 30_000, status: 'done' }))],
    }
    const lines = timeSection(many, T0 + 45 * MINUTE, 'en', 110).map(plain)
    const taskRows = lines.slice(lines.indexOf('TASKS  3 of 13 done') + 1, lines.findIndex(line => line.startsWith('SUBAGENTS')))
    expect(taskRows.filter(line => /^ [✓▸·] /.test(line))).toHaveLength(6)
    expect(taskRows.at(-1)).toBe('   +7 more')
    expect(lines).toContain('   Finished · 3')
    // A narrow pane keeps names and lengths and drops the axis.
    const narrow = timeSection(c, T0 + 45 * MINUTE, 'en', 50).map(plain)
    expect(narrow.some(line => line.includes('│'))).toBe(false)
    expect(narrow.find(line => line.includes('Add a theme'))).toMatch(/4m12/)
  })

  test("the pane's words fit a narrow dock: the limits meter gives way, the turns' prompts are cut, counts are singular", EN, async ($, on) => {
    const view = { now: T0, locale: 'en' as const, days: [], today: '2026-10-11' }
    // A 75-column dock: the account dial's cell of 36, 22 columns beside the dial. The week runs out before its reset.
    const read = onReading(newCockpit(T0, 's'), { at: T0, fiveHour: { pct: 4, resetsAt: T0 + 3 * HOUR + 49 * MINUTE }, sevenDay: { pct: 24, resetsAt: T0 + 146 * HOUR } })
    const account = instrumentOf(readingsOf(read, view), 'five', 36, 'full')
    // Its long form fits 22 columns; in a small instrument's 16 the short one does.
    expect(plain(account.words.at(-1) ?? [])).toBe('7d runs out in ~2d21h')
    for (const line of account.words) expect(lineWidth(line)).toBeLessThanOrEqual(22)
    const small = instrumentOf(readingsOf(read, view), 'five', 26, 'small')
    expect(plain(small.words.at(-1) ?? [])).toBe('7d out in ~2d21h')
    // A turn's row takes the pane's width, its prompt what is left of it, and none past too little.
    const text = 'Run `node --test`, fix the failing test by correcting sum.js, then run it again.'
    const one = onTurnEnd(onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text }), { at: T0 + MINUTE, turnId: 't', tokens: 31_000, durationMs: MINUTE, isAborted: false })
    const rows = (width: number) => historyRows(readingsOf(one, view), width).rows.map(row => plain(row.line))
    expect(rows(74)[0]).toMatch(/ {2}Run `node --test`, fi…$/)
    expect(rows(74)[0]?.length).toBe(74)
    expect(rows(55)[0]).not.toContain('Run')
    expect(rows(100)[0]).toMatch(/ {2}Run `node --test`, fix the failing test…$/)
    expect([filesText(1, 1, 'en'), filesText(3, 7, 'en')]).toEqual(['1 file · 1 edit', '3 files · 7 edits'])
    const compacted = (n: number) => plain(cellOf(readingsOf({ ...read, compactions: n }, view), 'context', 36).lines[1])
    // After a compaction the fill is unknown until the next response says it.
    expect([compacted(1), compacted(2)]).toEqual(['no reading yet · ⟲1', 'no reading yet · ⟲2'])
    const w = world(on, { now: T0 })
    await start($, w)
    await turn($, w)
    await command($, 'view turns')
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...paneAt(74) })
    expect(await pane.find({ type: 'Text', text: 'LAST TURN' })).toBeDefined()
    await pane.unmount()
  })

  test("once the band differs from the settings, the pane offers to reset it, and the button puts the six tiles back", EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await command($, 'view band')
    let pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    // As installed, there is nothing to reset.
    expect(await pane.find({ type: 'Button', key: 'pane-reset' })).toBeUndefined()
    await pane.unmount()
    await command($, 'remove progress')
    await command($, 'add files')
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Button', key: 'pane-rm-progress' })).toBeUndefined()
    await pane.press({ key: 'pane-reset' })
    expect(w.toasts.at(-1)).toBe('The band is back to its default: progress, pace, context, limits, checks, cost, 2 rows, the duck on.')
    await pane.unmount()
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Button', key: 'pane-rm-progress' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'pane-rm-files' })).toBeUndefined()
    expect(await pane.find({ type: 'Button', key: 'pane-reset' })).toBeUndefined()
    await pane.unmount()
  })

  test('/quackpit help opens the pane on its guide, what each part means beside the real gauges, until another view is brought up', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await command($, 'help')
    expect(w.opened.at(-1)?.id).toBe('quackpit')
    let pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    // The guide's press is the open one: bold, where the focus ring starts.
    expect((await pane.find({ type: 'Button', key: 'pane-view-guide' }))?.props).toMatchObject({ hotkey: '6', autoFocus: true })
    expect(await pane.find({ type: 'Text', text: /duckling crossing the time the work/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Wakes and says Quack: on a failed check/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Six views: the overview/ })).toBeDefined()
    await pane.press({ key: 'pane-view-timeline' })
    await pane.unmount()
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: /duckling crossing/ })).toBeUndefined()
    await pane.unmount()
    // `?` and `guide` say the same; a word that is no command still answers with the list of commands.
    expect([parseCommand('?'), parseCommand('guide'), parseCommand('nonsense')]).toEqual([{ kind: 'guide' }, { kind: 'guide' }, { kind: 'help' }])
  })

  test('the pane asks for a dock that leaves the transcript 70 columns, and 12 rows inline', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await $.command.run({ command: 'quackpit', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await $.command.run({ command: 'quackpit', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await $.command.run({ command: 'quackpit', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    expect(w.opened.map(p => [p.columns, p.rows])).toEqual([
      [75, 12],
      [56, 12],
    ])
  })

  test("the history's time is the turn's worked time: a wait on the person is left out", () => {
    // Three minutes on the clock, 82 seconds of them on a question: Claude Code reports 1m 38s.
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
    c = onTurnEnd(c, { at: T0 + 3 * MINUTE, turnId: 't', tokens: 10, durationMs: 98_000, isAborted: false })
    const rows = historyRows(readingsOf(c, { now: T0 + 4 * MINUTE, locale: 'en', days: [], today: '2026-10-11' })).rows
    expect(plain(rows[0]!.line)).toContain('1m 38s')
    expect(plain(rows[0]!.line)).not.toContain('3m 00s')
  })

  test("a turn in the pane's history scrolls the transcript to its first tool row when pressed", EN, async ($, on) => {
    // Each turn keeps its first tool call's id: the transcript row's own requestId.
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
    for (const id of ['toolu_a', 'toolu_b']) {
      const call = { at: T0, id, tool: 'Read', input: { file_path: `/work/${id}.ts` } }
      c = onToolEnd(onToolStart(c, call), { ...call, outcome: 'ok', text: 'ok' })
    }
    c = onTurnEnd(c, { at: T0 + MINUTE, turnId: 't', tokens: 10, durationMs: MINUTE, isAborted: false })
    c = onTurnEnd(onTurnStart(c, { at: T0 + 2 * MINUTE, turnId: 'u', text: 'hi' }), { at: T0 + 3 * MINUTE, turnId: 'u', tokens: 10, durationMs: MINUTE, isAborted: false })
    const rows = historyRows(readingsOf(c, { now: T0 + 4 * MINUTE, locale: 'en', days: [], today: '2026-10-11' })).rows
    expect(rows.map(row => [row.n, row.target])).toEqual([
      [2, undefined],
      [1, 'toolu_a'],
    ])
    // In a session: the turn with a tool row is a button; a press asks Claude Code to scroll there
    // (the kit has no transcript, so it declines, and the pane says so).
    const w = world(on, { now: T0 })
    await start($, w)
    await command($, 'view turns')
    await turn($, w, { prompt: 'look', tools: [{ tool: 'Read', file_path: '/work/a.ts' }] })
    await turn($, w)
    const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Button', key: 'pane-turn-2' })).toBeUndefined()
    await pane.press({ key: 'pane-turn-1' })
    expect(w.toasts.at(-1)).toBe('That turn is not in the transcript on screen to scroll to.')
    await pane.unmount()
  })

  test("the time axis says each clock time once: an axis of a few minutes names its two ends, or its one minute", () => {
    expect(axisLabels({ from: T0, to: T0 + 40 * MINUTE, width: 30 })).toBe('│16:00       16:20        16:40│')
    // 16:00:10 to 16:01:50: its middle is 16:01 again, said once.
    expect(axisLabels({ from: T0 + 10 * 1000, to: T0 + 110 * 1000, width: 30 })).toBe('│16:00                    16:01│')
    expect(axisLabels({ from: T0, to: T0 + 50 * 1000, width: 20 })).toBe('│16:00               │')
    // Found live: a session whose only stretch on the axis was a wait on the person drew it with no times over it.
    const waited: Cockpit = { ...newCockpit(T0, 's'), waits: [{ from: T0 + MINUTE, to: T0 + 2 * MINUTE, kind: 'question', tool: 'AskUserQuestion', main: true }] }
    const lines = timeSection(waited, T0 + 3 * MINUTE, 'en', 110).map(plain)
    const row = lines.findIndex(line => line.includes('⏸ waiting on you'))
    expect(row).toBeGreaterThan(0)
    expect(lines.slice(0, row).some(line => /│16:0\d.*│$/.test(line.trim()))).toBe(true)
  })
})
