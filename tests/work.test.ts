import { describe, expect, test, type Engine } from 'claude-code/testing'

import { estimate } from '../src/eta'
import { addRun, jobName, jobPace, jobVerdict, parseNotices, type Job } from '../src/jobs'
import { newCockpit, onAgentList, onAgentSpawn, onAgentTurnEnd, onBackgroundTasks, onNotices, onToolEnd, onToolStart, onTurnEnd, onTurnStart, type Cockpit } from '../src/model'
import { instrumentIds, instrumentReading } from '../src/instruments'
import { cellOf } from '../src/panes'
import { checksFace, heroFace, readingsOf } from '../src/tiles'
import { timeSection } from '../src/timeline'
import { topSection } from '../src/top'
import { plain } from '../src/text'
import { at, band, EN, MINUTE, PANE, start, usage, world } from './kit'

const T0 = at(2026, 10, 13, 17)
const S = 1000
const view = (now: number, L: 'en' | 'ko' = 'en', extra = {}) => ({ now, locale: L, days: [], today: '2026-10-13', ...extra })

/** What Claude Code writes when a background shell ends, as its notification. */
const shellNotice = (id: string, callId: string, words: string, status = 'completed', code = 0) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${callId}</tool-use-id>\n<output-file>/tmp/${id}.output</output-file>\n<status>${status}</status>\n<summary>Background command "${words}" ${status === 'completed' ? `completed (exit code ${code})` : `failed with exit code ${code}`}</summary>\n</task-notification>`

/** A background shell started by Claude's own Bash call at `at`, answered with its task id. */
function background(c: Cockpit, at: number, id: string, command: string, description?: string): Cockpit {
  const input = { command, run_in_background: true, ...(description ? { description } : {}) }
  const started = onToolStart(c, { at, id: `call-${id}`, tool: 'Bash', input })
  return onToolEnd(started, { at: at + 500, id: `call-${id}`, tool: 'Bash', input, outcome: 'ok', text: `Command running in background with ID: ${id}.`, result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id } })
}

describe('the work in hand: background jobs and every agent', () => {
  test("a task's notice is read as Claude Code writes it: its task, its call, how it ended and a shell's exit", () => {
    expect(parseNotices(shellNotice('bpdls0tu2', 'toolu_01', 'Run the suite'))).toEqual([{ taskId: 'bpdls0tu2', toolUseId: 'toolu_01', status: 'completed', exitCode: 0, of: 'shell' }])
    expect(parseNotices(shellNotice('b2', 'toolu_02', 'Full gate', 'failed', 1))[0]).toMatchObject({ status: 'failed', exitCode: 1, of: 'shell' })
    const agent = '<task-notification>\n<task-id>ad775e30fd9aa4eb5</task-id>\n<tool-use-id>toolu_03</tool-use-id>\n<status>completed</status>\n<summary>Agent "List folder files" finished</summary>\n</task-notification>'
    expect(parseNotices(agent)).toEqual([{ taskId: 'ad775e30fd9aa4eb5', toolUseId: 'toolu_03', status: 'completed', of: 'agent' }])
    expect(parseNotices('Fix the parser')).toEqual([])
    // A background check is judged by its exit, as a foreground run is with no output to read.
    expect([jobVerdict('make test-all', 'done', 0), jobVerdict('make test-all', 'failed', 2), jobVerdict('pnpm test | tail -5', 'done', 0), jobVerdict('pnpm build | tail -5', 'done', 0), jobVerdict('pnpm test', 'killed', undefined)]).toEqual(['pass', 'fail', 'hidden', 'pass', 'interrupted'])
  })

  test("a shell's expected length: its command's last runs in this project (one is enough), else its kind of check's, else none", () => {
    let runs = addRun(undefined, '/work', 'make test-all', 4 * MINUTE, T0)
    const job: Job = { id: 'b1', kind: 'shell', command: 'make test-all', checks: ['test'], startedAt: T0, status: 'running' }
    expect(jobPace(job, '/work', runs)).toEqual({ ms: 4 * MINUTE, basis: 'command', samples: 1 })
    expect(jobPace(job, '/elsewhere', runs)).toBeUndefined()
    runs = addRun(runs, '/work', 'make test-all', 6 * MINUTE, T0)
    expect(jobPace(job, '/work', runs)).toEqual({ ms: 5 * MINUTE, basis: 'command', samples: 2 })
    // A check never run this way: its kind's runs, this session's and the project's, two at least.
    const other: Job = { ...job, command: 'pnpm test --run' }
    expect(jobPace(other, '/work', runs, [{ kind: 'test', ms: 2 * MINUTE }])).toEqual({ ms: 4 * MINUTE, basis: 'kind', samples: 3, kind: 'test' })
    // A dev server has none: it runs with no expected end.
    expect(jobPace({ ...job, command: 'pnpm dev', checks: undefined }, '/work', runs)).toBeUndefined()
    // Runs under 5 seconds are no help and are not kept; 5 runs a command at most.
    expect(addRun(undefined, '/work', 'ls', 900, T0).runs).toEqual([])
    let many = runs
    for (let i = 0; i < 8; i++) many = addRun(many, '/work', 'make test-all', (i + 1) * MINUTE, T0 + i)
    expect(many.runs.find(r => r.c === 'make test-all')?.ms).toHaveLength(5)
  })

  test("a job's name: its command where it reads as one, else Claude's description of it", () => {
    const job: Job = { id: 'b', kind: 'shell', command: 'make test-all', description: 'Run the full test suite', startedAt: T0, status: 'running' }
    expect(jobName(job)).toBe('make test-all')
    // A leading change of folder and a trailing 2>&1 are no part of what runs.
    expect(jobName({ ...job, command: 'cd /work/app && pnpm test 2>&1' })).toBe('pnpm test')
    // Several commands, a pipe or a long line: Claude's description says it better.
    expect(jobName({ ...job, command: 'pnpm build && pnpm test | tail -20' })).toBe('Run the full test suite')
    expect(jobName({ ...job, command: 'node scripts/integration-suite-with-a-long-name.js --all' })).toBe('Run the full test suite')
    expect(jobName({ id: 'm', kind: 'monitor', startedAt: T0, status: 'running' })).toBe('monitor')
  })

  test("background work Claude comes back to keeps the top working after the turn ends; its notice ends it and the next turn carries the crossing on", () => {
    const runs = addRun(undefined, '/work', 'make test-all', 4 * MINUTE, T0 - 60 * MINUTE)
    let c: Cockpit = { ...onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't1', text: 'Run the full suite and commit' }), meta: { root: '/work' } }
    c = background(c, T0 + MINUTE, 'b1', 'make test-all', 'Run the full test suite')
    c = onBackgroundTasks(c, T0 + 2 * MINUTE, [{ id: 'b1', type: 'shell', status: 'running', description: 'Run the full test suite', command: 'make test-all' }])
    c = onTurnEnd(c, { at: T0 + 2 * MINUTE, turnId: 't1', tokens: 100, durationMs: 2 * MINUTE, isAborted: false })
    expect(c.turn).toBeUndefined()
    const now = T0 + 3 * MINUTE
    const r = readingsOf(c, view(now, 'en', { lengths: runs }))
    expect(r.isWorking).toBe(true)
    // The job's command took 4 minutes last time: started at 1:00, it should end at 5:00.
    expect(r.eta?.endsAt).toBe(T0 + MINUTE + 4 * MINUTE)
    const top = topSection(r, 96)
    // Named by its command, as the person would type it.
    expect(plain(top.head)).toBe('▸ make test-all · background')
    expect(plain(top.pond?.words[0] ?? [])).toBe('~2m left')
    expect(top.under.map(plain)).toContain('make test-all took ~4m last time')
    // The band says the same, in place of "Standing by"; in a narrow tile the name goes before the tag.
    expect(plain(heroFace(r, 48).lines[0])).toBe('▸ make test-all · background')
    expect(plain(heroFace(r, 20).lines[0])).toBe('▸ make test-all')
    // The checks cell: a running background check, how long so far and usually.
    expect(plain(cellOf(r, 'checks', 47).lines[0])).toBe('◌ background tests · 2m (usually ~4m)')
    // Its notice: done at 5:30, exit 0. The check passes; the job ended; nothing runs.
    const crossing = c.crossing?.from
    c = onNotices(c, T0 + 5 * MINUTE + 30 * S, parseNotices(shellNotice('b1', 'call-b1', 'Run the full test suite')))
    expect(c.jobs[0]).toMatchObject({ status: 'done', exitCode: 0, endedAt: T0 + 5 * MINUTE + 30 * S })
    expect(c.checks.at(-1)).toMatchObject({ status: 'pass', durationMs: 4 * MINUTE + 30 * S })
    expect(c.crossing?.closedAt).toBe(T0 + 5 * MINUTE + 30 * S)
    // The turn its notice starts carries the crossing on.
    const next = onTurnStart(c, { at: T0 + 5 * MINUTE + 31 * S, turnId: 't2', text: shellNotice('b1', 'call-b1', 'Run the full test suite') })
    expect(next.crossing).toEqual({ from: crossing })
    // A turn the person types starts a new one.
    expect(onTurnStart(c, { at: T0 + 6 * MINUTE, turnId: 't3', text: 'Now deploy' }).crossing).toEqual({ from: T0 + 6 * MINUTE })
  })

  test('a failing background check is a failed check, and the duck says so', () => {
    let c: Cockpit = { ...onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't1', text: 'go' }), meta: { root: '/work' } }
    c = background(c, T0, 'b2', 'pnpm test', 'Run the tests')
    c = onNotices(c, T0 + 2 * MINUTE, parseNotices(shellNotice('b2', 'call-b2', 'Run the tests', 'failed', 1)))
    expect(c.checks.at(-1)?.status).toBe('fail')
    expect(c.failures.map(f => f.kind)).toEqual(['test'])
  })

  test("a background run that fails at once, gone from the turn's end before its notice, still fails by its notice", () => {
    let c: Cockpit = { ...onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't1', text: 'go' }), meta: { root: '/work' } }
    c = background(c, T0, 'b4', 'node --test test/', 'Run the full suite')
    // It failed within a second; the turn's end, 5 seconds on, no longer lists it: ended unseen.
    c = onBackgroundTasks(c, T0 + 5 * S, [])
    expect(c.jobs[0]).toMatchObject({ status: 'done', isGone: true })
    // Its notice comes with the next prompt: it failed, exit 1. The check fails; its length stays unknown.
    c = onNotices(c, T0 + 9 * S, parseNotices(shellNotice('b4', 'call-b4', 'Run the full suite', 'failed', 1)))
    expect(c.jobs[0]).toMatchObject({ status: 'failed', exitCode: 1, isGone: true, endedAt: T0 + 5 * S })
    expect(c.checks.at(-1)).toMatchObject({ status: 'fail' })
    expect(c.checks.at(-1)?.durationMs).toBeUndefined()
    expect(c.failures.map(f => f.kind)).toEqual(['test'])
  })

  test('a background check running shows in the checks cell before a failure it may clear, and its pass clears it', () => {
    let c: Cockpit = { ...onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't1', text: 'go' }), meta: { root: '/work' } }
    c = background(c, T0, 'b2', 'pnpm test', 'Run the tests')
    c = onNotices(c, T0 + 2 * MINUTE, parseNotices(shellNotice('b2', 'call-b2', 'Run the tests', 'failed', 1)))
    // Found live: the failure stood in the cell while the run that would clear it was under way.
    c = background(c, T0 + 3 * MINUTE, 'b3', 'pnpm test', 'Run the tests again')
    expect(plain(cellOf(readingsOf(c, view(T0 + 4 * MINUTE)), 'checks', 47).lines[0])).toMatch(/^◌ background tests · 1m/)
    c = onNotices(c, T0 + 5 * MINUTE, parseNotices(shellNotice('b3', 'call-b3', 'Run the tests again')))
    expect(c.failures).toEqual([])
    expect(plain(cellOf(readingsOf(c, view(T0 + 5 * MINUTE)), 'checks', 47).lines[0])).toMatch(/^✓/)
    // Found live: until its call came back the run was no job yet, and the cell said it had no usual length, which it had.
    const input = { command: 'pnpm test', run_in_background: true }
    const sent = onToolStart(c, { at: T0 + 6 * MINUTE, id: 'call-b4', tool: 'Bash', input })
    expect(checksFace(readingsOf(sent, view(T0 + 6 * MINUTE))).lines.map(plain)).toEqual(['◌ background tests · <1m', ''])
    expect(cellOf(readingsOf(sent, view(T0 + 6 * MINUTE)), 'checks', 47).lines.map(plain).join('\n')).not.toContain('no usual length')
    const back = onToolEnd(sent, { at: T0 + 6 * MINUTE + 500, id: 'call-b4', tool: 'Bash', input, outcome: 'ok', text: 'Command running in background with ID: b4.', result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b4' } })
    expect(plain(checksFace(readingsOf(back, view(T0 + 6 * MINUTE + 500))).lines[1] ?? [])).toMatch(/^~\d+m left$/)
    // Found live in an inline pane: its one-line reading said `tests` twice; its time left follows instead.
    expect(plain(instrumentReading(readingsOf(back, view(T0 + 6 * MINUTE + 500)), 'checks'))).toMatch(/^◌ background tests · <1m · ~\d+m left$/)
    expect(plain(instrumentReading(readingsOf(sent, view(T0 + 6 * MINUTE)), 'checks'))).toBe('◌ background tests · <1m')
  })

  test("a job with no length known runs on with no expected end: listed, adding nothing; a list done beside it is no crossing made", () => {
    let c: Cockpit = { ...onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't1', text: 'Start the dev server' }), meta: { root: '/work' } }
    c = background(c, T0, 'b3', 'pnpm dev', 'Start the dev server')
    c = onTurnEnd(c, { at: T0 + MINUTE, turnId: 't1', tokens: 100, durationMs: MINUTE, isAborted: false })
    const r = readingsOf(c, view(T0 + 25 * MINUTE))
    expect(r.eta).toBeUndefined()
    const top = topSection(r, 96)
    expect(plain(top.head)).toBe('▸ pnpm dev · background')
    // Its name is the head's: its own line says only how long it has run.
    expect(top.under.map(plain)).toEqual(['running 25m, no usual length yet'])
    // The band's second line: its name is the first's; in a narrow tile, that it runs in the background.
    expect(plain(heroFace(r, 48).lines[1])).toBe('running 25m, no usual length yet')
    expect(plain(heroFace(r, 20).lines[1])).toBe('background · 25m')
  })

  test('every agent is listed with who started it; only those Claude started count in the estimate', () => {
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
    c = { ...c, durations: { ...c.durations, agents: { Explore: [3 * MINUTE, 3 * MINUTE] } } }
    // Claude's own background Explore, a workflow's agent, a plugin's, and one another agent started.
    c = onToolStart(c, { at: T0, id: 'call-1', tool: 'Agent', input: { description: 'Map the parser', subagent_type: 'Explore', run_in_background: true } })
    c = onAgentSpawn(c, { at: T0, toolUseId: 'call-1', agentId: 'a1', type: 'Explore', description: 'Map the parser', background: true, by: 'main' })
    c = onAgentSpawn(c, { at: T0, toolUseId: 'wf-call', agentId: 'a2', type: 'Explore', description: 'Classify repos', background: true, by: 'workflow' })
    c = onAgentSpawn(c, { at: T0, toolUseId: 'x', agentId: 'a3', type: 'reviewer', description: 'Review diff', background: true, by: 'plugin', byName: 'gatekeeper' })
    c = onAgentSpawn(c, { at: T0, toolUseId: 'y', agentId: 'a4', type: 'Explore', description: 'Nested scan', background: true, by: 'agent', byName: 'Explore' })
    expect(c.agents.find(a => a.agentId === 'a1')?.id).toBe('call-1')
    // One the list shows that quackpit did not see start (a skill's fork, one left from an earlier turn).
    c = onAgentList(c, T0 + MINUTE, [
      { id: 'a1', status: 'running', type: 'Explore', description: 'Map the parser' },
      { id: 'a3', status: 'running', type: 'reviewer', description: 'Review diff', spawnedBy: 'gatekeeper' },
      { id: 'a5', status: 'running', type: 'general-purpose', description: 'covi-video render' },
      { id: 'a6', status: 'idle', type: 'teammate', description: 'scout', teammateId: 'scout@team' },
    ])
    const eta = estimate(c, T0 + MINUTE)
    // Counted: a1 and a2 (Explore, usually 3m), a5 (no history of its type: every type's median, 3m).
    expect(eta?.agents.map(a => [a.id, a.basis])).toEqual([
      ['call-1', 'type'],
      ['agent:a2', 'type'],
      ['agent:a5', 'any'],
    ])
    const lines = timeSection(c, T0 + 2 * MINUTE, 'en', 130, undefined, eta).map(plain)
    expect(lines.find(line => line.includes('Review diff'))).toMatch(/│ gatekeeper plugin · not counted$/)
    expect(lines.find(line => line.includes('Nested scan'))).toMatch(/│ by Explore · not counted$/)
    expect(lines.find(line => line.includes('Classify repos'))).toMatch(/~\dm left · a workflow · background$/)
    // Its start was not seen: it has run at least this long.
    expect(lines.find(line => line.includes('covi-video render'))).toMatch(/ ≥1m… +│.*│ ~2m left · background$/)
    expect(lines.find(line => line.includes('scout'))).toMatch(/idle · teammate$/)
    // Running as the progress and AGENTS count it: Claude's three; the plugin's and the nested one are counted apart.
    expect(lines.find(line => line.startsWith('SUBAGENTS'))).toBe('SUBAGENTS  3 running · 2 not counted · 1 idle · 0 done')
    // The agents' cell shows once one has run.
    expect(instrumentIds(readingsOf(c, view(T0 + MINUTE)))).toContain('agents')
    // A subagent's own turn end ends it; a teammate's makes it idle; the list's absence ends one it showed.
    let ended = onAgentTurnEnd(c, { at: T0 + 4 * MINUTE, agentId: 'a1', isAborted: false })
    expect(ended.agents.find(a => a.agentId === 'a1')).toMatchObject({ status: 'done', endedAt: T0 + 4 * MINUTE })
    expect(ended.durations.agents.Explore).toEqual([3 * MINUTE, 3 * MINUTE, 4 * MINUTE])
    ended = onAgentList(ended, T0 + 5 * MINUTE, [{ id: 'a6', status: 'idle' }])
    expect(ended.agents.find(a => a.agentId === 'a5')?.status).toBe('done')
    // A workflow's agents are never listed: their absence ends nothing.
    expect(ended.agents.find(a => a.agentId === 'a2')?.status).toBe('background')
  })

  test('an agent first seen already running, as a skill\'s fork is, has run at least as long as quackpit has seen it', () => {
    // Found live: a skill with `context: fork` raises no agent.spawn; the agent list is how it is seen.
    const c = onAgentList(onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' }), T0, [{ id: 'a9', status: 'running', type: 'general-purpose', description: '/slow-count' }])
    const row = (now: number) => timeSection(c, now, 'en', 130, undefined, estimate(c, now)).map(plain).find(line => line.includes('/slow-count'))
    expect(row(T0 + 40 * S)).toContain('≥40s…')
    expect(row(T0 + 3 * MINUTE)).toContain('≥3m…')
  })

  test('an agent of a type never seen finish, with no runs of any type, runs on with no expected end, and the flag never comes before it', () => {
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
    c = onToolStart(c, { at: T0, id: 'todo', tool: 'TodoWrite', input: { todos: [{ content: 'Only task', status: 'completed', activeForm: 'x' }] } })
    c = onToolEnd(c, { at: T0, id: 'todo', tool: 'TodoWrite', input: { todos: [{ content: 'Only task', status: 'completed', activeForm: 'x' }] }, outcome: 'ok', text: 'ok', result: {} })
    c = onAgentSpawn(c, { at: T0, toolUseId: 'z', agentId: 'z1', type: 'Plan', description: 'Plan the release', background: true, by: 'main' })
    const r = readingsOf(c, view(T0 + 3 * MINUTE))
    expect(r.eta?.isDone).not.toBe(true)
    const hero = heroFace(r, 48)
    expect(hero.pond?.fraction ?? 0).toBeLessThan(1)
    expect(topSection(r, 96).under.map(plain)).toContain('Plan · running 3m, no usual length yet')
  })

  test('in a session: a background shell, the turn ending, the top working on, the notice ending it and its length kept for next time', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await $.prompt.submit({ text: 'Run the full suite', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'Run the full suite', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'make test-all', description: 'Run the full test suite', run_in_background: true } as never)
    await w.clock.advance(30 * S)
    // The turn ends while it runs: Stop lists it, and the top says so rather than "Standing by".
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'bash-1', type: 'shell', status: 'running', description: 'Run the full test suite', command: 'make test-all' }] })
    await $.turn.complete({ answer: 'It runs in the background.', durationMs: 30 * S, isAborted: false, turnId: 't1', reason: 'answer', usage: usage(500) })
    await w.clock.advance(2 * MINUTE)
    expect(await bandText($, /background/)).toBe('make test-all · background')
    expect(await paneText($, 'running 2m, no usual length yet')).toBeDefined()
    // Its notice, 4 minutes in: it passed, and its length is kept for its command in this project.
    await w.clock.advance(90 * S)
    const callId = w.calls.find(call => call.tool === 'Bash')?.id ?? ''
    await $.prompt.submit({ text: shellNotice('bash-1', callId, 'Run the full test suite'), wait: false, origin: { kind: 'task-notification' } })
    await w.clock.settle()
    const runs = w.store.get('runs') as { runs: { p: string; c: string; ms: number[] }[] }
    expect(runs.runs).toEqual([{ p: '/work', c: 'make test-all', ms: [4 * MINUTE], at: expect.any(Number) }])
    expect(await paneText($, /✓ 1 passed|✓ passed/)).toBeDefined()
    // The next time it runs in the background, its end is known.
    await $.turn.start({ text: 'Run it again', turnId: 't2' })
    await $.tool.call({ tool: 'Bash', command: 'make test-all', description: 'Run the full test suite', run_in_background: true } as never)
    await w.clock.advance(MINUTE)
    expect(await paneText($, /^~3m left$/)).toBeDefined()
    expect(await paneText($, 'make test-all took ~4m last time')).toBeDefined()
  })

  test("in a session: Claude's background agent gets its id from its spawn, and its own turn's end ends it", EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await $.turn.start({ text: 'Map the code', turnId: 't1' })
    await $.tool.call({ tool: 'Agent', description: 'Map the parser', prompt: 'map', subagent_type: 'Explore', run_in_background: true } as never)
    await w.clock.advance(MINUTE)
    w.agents = [{ id: 'agent-1', status: 'running', type: 'Explore', description: 'Map the parser' }]
    await w.clock.advance(6 * S)
    expect(await paneText($, /Explore · Map the parser/)).toBeDefined()
    expect(await paneText($, /background · no usual length yet/)).toBeDefined()
    await $.turn.complete({ answer: 'done', durationMs: 90 * S, isAborted: false, turnId: 'sub', reason: 'answer', usage: usage(10), agentId: 'agent-1' })
    await w.clock.settle()
    expect(await paneText($, /SUBAGENTS {2}0 running · 1 done/)).toBeDefined()
  })
})

async function bandText($: Engine, pattern: RegExp): Promise<string | undefined> {
  const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
  const text = (await ui.find({ type: 'Text', text: pattern }))?.text?.trim()
  await ui.unmount()
  return text?.replace(/^▸ /, '')
}

/** The pane's Text matching `pattern`: in the overview, where progress and the instruments are, else in the timeline. */
async function paneText($: Engine, pattern: RegExp | string): Promise<string | undefined> {
  let text: string | undefined
  for (const view of ['overview', 'timeline']) {
    let pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    await pane.press({ key: `pane-view-${view}` })
    await pane.unmount()
    pane = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    text = (await pane.find({ type: 'Text', text: pattern }))?.text
    await pane.unmount()
    if (text !== undefined) break
  }
  return text
}


