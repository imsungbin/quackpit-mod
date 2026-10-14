import { describe, expect, test } from 'claude-code/testing'

import { asDurations, priorsOf, type Durations } from '../src/eta'
import { addWords, squeeze } from '../src/format'
import { asCockpit, limitsAt, MODEL_VERSION, newCockpit, onReading, onStep, onTurnEnd, onTurnStart, type Cockpit } from '../src/model'
import { toRecord } from '../src/record'
import { surveySessions, type KV } from '../src/store'
import { at, MINUTE } from './kit'

const T0 = at(2026, 10, 12, 9)

/** A turn of `minutes` that ended `minutes` after it began at `from` minutes past T0. */
function turnOf(c: Cockpit, id: string, from: number, minutes: number, isAborted = false): Cockpit {
  const started = onTurnStart(c, { at: T0 + from * MINUTE, turnId: id, text: 'go' })
  return onTurnEnd(started, { at: T0 + (from + minutes) * MINUTE, turnId: id, tokens: 100, durationMs: minutes * MINUTE, isAborted })
}

function memory(): { kv: KV; data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    kv: {
      get: async key => data.get(key),
      set: async (key, value) => void data.set(key, value),
      delete: async key => void data.delete(key),
      keys: async () => [...data.keys()],
    },
  }
}

