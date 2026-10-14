import { describe, expect, test, type Engine } from 'claude-code/testing'

import { estimate } from '../src/eta'
import { instrumentOf, instrumentReading } from '../src/instruments'
import { addRun, listedKind, listedStatus, parseNotices, reconcileJobs, type Job, type ListedTask } from '../src/jobs'
import { asCockpit, newCockpit, onAgentList, onAgentSpawn, onAgentTurnEnd, onBackgroundTasks, onForeignTask, onNotices, onToolEnd, onToolStart, onTurnEnd, onTurnStart, type Cockpit } from '../src/model'
import { heroFace, readingsOf } from '../src/tiles'
import { summaryLine, topSection } from '../src/top'
import { plain } from '../src/text'
import { at, EN, MINUTE, PANE, start, usage, world } from './kit'

const T0 = at(2026, 10, 14, 1, 34)
const S = 1000
const HOUR = 60 * MINUTE
const view = (now: number, extra = {}) => ({ now, locale: 'en' as const, days: [], today: '2026-10-14', ...extra })

/**
 * The tasks a turn's end listed in a probe on Claude Code 2.1.296
 * (`classic.Stop`'s `background_tasks`): a teammate's task carries an id of
 * its own and stays `running` while the teammate idles; a background
 * subagent's carries its agent's id; a background shell; the Monitor tool's
 * command, listed as a shell; a workflow.
 */
/** A listed task as the Stop hook carries it: its status and description always there. */
type Listed = ListedTask & { status: string; description: string }
const TEAMMATE: Listed = { id: 'tcy4jkxas', type: 'teammate', status: 'running', description: 'Teammate helper' }
const SUBAGENT: Listed = { id: 'aae45142fec26598f', type: 'subagent', status: 'running', description: 'Background counter', agent_type: 'general-purpose' }
const SHELL: Listed = { id: 'bzrm1vy1k', type: 'shell', status: 'running', description: 'Sleep 400 seconds in background', command: 'sleep 400' }
const MONITOR: Listed = { id: 'by8nszpah', type: 'shell', status: 'running', description: 'ticks', command: 'for i in 1 2 3 4 5 6; do sleep 30; echo tick $i; done' }
const WORKFLOW: Listed = { id: 'weocfglpl', type: 'workflow', status: 'running', description: 'One small agent for a probe', name: 'probe-wf' }

/** Three translators, in-process teammates of the session's team, as the screenshot's session had them. */
function translators(c: Cockpit, at: number): Cockpit {
  let next = c
  for (const [i, lang] of ['Japanese', 'Simplified Chinese', 'Traditional Chinese'].entries()) {
    const id = `call-${i}`
    next = onToolStart(next, { at, id, tool: 'Agent', input: { name: `t${i}`, description: `Draft ${lang} locale table`, prompt: 'translate' } })
    next = onAgentSpawn(next, { at, toolUseId: id, agentId: `at${i}-translator`, type: 'teammate', description: `Draft ${lang} locale table`, background: true, by: 'main', isTeammate: true })
    next = onToolEnd(next, { at: at + S, id, tool: 'Agent', input: { name: `t${i}` }, outcome: 'ok', text: 'Spawned successfully.', result: { status: 'teammate_spawned', agentId: `at${i}-translator`, agent_id: `at${i}-translator`, teammate_id: `t${i}@session-3909cd68`, name: `t${i}` } })
  }
  return next
}

/** What the progress says (the band's hero, the pane's top and its one line) and what AGENTS says. */
function said(c: Cockpit, now: number, extra = {}) {
  const r = readingsOf(c, view(now, extra))
  const hero = heroFace(r, 48)
  const top = topSection(r, 80)
  const summary = summaryLine(r, 80)
  return {
    hero: hero.lines.map(plain).join(' | '),
    top: [plain(top.head), ...top.under.map(plain)].join(' | '),
    summary: plain([...summary.head, ...summary.tail]),
    agents: instrumentOf(r, 'agents', 39, 'full').words.map(plain),
    reading: plain(instrumentReading(r, 'agents')),
    running: r.work.agents.map(a => a.description),
  }
}

