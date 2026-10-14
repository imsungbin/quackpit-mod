import { describe, expect, test } from 'claude-code/testing'

import { cautionsOf, cautionText } from '../src/duck'
import { detailOf } from '../src/details'
import { contextNow, contextShare, newCockpit, onCompactPoint, onReading, onStep, onTurnStart, type Cockpit, type TurnRecord } from '../src/model'
import { contextFace, readingsOf } from '../src/tiles'
import { plain } from '../src/text'
import { at, band, EN, start, turn, world } from './kit'

const T0 = at(2026, 10, 11, 10)
const VIEW = { now: T0 + 60_000, locale: 'en' as const, days: [], today: '2026-10-11' }

/** A session at `tokens` of a `window`, auto-compact at `point` (off when undefined). */
function filled(tokens: number, window: number, point: number | undefined): Cockpit {
  let c = onReading(newCockpit(T0, 's'), { at: T0, contextTokens: tokens, contextPct: Math.round((100 * tokens) / window), contextWindow: window })
  c = onCompactPoint(c, { at: T0, isOn: point !== undefined, ...(point !== undefined ? { threshold: point } : {}) })
  return c
}

describe('context against the auto-compact point', () => {
  test('the context tile keeps the ring for the window and says how far the auto-compact point is', () => {
    const face = contextFace(readingsOf(filled(629_000, 1_000_000, 713_000), VIEW))
    expect(plain(face.lines[0])).toBe('63%')
    expect(plain(face.lines[1])).toBe('84k to compact')
    expect(face.graphic).toMatchObject({ kind: 'ring', pct: 63 })
    // Auto-compact off: the tokens, as before.
    expect(plain(contextFace(readingsOf(filled(129_000, 200_000, undefined), VIEW)).lines[1])).toBe('ctx 129k')
  })

  test('the duck cautions within 10% of the auto-compact point while it is on, else at 90% of the window', () => {
    // 1M window, compacting at 967k: 870k is 90% of the way.
    expect(cautionsOf(filled(860_000, 1_000_000, 967_000))).toEqual([])
    const near = cautionsOf(filled(880_000, 1_000_000, 967_000))
    expect(near).toMatchObject([{ kind: 'context', left: 87_000 }])
    expect(near[0] && cautionText(near[0], 'en')).toBe('87k to compact')
    // Off: 90% of the window, as before.
    expect(cautionsOf(filled(170_000, 200_000, undefined))).toEqual([])
    expect(cautionsOf(filled(181_000, 200_000, undefined))).toMatchObject([{ kind: 'context', pct: 91 }])
    // The ring's colour follows the same share: red near the point, though the window is 88% full.
    expect(contextFace(readingsOf(filled(880_000, 1_000_000, 967_000), VIEW)).level).toBe('bad')
  })

  test('"shift change soon" comes at the smaller of 200k tokens (400k in a window over 200k) and 80% of the auto-compact point', () => {
    // A 1M window: 80% of 967k is 774k, long past where quality slips; 400k comes first (200k there was most sessions).
    expect(filled(210_000, 1_000_000, 967_000).shift.state).toBe('armed')
    expect(filled(390_000, 1_000_000, 967_000).shift.state).toBe('armed')
    expect(filled(410_000, 1_000_000, 967_000).shift.state).toBe('showing')
    // A 200k window compacting at 167k: 80% of it, 133.6k.
    expect(filled(130_000, 200_000, 167_000).shift.state).toBe('armed')
    expect(filled(140_000, 200_000, 167_000).shift.state).toBe('showing')
    // Auto-compact off: 80% of the window.
    expect(filled(150_000, 200_000, undefined).shift.state).toBe('armed')
    expect(filled(161_000, 200_000, undefined).shift.state).toBe('showing')
    // A response that carries it past counts as the reading does.
    let c = filled(100_000, 200_000, 167_000)
    c = onTurnStart(c, { at: T0 + 1000, turnId: 't', text: 'go' })
    c = onStep(c, { at: T0 + 2000, startedAt: T0 + 1000, turnId: 't', usage: { input_tokens: 4000, output_tokens: 900, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 32_000 } })
    expect(contextNow(c).tokens).toBe(136_000)
    expect(Math.round(contextShare(contextNow(c)) ?? 0)).toBe(81)
    expect(c.shift.state).toBe('showing')
  })

  test('the breakdown is read once at start-up and at most once a turn; the band shows the point', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { ctxTokens: 120_000, ctxPct: 60, autoCompact: 167_000 } })
    await start($, w)
    expect(w.breakdownReads).toBe(1)
    for (let i = 0; i < 3; i++) await turn($, w, { tools: [{ tool: 'Read', file_path: '/work/a.ts' }] })
    expect(w.breakdownReads).toBe(4)
    // The turns' responses here are tiny; the reading after each says 120k.
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Text', text: '47k to compact' })).toBeDefined()
    await ui.unmount()
  })

  test("the context detail's chart: scaled to the turns while they are far from the point, against the point once they come near; compactions marked either way", () => {
    // A 1M window compacting at 967k, its turns at 100k to 133k: 13% full, as the screenshot's session was.
    const turns = (sizes: number[]): TurnRecord[] => sizes.map((ctx, i) => ({ n: i + 1, startedAt: T0 + i * 60_000, endedAt: T0 + i * 60_000 + 30_000, tokens: 1000, tools: 1, edits: 0, ctx }))
    const far: Cockpit = { ...filled(133_000, 1_000_000, 967_000), history: turns([100_000, 120_000, 133_000]), compactTimes: [T0 + 70_000], compactions: 1 }
    const lines = detailOf(readingsOf(far, VIEW), 'context', 80).lines.map(plain)
    // The largest turn fills its column: the chart's top row has a full block.
    expect(lines.some(line => line.includes('█'))).toBe(true)
    expect(lines.join(' ')).toContain('each turn as it ended, against the largest, 133k; auto-compact is far off at 967k; ⟲ a compaction')
    expect(lines.some(line => line.includes('⟲'))).toBe(true)
    // Past half the way, the chart stands against the point itself.
    const near: Cockpit = { ...filled(600_000, 1_000_000, 967_000), history: turns([300_000, 450_000, 600_000]) }
    expect(detailOf(readingsOf(near, VIEW), 'context', 80).lines.map(plain).join(' ')).toContain('each turn as it ended, against 967k; ⟲ a compaction')
  })
})