describe('what a turn keeps for the estimates', () => {
  test("each finished turn's length is kept, an interrupted one left out, the last 60", () => {
    let c = turnOf(newCockpit(T0, 's'), 'a', 0, 2)
    c = turnOf(c, 'b', 3, 0.5)
    c = turnOf(c, 'c', 4, 9, true)
    expect(c.durations.turns).toEqual([2 * MINUTE, 30_000])
    for (let i = 0; i < 70; i++) c = turnOf(c, `x${i}`, 20 + i, 0.25)
    expect(c.durations.turns).toHaveLength(60)
  })

  test("other sessions' turn lengths are read with their records, newest first; a version-7 record's history stands in for them", async () => {
    const { kv } = memory()
    const now = T0
    // Version 8 keeps the lengths; version 7 kept only the 20-turn history (an interrupted turn is no sample).
    const newer = toRecord(turnOf(turnOf(newCockpit(T0 - 50 * MINUTE, 'new'), 'a', -50, 1), 'b', -40, 3), T0 - MINUTE)
    const older = {
      v: 1,
      savedAt: T0 - 2 * MINUTE,
      cockpit: {
        sid: 'old',
        durations: { tasks: [], agents: {} },
        history: [
          { n: 1, startedAt: 0, endedAt: 1, durationMs: 4 * MINUTE, tokens: 1, tools: 0, edits: 0 },
          { n: 2, startedAt: 0, endedAt: 1, durationMs: 6 * MINUTE, tokens: 1, tools: 0, edits: 0, aborted: true },
        ],
      },
    }
    // Version 6 kept no lengths at all: its history's turns still count.
    const oldest = { v: 1, savedAt: T0 - 3 * MINUTE, cockpit: { sid: 'oldest', history: [{ n: 1, startedAt: 0, endedAt: 1, durationMs: 2 * MINUTE, tokens: 1, tools: 0, edits: 0 }] } }
    await kv.set('s:new', newer)
    await kv.set('s:old', older)
    await kv.set('s:oldest', oldest)
    const priors = await surveySessions(kv, 'me', now)
    expect(priors.turns).toEqual([3 * MINUTE, MINUTE, 4 * MINUTE, 2 * MINUTE])
    expect(asDurations({ tasks: [], agents: {}, turns: [500, MINUTE, 'x'] })?.turns).toEqual([MINUTE])
    const empty: Durations = { tasks: [], agents: {}, turns: [] }
    expect(priorsOf([empty, { ...empty, turns: [MINUTE, 2 * MINUTE] }]).turns).toEqual([2 * MINUTE, MINUTE])
  })

  test("a version-7 cockpit is read on as version 8's, its history's turns as its lengths", () => {
    const old = { ...turnOf(newCockpit(T0, 's'), 'a', 0, 2), v: 7 } as unknown as Record<string, unknown>
    const { turns: _gone, ...lengths } = (old.durations as Durations)
    const read = asCockpit({ ...old, durations: lengths })
    expect(read?.v).toBe(MODEL_VERSION)
    expect(read?.durations.turns).toEqual([2 * MINUTE])
  })

  test("the turn keeps what it began with and Claude's words so far, masked and held short, never past its end", () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: `Deploy with ANTHROPIC_API_KEY=${key} please` })
    expect(c.turn?.text).toBe('Deploy with ANTHROPIC_API_KEY=*** please')
    const usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    c = onStep(c, { at: T0 + 1000, startedAt: T0, turnId: 't', usage, answer: `I'll run the tests, then fix the parser. Using ${key}.` })
    c = onStep(c, { at: T0 + 2000, startedAt: T0, turnId: 't', usage, answer: '' })
    c = onStep(c, { at: T0 + 3000, startedAt: T0, turnId: 't', usage, answer: 'Tests pass now.' })
    expect(c.turn?.words).toBe("I'll run the tests, then fix the parser. Using ***.\nTests pass now.")
    // A subagent's words are its own.
    expect(onStep(c, { at: T0 + 4000, startedAt: T0, turnId: 't', agentId: 'a1', usage, answer: 'mine' }).turn?.words).toBe(c.turn?.words)
    const ended = onTurnEnd(c, { at: T0 + MINUTE, turnId: 't', tokens: 30, durationMs: MINUTE, isAborted: false })
    expect(JSON.stringify(ended)).not.toContain('Tests pass now')
    expect(JSON.stringify(toRecord(c, T0 + MINUTE))).not.toContain('Tests pass now')
  })

  test('long words keep their head (the plan) and their latest, however often they are added to', () => {
    let words = addWords(undefined, `PLAN ${'a'.repeat(895)}`)
    for (let i = 0; i < 40; i++) words = addWords(words, `step ${i} ${'b'.repeat(100)}`)
    expect(words.length).toBeLessThanOrEqual(1600)
    expect(words.startsWith('PLAN ')).toBe(true)
    expect(words).toContain('\n…\n')
    expect(words.split('\n…\n')).toHaveLength(2)
    expect(words.endsWith(`step 39 ${'b'.repeat(100)}`)).toBe(true)
    expect(squeeze('short', 10)).toBe('short')
    const cut = squeeze(`${'h'.repeat(100)}${'t'.repeat(100)}`, 50)
    expect(cut).toBe(`${'h'.repeat(30)}\n…\n${'t'.repeat(20)}`)
  })

  test("the plan windows are as fresh as this session's last response or pushed reading, never as a read at a turn's start", () => {
    let c = newCockpit(T0, 's')
    expect(limitsAt(c)).toBeUndefined()
    // Read at start-up, before any response: as of that read.
    c = onReading(c, { at: T0, fiveHour: { pct: 10 } })
    expect(limitsAt(c)).toBe(T0)
    c = onReading(c, { at: T0 + MINUTE, fiveHour: { pct: 11 }, pushed: true })
    expect(c.measuredAt).toBe(T0 + MINUTE)
    // Twenty idle minutes later a turn starts: what quackpit reads then is as old as the last push.
    c = onTurnStart(onReading(c, { at: T0 + 21 * MINUTE, fiveHour: { pct: 11 } }), { at: T0 + 21 * MINUTE, turnId: 't', text: 'go' })
    expect(limitsAt(c)).toBe(T0 + MINUTE)
    // Its first response refreshes them (within a point, or Claude Code would have pushed).
    c = onStep(c, { at: T0 + 22 * MINUTE, startedAt: T0 + 21 * MINUTE, turnId: 't', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    expect(limitsAt(c)).toBe(T0 + 22 * MINUTE)
  })
})
