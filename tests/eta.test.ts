import { describe, expect, test } from 'claude-code/testing'

import { asDurations, estimate, noteLengths, priorsOf, taskPace, type Durations } from '../src/eta'
import { asCockpit, MODEL_VERSION, newCockpit, onToolEnd, onToolStart, type Cockpit } from '../src/model'
import { surveySessions, type KV } from '../src/store'
import { at, MINUTE } from './kit'

const T0 = at(2026, 10, 12, 9)

/** Claude's TodoWrite at `minutes` past T0, each item with its status. */
function todo(c: Cockpit, minutes: number, statuses: ('pending' | 'in_progress' | 'completed')[], id = `w${minutes}`): Cockpit {
  const call = { at: T0 + minutes * MINUTE, id, tool: 'TodoWrite', input: { todos: statuses.map((status, i) => ({ content: `Task ${i + 1}`, status, activeForm: `Doing ${i + 1}` })) } }
  return onToolEnd(onToolStart(c, call), { ...call, outcome: 'ok', text: 'ok', result: { oldTodos: [], newTodos: call.input.todos } })
}

/** An Agent call of `type`, launched at `from` and answered at `to` minutes past T0. */
function agent(c: Cockpit, id: string, type: string, from: number, to?: number): Cockpit {
  const call = { at: T0 + from * MINUTE, id, tool: 'Agent', input: { subagent_type: type, description: `${type} run`, prompt: 'go' } }
  const started = onToolStart(c, call)
  if (to === undefined) return started
  const result = { status: 'completed', agentId: `ag-${id}`, totalDurationMs: (to - from) * MINUTE, totalTokens: 1000, totalToolUseCount: 3, content: [], usage: {}, prompt: '' }
  return onToolEnd(started, { ...call, at: T0 + to * MINUTE, outcome: 'ok', text: 'done', result })
}

const empty = (): Durations => ({ tasks: [], agents: {}, turns: [] })