describe('teammates and background work: what runs, and what only waits', () => {
  test("a listed task's type and status, as Claude Code labels them: agent-like ones are the agents' list's, housekeeping nobody's", () => {
    expect(['shell', 'local_bash', 'subagent', 'teammate', 'in_process_teammate', 'cloud session', 'remote_agent', 'monitor', 'MCP task', 'workflow', 'dream', 'auto-mode scan', 'memory import', 'mystery'].map(listedKind)).toEqual(['shell', 'shell', 'agent', 'agent', 'agent', 'agent', 'agent', 'monitor', 'monitor', 'workflow', 'skip', 'skip', 'skip', 'other'])
    expect(['running', 'pending', 'waiting', 'idle', 'completed', 'failed', 'killed', undefined].map(listedStatus)).toEqual(['running', 'waiting', 'waiting', 'waiting', 'done', 'failed', 'killed', 'running'])
  })

  test('a turn\'s end lists a teammate as a task of its own, "running" while it idles: it is never a job, and the agents\' list says it idles', () => {
    let c = translators(onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't1', text: 'translate' }), T0)
    c = onTurnEnd(c, { at: T0 + MINUTE, turnId: 't1', tokens: 1000, durationMs: MINUTE, isAborted: false })
    // Each translator works, reports, and goes idle: its own turn's end, then the list.
    for (const i of [0, 1, 2]) c = onAgentTurnEnd(c, { at: T0 + 30 * MINUTE, agentId: `at${i}-translator`, isAborted: false })
    c = onAgentList(c, T0 + 31 * MINUTE, [0, 1, 2].map(i => ({ id: `at${i}-translator`, status: 'idle', type: 'teammate', description: 'x', teammateId: `t${i}@session-3909cd68` })))
    // Hours later, a turn's end lists them still: as teammates, with ids the agents never had, all "running".
    const listed: ListedTask[] = [0, 1, 2].map(i => ({ id: `tq${i}abcdef`, type: 'teammate', status: 'running', description: 'Draft locale table' }))
    c = onBackgroundTasks(c, T0 + 5 * HOUR, [...listed, SHELL])
    expect(c.jobs.map(j => j.id)).toEqual(['bzrm1vy1k'])
    expect(c.agents.filter(a => a.teammate).map(a => a.status)).toEqual(['idle', 'idle', 'idle'])
    // The progress and AGENTS agree: nothing of theirs runs; the teammates are one quiet line.
    const now = T0 + 5 * HOUR + MINUTE
    const s = said(c, now)
    expect(s.running).toEqual([])
    expect(s.agents[0]).toBe('none running')
    expect(s.agents[1]).toBe('3 teammates idle')
    expect(s.reading).toBe('none running · 3 teammates idle')
    expect(s.hero).not.toContain('Draft')
    expect(s.top).toContain('3 teammates idle')
    expect(s.top).not.toContain('Draft')
  })

  test("the screenshot's state, saved by an older build with the teammates as running jobs, clears by itself at the next turn's end; MODEL_VERSION stays", () => {
    // The older build kept each translator's task as a job of kind other, first seen at 03:07, running ever since.
    let c = translators(onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't1', text: 'translate' }), T0)
    c = onTurnEnd(c, { at: T0 + MINUTE, turnId: 't1', tokens: 1000, durationMs: MINUTE, isAborted: false })
    c = onAgentList(c, T0 + 90 * MINUTE, [0, 1, 2].map(i => ({ id: `at${i}-translator`, status: 'idle', type: 'teammate', description: 'x', teammateId: `t${i}@session-3909cd68` })))
    const stuck: Job[] = ['Japanese', 'Simplified Chinese', 'Traditional Chinese'].map((lang, i) => ({ id: `tstuck${i}xy`, kind: 'other', description: `Draft ${lang} locale table`, startedAt: T0 + 93 * MINUTE, status: 'running', isLate: true }))
    const saved = asCockpit(JSON.parse(JSON.stringify({ ...c, jobs: stuck })))
    expect(saved?.v).toBe(10)
    if (!saved) return
    // Read back, it still holds them: the first turn's end will say.
    const before = said(saved, T0 + 6 * HOUR + 39 * MINUTE)
    expect(before.top).toContain('Draft Japanese locale table')
    // The turn's end lists them as teammates: they were never jobs, and go.
    const listed = stuck.map((j): ListedTask => ({ id: j.id, type: 'teammate', status: 'running', description: j.description ?? '' }))
    const cleared = onBackgroundTasks(saved, T0 + 6 * HOUR + 40 * MINUTE, listed)
    expect(cleared.jobs).toEqual([])
    const after = said(cleared, T0 + 6 * HOUR + 41 * MINUTE)
    expect(after.top).not.toContain('Draft')
    expect(after.hero).not.toContain('Draft')
    expect(after.top).toContain('3 teammates idle')
    // Shut down instead (no longer listed): they ended unseen, and run no more.
    const gone = onBackgroundTasks(saved, T0 + 6 * HOUR + 40 * MINUTE, [])
    expect(gone.jobs.every(j => j.status === 'done' && j.isGone)).toBe(true)
    expect(said(gone, T0 + 6 * HOUR + 41 * MINUTE).top).not.toContain('Draft')
  })

  test('the listed status is honoured: a queued task waits, an ended word ends it with that outcome', () => {
    const shell: Job = { id: 'b1', kind: 'shell', command: 'make test-all', startedAt: T0, status: 'running', toolUseId: 'call-1' }
    expect(reconcileJobs([shell], [{ id: 'b1', type: 'shell', status: 'pending' }], T0 + MINUTE)[0]?.status).toBe('waiting')
    expect(reconcileJobs([shell], [{ id: 'b1', type: 'shell', status: 'failed' }], T0 + MINUTE)[0]).toMatchObject({ status: 'failed', endedAt: T0 + MINUTE })
    expect(reconcileJobs([{ ...shell, status: 'waiting' }], [{ id: 'b1', type: 'shell', status: 'running' }], T0 + MINUTE)[0]?.status).toBe('running')
    // One first seen queued joins waiting, never running; one first seen ended is nothing to show.
    expect(reconcileJobs([], [{ id: 'b2', type: 'shell', status: 'pending', command: 'pnpm build' }], T0)).toMatchObject([{ id: 'b2', status: 'waiting', isLate: true }])
    expect(reconcileJobs([], [{ id: 'b3', type: 'shell', status: 'completed' }], T0)).toEqual([])
    // A queued job is no work at it: it waits, a quiet line.
    const c = { ...newCockpit(T0, 's'), jobs: reconcileJobs([], [{ id: 'b2', type: 'shell', status: 'pending', command: 'pnpm build' }], T0) }
    const s = said(c, T0 + MINUTE)
    expect(s.top).toContain('1 waiting')
    expect(s.top).not.toContain('pnpm build · background')
  })

  test("Claude Code's own housekeeping and another loop's tasks are nobody's jobs: a teammate's shell, a subagent's monitor", () => {
    const listed: ListedTask[] = [
      { id: 'd1x', type: 'dream', status: 'running', description: 'dreaming' },
      { id: 'e1x', type: 'auto-mode scan', status: 'running', description: 'scan' },
      { id: 'n1x', type: 'memory import', status: 'running', description: 'import' },
      { id: 'bo5jmogk0', type: 'shell', status: 'running', description: 'Sleep 40 seconds in background', command: 'sleep 40' },
    ]
    let c = newCockpit(T0, 's')
    // The teammate's own Bash call answered with its task id: it is that loop's.
    c = onForeignTask(c, 'bo5jmogk0')
    c = onBackgroundTasks(c, T0 + MINUTE, listed)
    expect(c.jobs).toEqual([])
    // Listed before its call came back, it was taken for Claude's; told whose it is, it leaves the jobs.
    let early = onBackgroundTasks(newCockpit(T0, 's'), T0, [listed[3] as ListedTask])
    expect(early.jobs.map(j => j.id)).toEqual(['bo5jmogk0'])
    early = onForeignTask(early, 'bo5jmogk0')
    expect(early.jobs).toEqual([])
    // A subagent's task carries its agent's id: one not known yet joins the agents, running in the background.
    const agent = onBackgroundTasks(newCockpit(T0, 's'), T0, [SUBAGENT, TEAMMATE])
    expect(agent.agents.map(a => [a.agentId, a.status])).toEqual([['aae45142fec26598f', 'background']])
    expect(agent.jobs).toEqual([])
  })

  test("the Monitor tool's command is a job from its call; its events end nothing, its stream's end does", () => {
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't1', text: 'watch the ticks' })
    const input = { command: MONITOR.command, description: 'ticks', timeout_ms: 400_000 }
    c = onToolStart(c, { at: T0, id: 'call-m', tool: 'Monitor', input })
    c = onToolEnd(c, { at: T0 + S, id: 'call-m', tool: 'Monitor', input, outcome: 'ok', text: 'Monitor started (task by8nszpah, expires in 6m 40s)', result: { taskId: 'by8nszpah', timeoutMs: 400_000, persistent: false } })
    expect(c.jobs).toMatchObject([{ id: 'by8nszpah', kind: 'monitor', toolUseId: 'call-m', description: 'ticks', status: 'running', startedAt: T0 }])
    // Listed as a shell at the turn's end: the same job, kept as the monitor it is.
    c = onBackgroundTasks(c, T0 + 2 * S, [MONITOR])
    expect(c.jobs).toMatchObject([{ id: 'by8nszpah', kind: 'monitor', status: 'running' }])
    const event = '<task-notification>\n<task-id>by8nszpah</task-id>\n<summary>Monitor event: "ticks"</summary>\n<event>tick 1</event>\nIf this event is something the user would act on now, send a PushNotification.\n</task-notification>'
    expect(parseNotices(event)).toEqual([{ taskId: 'by8nszpah', of: 'monitor', isEvent: true }])
    c = onNotices(c, T0 + 30 * S, parseNotices(event))
    expect(c.jobs[0]?.status).toBe('running')
    const ended = '<task-notification>\n<task-id>by8nszpah</task-id>\n<tool-use-id>call-m</tool-use-id>\n<output-file>/tmp/by8nszpah.output</output-file>\n<status>completed</status>\n<summary>Monitor "ticks" stream ended</summary>\n</task-notification>'
    c = onNotices(c, T0 + 3 * MINUTE, parseNotices(ended))
    expect(c.jobs[0]).toMatchObject({ status: 'done', endedAt: T0 + 3 * MINUTE })
  })

  test('a workflow is a job from its call, named by its summary', () => {
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't1', text: 'run the workflow' })
    const input = { script: "export const meta = { name: 'probe-wf' }" }
    c = onToolStart(c, { at: T0, id: 'call-w', tool: 'Workflow', input })
    c = onToolEnd(c, { at: T0 + S, id: 'call-w', tool: 'Workflow', input, outcome: 'ok', text: 'Workflow launched in background. Task ID: weocfglpl', result: { status: 'async_launched', taskId: 'weocfglpl', taskType: 'local_workflow', workflowName: 'probe-wf', runId: 'wf_1', summary: 'One small agent for a probe' } })
    expect(c.jobs).toMatchObject([{ id: 'weocfglpl', kind: 'workflow', description: 'One small agent for a probe', status: 'running' }])
    c = onBackgroundTasks(c, T0 + 2 * S, [WORKFLOW])
    expect(c.jobs).toHaveLength(1)
  })

  test('a job with no expected end holds the headline for its first 30 minutes, then runs aside as a quiet line; one of a known length holds it', () => {
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't1', text: 'start the dev server' })
    const input = { command: 'pnpm dev', run_in_background: true }
    c = onToolStart(c, { at: T0, id: 'call-d', tool: 'Bash', input })
    c = onToolEnd(c, { at: T0 + S, id: 'call-d', tool: 'Bash', input, outcome: 'ok', text: 'Command running in background with ID: bdev', result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bdev' } })
    c = onTurnEnd(c, { at: T0 + MINUTE, turnId: 't1', tokens: 1000, durationMs: MINUTE, isAborted: false })
    // Ten minutes on, it holds the headline: the band's hero names it.
    expect(said(c, T0 + 10 * MINUTE).hero).toContain('pnpm dev · background')
    // Forty minutes on, it runs aside: the hero stands by, the pane's top says it in one quiet line.
    const late = said(c, T0 + 40 * MINUTE)
    expect(late.hero).not.toContain('pnpm dev')
    expect(late.hero).toContain('last turn')
    expect(late.top).toContain('pnpm dev · background 40m')
    // Its crossing closes: the next turn starts its own.
    const next = onTurnStart(c, { at: T0 + 40 * MINUTE, turnId: 't2', text: 'go on' })
    expect(next.crossing?.from).toBe(T0 + 40 * MINUTE)
    // A suite of a known length runs past 30 minutes and still holds it, with its time left.
    let suite = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't1', text: 'run the suite' })
    suite = { ...suite, meta: { root: '/work' } }
    const run = { command: 'make test-all', run_in_background: true }
    suite = onToolStart(suite, { at: T0, id: 'call-s', tool: 'Bash', input: run })
    suite = onToolEnd(suite, { at: T0 + S, id: 'call-s', tool: 'Bash', input: run, outcome: 'ok', text: 'Command running in background with ID: bsuite', result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bsuite' } })
    suite = onTurnEnd(suite, { at: T0 + MINUTE, turnId: 't1', tokens: 1000, durationMs: MINUTE, isAborted: false })
    const lengths = addRun(undefined, '/work', 'make test-all', 50 * MINUTE, T0 - HOUR)
    expect(estimate(suite, T0 + 40 * MINUTE, { lengths })?.jobs.map(j => j.id)).toEqual(['bsuite'])
    expect(said(suite, T0 + 40 * MINUTE, { lengths }).hero).toContain('make test-all · background')
  })

  test('one answer: the progress (the band and the pane) and AGENTS say the same of what runs, in every state', () => {
    const base = onTurnEnd(onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't1', text: 'go' }), { at: T0 + MINUTE, turnId: 't1', tokens: 1000, durationMs: MINUTE, isAborted: false })
    const spawn = (c: Cockpit, id: string, description: string, extra: Partial<Parameters<typeof onAgentSpawn>[1]> = {}) => onAgentSpawn(c, { at: T0 + 2 * MINUTE, toolUseId: `call-${id}`, agentId: id, type: 'Explore', description, background: true, by: 'main', ...extra })
    const states: [string, Cockpit][] = [
      ['nothing', base],
      ['a background agent running', spawn(base, 'a1', 'Map the parser')],
      ['a teammate at work', onAgentList(spawn(base, 'tm', 'Review the docs', { isTeammate: true, type: 'teammate' }), T0 + 3 * MINUTE, [{ id: 'tm', status: 'running', type: 'teammate', description: 'Review the docs', teammateId: 'tm@team' }])],
      ['a teammate idle', onAgentList(spawn(base, 'tm', 'Review the docs', { isTeammate: true, type: 'teammate' }), T0 + 3 * MINUTE, [{ id: 'tm', status: 'idle', type: 'teammate', description: 'Review the docs', teammateId: 'tm@team' }])],
      ['an agent waiting on its own', onAgentList(spawn(base, 'a2', 'Plan the rewrite'), T0 + 3 * MINUTE, [{ id: 'a2', status: 'waiting', type: 'Plan', description: 'Plan the rewrite' }])],
      ["a plugin's agent", spawn(base, 'p1', 'Review diff', { by: 'plugin', byName: 'gatekeeper' })],
    ]
    for (const [name, c] of states) {
      const s = said(c, T0 + 4 * MINUTE)
      const running = s.running
      // AGENTS counts what the progress names: the same agents, by the same function.
      expect([name, s.agents[0]]).toEqual([name, running.length > 0 ? `${running.length} running` : 'none running'])
      expect([name, s.reading.startsWith(running.length > 0 ? `${running.length} running` : 'none running')]).toEqual([name, true])
      for (const agent of c.agents) {
        const isRunning = running.includes(agent.description)
        // The progress names an agent only while AGENTS counts it as running.
        expect([name, agent.description, s.hero.includes(agent.description) || s.top.includes(agent.description) || s.summary.includes(agent.description)]).toEqual([name, agent.description, isRunning])
      }
    }
  })

  test('in a session: a teammate works, reports and goes idle beside a background subagent and a shell; the progress and AGENTS agree throughout', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await $.turn.start({ text: 'Start a teammate, a background subagent and a background shell', turnId: 't1' })
    await $.tool.call({ tool: 'Agent', name: 'helper', description: 'Teammate helper', prompt: 'help' } as never)
    await $.tool.call({ tool: 'Agent', description: 'Background counter', prompt: 'count', subagent_type: 'general-purpose', run_in_background: true } as never)
    await $.tool.call({ tool: 'Bash', command: 'sleep 400', description: 'Sleep 400 seconds in background', run_in_background: true } as never)
    w.agents = [
      { id: 'agent-1', status: 'running', type: 'teammate', description: 'Teammate helper', teammateId: 'helper@session-test' },
      { id: 'agent-2', status: 'running', type: 'general-purpose', description: 'Background counter' },
    ]
    await $.turn.complete({ answer: 'Started all three.', durationMs: 15 * S, isAborted: false, turnId: 't1', reason: 'answer', usage: usage(1000) })
    // The turn's end lists the teammate as its own task, "running", as Claude Code 2.1.296 did.
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ ...TEAMMATE }, { ...SUBAGENT, id: 'agent-2' }, { ...SHELL, id: 'bash-1' }] })
    await w.clock.advance(6 * S)
    expect(await agree($)).toEqual({ agents: '2 running', progressNamesTeammate: true })
    // The teammate reports (its own turn's end) and idles; the list says so.
    await $.turn.complete({ answer: 'done', durationMs: 40 * S, isAborted: false, turnId: 'tm-1', reason: 'answer', usage: usage(10), agentId: 'agent-1' })
    w.agents = [
      { id: 'agent-1', status: 'idle', type: 'teammate', description: 'Teammate helper', teammateId: 'helper@session-test' },
      { id: 'agent-2', status: 'running', type: 'general-purpose', description: 'Background counter' },
    ]
    await w.clock.advance(6 * S)
    expect(await agree($)).toEqual({ agents: '1 running', progressNamesTeammate: false })
    // Hours on, every turn's end still lists the teammate "running": it never shows as running.
    await $.turn.start({ text: 'go on', turnId: 't2' })
    await $.turn.complete({ answer: 'ok', durationMs: 5 * S, isAborted: false, turnId: 't2', reason: 'answer', usage: usage(100) })
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ ...TEAMMATE }, { ...SHELL, id: 'bash-1' }] })
    w.agents = [{ id: 'agent-1', status: 'idle', type: 'teammate', description: 'Teammate helper', teammateId: 'helper@session-test' }, { id: 'agent-2', status: 'completed', type: 'general-purpose', description: 'Background counter' }]
    await w.clock.advance(3 * HOUR)
    expect(await agree($)).toEqual({ agents: 'none running', progressNamesTeammate: false })
    expect(await paneHas($, '1 teammate idle')).toBe(true)
  })
})

/** What AGENTS says first in the pane, and whether the progress (the band and the pane's top) names the teammate. */
async function agree($: Engine): Promise<{ agents: string; progressNamesTeammate: boolean }> {
  const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
  const agents = (await pane.find({ type: 'Text', text: /^(?:\d+ running|none running)$/ }))?.text ?? '?'
  const named = (await pane.find({ type: 'Text', text: /Teammate helper/ })) !== undefined
  await pane.unmount()
  return { agents, progressNamesTeammate: named }
}

async function paneHas($: Engine, text: string): Promise<boolean> {
  const pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
  const found = (await pane.find({ type: 'Text', text: new RegExp(text) })) !== undefined
  await pane.unmount()
  return found
}