describe('the estimate of what is left', () => {
  test("a list's own pace once two of its tasks are done; before that your recent tasks, from 3 of them; else none", () => {
    let c = todo(newCockpit(T0, 's'), 0, ['in_progress', 'pending', 'pending', 'pending'])
    expect(taskPace(c)).toBeUndefined()
    // Recent tasks from other sessions stand in: the median of 3 or more.
    const priors: Durations = { tasks: [4 * MINUTE, 6 * MINUTE, 8 * MINUTE], agents: {}, turns: [] }
    expect(taskPace(c, priors)).toEqual({ ms: 6 * MINUTE, basis: 'recent', samples: 3 })
    expect(taskPace(c, { tasks: [4 * MINUTE, 6 * MINUTE], agents: {}, turns: [] })).toBeUndefined()
    c = todo(c, 3, ['completed', 'in_progress', 'pending', 'pending'])
    c = todo(c, 8, ['completed', 'completed', 'in_progress', 'pending'])
    // Two done (3m and 5m): the list's own pace wins over the recent tasks.
    expect(taskPace(c, priors)).toEqual({ ms: 4 * MINUTE, basis: 'list', samples: 2 })
  })

  test('the whole is the open tasks one after another, ending at the latest end of anything running, never a sum', () => {
    let c = todo(newCockpit(T0, 's'), 0, ['in_progress', 'pending', 'pending', 'pending'])
    c = todo(c, 4, ['completed', 'in_progress', 'pending', 'pending'])
    c = todo(c, 10, ['completed', 'completed', 'in_progress', 'pending'])
    // Pace: the median of 4m and 6m, 5m. Task 3 started at 10, so it ends at 15; task 4 at 20.
    const now = T0 + 12 * MINUTE
    const eta = estimate(c, now)
    expect(eta?.tasks?.pace).toEqual({ ms: 5 * MINUTE, basis: 'list', samples: 2 })
    expect(eta?.tasks?.stretches.map(s => [(s.from - T0) / MINUTE, (s.to - T0) / MINUTE])).toEqual([
      [10, 15],
      [15, 20],
    ])
    expect(eta?.leftMs).toBe(8 * MINUTE)
    // 12 of the 20 minutes from the first start to the expected end have passed.
    expect(Math.round((eta?.fraction ?? 0) * 1000)).toBe(600)
    // A subagent that usually takes longer runs past the list: the whole ends with it.
    let d = agent(c, 'x1', 'Explore', 0, 9)
    d = agent(d, 'x2', 'Explore', 0, 11)
    d = agent(d, 'x3', 'Explore', 11)
    const both = estimate(d, now)
    expect(both?.agents.map(a => [(a.to - T0) / MINUTE, a.typicalMs / MINUTE])).toEqual([[21, 10]])
    expect(both?.leftMs).toBe(9 * MINUTE)
    // A type never seen finish has no usual length: it is not guessed and adds nothing.
    expect(estimate(agent(c, 'y1', 'Plan', 11), now)?.agents).toEqual([])
  })

  test('past its usual length a task is given half its usual length more, a minute at most; a done list is a crossing made', () => {
    let c = todo(newCockpit(T0, 's'), 0, ['in_progress', 'pending', 'pending'])
    c = todo(c, 2, ['completed', 'in_progress', 'pending'])
    c = todo(c, 4, ['completed', 'completed', 'in_progress'])
    // The third has run 30 minutes against a 2-minute pace.
    const late = estimate(c, T0 + 34 * MINUTE)
    expect(late?.leftMs).toBe(MINUTE)
    // Tasks of 20 seconds: one just started is given its 20 seconds, never a whole minute.
    const at = (s: number) => T0 + s * 1000
    const write = (q: Cockpit, s: number, st: ('pending' | 'in_progress' | 'completed')[]) => {
      const call = { at: at(s), id: `q${s}`, tool: 'TodoWrite', input: { todos: st.map((status, i) => ({ content: `Q ${i}`, status, activeForm: `Q ${i}` })) } }
      return onToolEnd(onToolStart(q, call), { ...call, outcome: 'ok', text: 'ok', result: { oldTodos: [], newTodos: call.input.todos } })
    }
    let quick = write(newCockpit(T0, 's'), 0, ['in_progress', 'pending', 'pending'])
    quick = write(quick, 20, ['completed', 'in_progress', 'pending'])
    quick = write(quick, 40, ['completed', 'completed', 'in_progress'])
    expect(estimate(quick, at(41))?.leftMs).toBe(19_000)
    // Past it, half of 20 seconds more.
    expect(estimate(quick, at(75))?.leftMs).toBe(10_000)
    c = todo(c, 35, ['completed', 'completed', 'completed'])
    const done = estimate(c, T0 + 36 * MINUTE)
    expect(done).toMatchObject({ isDone: true, fraction: 1, leftMs: 0 })
    // With nothing measured and no list there is no estimate at all.
    expect(estimate(newCockpit(T0, 's'), T0)).toBeUndefined()
  })

  test('finished lengths are kept as they happen: tasks once done, subagents by type, a rewritten list keeping what it measured', () => {
    let c = todo(newCockpit(T0, 's'), 0, ['in_progress', 'pending'])
    c = todo(c, 3, ['completed', 'in_progress'])
    expect(c.durations.tasks).toEqual([3 * MINUTE])
    // A new list replaces the old one; the length measured stays.
    c = todo(c, 5, ['in_progress', 'pending', 'pending'], 'fresh')
    expect(c.durations.tasks).toEqual([3 * MINUTE])
    c = agent(c, 'a1', 'Explore', 5, 9)
    expect(c.durations.agents).toEqual({ Explore: [4 * MINUTE] })
    // The same change seen twice measures nothing twice.
    expect(noteLengths(c, c)).toBe(c.durations)
  })

  test("other sessions' lengths, newest first, read while the old records are pruned; this session's own left out", async () => {
    const data = new Map<string, unknown>()
    const kv: KV = {
      get: async key => data.get(key),
      set: async (key, value) => void data.set(key, value),
      delete: async key => void data.delete(key),
      keys: async () => [...data.keys()],
    }
    // As a version-7 cockpit wrote them: lengths of tasks and subagents, no turns.
    const record = (sid: string, savedAt: number, durations?: Omit<Durations, 'turns'>) => ({ v: 1, savedAt, cockpit: { sid, ...(durations ? { durations } : {}) } })
    data.set('s:old', record('old', T0 - 2 * MINUTE, { tasks: [MINUTE * 2], agents: { Explore: [MINUTE * 3] } }))
    data.set('s:new', record('new', T0 - MINUTE, { tasks: [MINUTE * 4, MINUTE * 5], agents: {} }))
    data.set('s:me', record('me', T0, { tasks: [MINUTE * 9], agents: {} }))
    // Version 6's records hold no lengths: they add none.
    data.set('s:v02', record('v02', T0 - 3 * MINUTE))
    data.set('s:gone', record('gone', T0 - 8 * 24 * 60 * MINUTE, { tasks: [MINUTE], agents: {} }))
    const priors = await surveySessions(kv, 'me', T0)
    expect(priors.tasks).toEqual([MINUTE * 5, MINUTE * 4, MINUTE * 2])
    expect(priors.agents).toEqual({ Explore: [MINUTE * 3] })
    expect(data.has('s:gone')).toBe(false)
    expect(priorsOf([empty()])).toEqual(empty())
    expect(asDurations({ tasks: [MINUTE, 'x', -1, 2], agents: { Plan: [MINUTE, null] } })).toEqual({ tasks: [MINUTE], agents: { Plan: [MINUTE] }, turns: [] })
  })

  test("a version-6 cockpit is read on, its lengths starting empty", () => {
    const { durations: _d, ...old } = newCockpit(T0, 's')
    const read = asCockpit({ ...old, v: 6 })
    expect(read?.v).toBe(MODEL_VERSION)
    expect(read?.durations).toEqual(empty())
  })
})
