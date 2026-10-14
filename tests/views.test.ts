import { describe, expect, test } from 'claude-code/testing'

import { checkMatrix, costChart, fileBars } from '../src/charts'
import { barCells, barLine, barParts, SOURCE_COLORS, type ContextSplit } from '../src/context'
import { EN } from '../src/locales/en'
import { LOCALES, resolveLocale, t, type Key } from '../src/i18n'
import { newCockpit, onReading, onStep, onToolEnd, onToolStart, onTurnEnd, onTurnStart, type Cockpit } from '../src/model'
import { bodyKeys, markdownLines, partRows, sumRows, type BodyPart } from '../src/panes'
import { clampTop, followed, maxTop, overflows, scrolled, windowRows } from '../src/pin'
import { readingsOf } from '../src/tiles'
import { summaryLine } from '../src/top'
import { asView, hintLine } from '../src/views'
import { plain } from '../src/text'
import { at, MINUTE } from './kit'

const T0 = at(2026, 10, 14, 10)
const view = (now = T0) => ({ now, locale: 'en' as const, days: [], today: '2026-10-14' })

/** `n` finished turns, each with its context size and cost as given. */
function turns(sizes: readonly number[], costs: readonly (number | undefined)[] = []): Cockpit {
  let c = newCockpit(T0 - 3 * 60 * MINUTE, 's')
  sizes.forEach((size, i) => {
    const t0 = T0 - (sizes.length - i) * 10 * MINUTE
    c = onTurnStart(c, { at: t0, turnId: `t${i}`, text: 'go', costUsd: costs.slice(0, i).reduce<number>((a, b) => a + (b ?? 0), 0) })
    c = onStep(c, { at: t0 + MINUTE, startedAt: t0, turnId: `t${i}`, usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: size - 1000, cache_creation_input_tokens: 0 } })
    c = onTurnEnd(c, { at: t0 + 5 * MINUTE, turnId: `t${i}`, tokens: 10_000, durationMs: 5 * MINUTE, isAborted: false })
    if (costs[i] !== undefined) c = onReading(c, { at: t0 + 5 * MINUTE + 1000, costUsd: costs.slice(0, i + 1).reduce<number>((a, b) => a + (b ?? 0), 0), contextTokens: size, contextWindow: 1_000_000, contextPct: size / 10_000, pushed: true })
  })
  return { ...c, autoCompact: { at: T0, turn: sizes.length, isOn: true, threshold: 800_000 } }
}

describe('the pinned window', () => {
  test('its rows are the pane less the header and the hint; it moves within the body, a page key by a window less a row', () => {
    expect(windowRows(43, 3, 1)).toBe(39)
    expect(windowRows(3, 3, 1)).toBe(1)
    expect([maxTop(51, 39), maxTop(20, 39)]).toEqual([12, 0])
    expect([clampTop(-4, 51, 39), clampTop(40, 51, 39), clampTop(5.4, 51, 39)]).toEqual([0, 12, 5])
    // An arrow or a wheel tick: its own rows. A page key (by the pane's rows, PageDown and End alike): a window less a row.
    expect(scrolled(0, 1, 43, 120, 39)).toBe(1)
    expect(scrolled(0, 43, 43, 120, 39)).toBe(38)
    expect(scrolled(60, -43, 43, 120, 39)).toBe(22)
    expect(scrolled(80, 43, 43, 120, 39)).toBe(81)
    expect(scrolled(81, 43, 43, 120, 39)).toBe(81)
    // The focus on a press out of sight: the least move that shows it whole, none when it shows.
    expect(followed(0, 57, 1, 120, 39)).toBe(19)
    expect(followed(30, 10, 1, 120, 39)).toBe(10)
    expect(followed(10, 20, 1, 120, 39)).toBe(10)
    // Only a body taller than its window is drawn a row taller than the pane, so the arrows scroll it.
    expect([overflows(40, 39), overflows(39, 39)]).toEqual([true, false])
  })

  test("each part's rows and each press's row: what the scroll and focus hooks read", () => {
    const parts: BodyPart[] = [
      { kind: 'lines', lines: [[{ text: 'a' }], [{ text: 'b' }]] },
      { kind: 'blank' },
      { kind: 'back', label: 'back', name: 'COST', title: [] },
      { kind: 'turns', rows: [{ n: 3, line: [], target: 'toolu_3' }, { n: 2, line: [] }, { n: 1, line: [], target: 'toolu_1' }] },
    ]
    expect(parts.map(partRows)).toEqual([2, 1, 1, 3])
    expect(sumRows(parts)).toBe(7)
    expect([...bodyKeys(parts).entries()]).toEqual([
      ['pane-back', { at: 3, height: 1 }],
      ['pane-turn-3', { at: 4, height: 1 }],
      ['pane-turn-1', { at: 6, height: 1 }],
    ])
  })
})

describe('the views', () => {
  test('a stored view read back: the current shape kept, a detail only in the overview, older tabs opening the overview', () => {
    expect(asView({ view: 'turns' })).toEqual({ view: 'turns' })
    expect(asView({ view: 'overview', detail: 'cost' })).toEqual({ view: 'overview', detail: 'cost' })
    expect(asView({ view: 'turns', detail: 'cost' })).toEqual({ view: 'turns' })
    expect(asView({ tab: 'timeline', detail: 'checks' })).toEqual({ view: 'overview' })
    expect([asView(undefined), asView('turns'), asView({ view: 'weather' })]).toEqual([undefined, undefined, undefined])
  })

  test('the hint names the keys of the view in front, the most useful first; until the pane has the keyboard it says how to give it', () => {
    const hint = (s: Parameters<typeof hintLine>[1], width = 120) => plain(hintLine('en', s, width))
    expect(hint({ view: 'overview', isDrilled: false, isFocused: false, canScroll: false })).toBe('click the pane for its keys · Tab, Enter: open a gauge · 1–6: views')
    expect(hint({ view: 'overview', isDrilled: true, isFocused: true, canScroll: true })).toBe('b: back · ↑↓ PgUp PgDn: scroll · 1–6: views · Esc: prompt')
    expect(hint({ view: 'turns', isDrilled: false, isFocused: true, canScroll: false })).toBe('Tab, Enter: go to a turn · 1–6: views · Esc: prompt')
    // Narrow, the parts that fit, never one cut in half.
    expect(hint({ view: 'guide', isDrilled: false, isFocused: true, canScroll: true }, 30)).toBe('↑↓ PgUp PgDn: scroll')
  })

  test('the progress in one line outside the overview: the count, the pond where it has room, the time left, the task', () => {
    let c = onTurnStart(newCockpit(T0 - 30 * MINUTE, 's'), { at: T0 - 10 * MINUTE, turnId: 'live', text: 'go' })
    const list = (statuses: ('pending' | 'in_progress' | 'completed')[], when: number) => {
      const input = { todos: statuses.map((status, i) => ({ content: `Task ${i + 1}`, status, activeForm: `Doing ${i + 1}` })) }
      c = onToolEnd(onToolStart(c, { at: when, id: `todo${when}`, tool: 'TodoWrite', input }), { at: when, id: `todo${when}`, tool: 'TodoWrite', input, outcome: 'ok', text: 'ok' })
    }
    list(['in_progress', 'pending', 'pending', 'pending'], T0 - 9 * MINUTE)
    list(['completed', 'in_progress', 'pending', 'pending'], T0 - 6 * MINUTE)
    list(['completed', 'completed', 'in_progress', 'pending'], T0 - 3 * MINUTE)
    const s = summaryLine(readingsOf(c, view()), 80)
    expect(plain(s.head)).toBe('▸ 2/4 ')
    expect(s.pond?.columns).toBe(18)
    expect(plain(s.tail)).toMatch(/^ ~\dm left · done ~\d\d:\d\d · Task 3$/)
    // Narrow: no room for the pond; the line is cut at its end, never past the pane.
    const narrow = summaryLine(readingsOf(c, view()), 30)
    expect(narrow.pond).toBeUndefined()
    // Between turns, what stands and the last turn.
    expect(plain(summaryLine(readingsOf(newCockpit(T0, 's'), view()), 80).head)).toBe('○ Standing by · No turns yet: the gauges fill as you work')
  })

  test('the handover as lines: headings bold, quotes and lists set in, code as it is, backticks dropped', () => {
    const lines = markdownLines('# Handover\n\n## Mission\n\n> Fix `sum.js`\n\n- [x] done\n- [ ] open _(in progress)_\n- `a.ts` (×2)\n\n```\nnode --test\n```', 40).map(plain)
    expect(lines).toEqual(['Handover', '', 'Mission', '', '│ Fix sum.js', '', '✓ done', '· open (in progress)', '• a.ts (×2)', '', '  node --test'])
  })
})

describe('the instruments\' graphics: each a real reading', () => {
  test('context (one bar): the window across the cell, the used part by source, free space as dots, the buffer hatched', () => {
    // The mock-up's figures: a 200k window compacting at 167k, 84k used: setup 24k, file reads 31k, commands 18k, edits 6k, chat 5k.
    const split: ContextSplit = { at: T0, turn: 3, setup: [{ key: 'tools', tokens: 24_000 }], messages: 60_000, sources: { files: 31_000, commands: 18_000, edits: 6000, chat: 5000 }, items: [] }
    const parts = barParts(split, { tokens: 84_000, window: 200_000, autoCompact: 167_000 })
    const cells = barCells(parts, 39)
    expect(cells).toHaveLength(39)
    // 84k of 200k is 16.4 of 39 cells: the used part ends inside the seventeenth, at an eighth of a cell.
    expect(cells.slice(0, 16).every(cell => cell.fg !== undefined)).toBe(true)
    expect(cells[16]?.glyph).toMatch(/^[▏▎▍▌▋▊▉]$/)
    // The free space to the auto-compact point is dots, the buffer past it hatched: they differ by glyph alone.
    // A cell the dots and the hatching share is the dots' (the first in it): where the dots end, the point is.
    expect(plain(barLine(parts, 39))).toBe('████▋▋█████▋▊███▎················░░░░░░')
    expect(cells.filter(cell => cell.muted).length).toBe(22)
    // Setup first, then the conversation's sources in their fixed order, each in its own colour.
    const line = barLine(parts, 39)
    expect(line[0]).toMatchObject({ text: '████', color: SOURCE_COLORS.setup })
    expect([...new Set(line.map(span => span.color).filter(Boolean))]).toEqual([SOURCE_COLORS.setup, SOURCE_COLORS.chat, SOURCE_COLORS.files, SOURCE_COLORS.edits, SOURCE_COLORS.commands])
    // A cell two sources share is the first's left block over the second's colour.
    expect(line.some(span => span.bgColor !== undefined && /[▏▎▍▌▋▊▉]/.test(span.text))).toBe(true)
    // Auto-compact off: no buffer, the dots run to the window's end.
    expect(barCells(barParts(split, { tokens: 84_000, window: 200_000 }), 39).some(cell => cell.glyph === '░')).toBe(false)
  })

  test('cost: a column a turn, up to 3× the median turn, so a full column is a runaway and one turn alone a third', () => {
    const one = costChart(turns([1000], [0.5]), 13, 4)
    expect(one.unit).toBe('usd')
    // 0.5 of 1.5 is a third of 32 eighths: 11, a full row and three eighths.
    expect(one.lines.map(plain).map(line => line[0])).toEqual([' ', ' ', '▃', '█'])
    // A turn past 3× the median sets the scale itself: the rest stand at their share of it.
    const many = costChart(turns([1000, 1000, 1000, 1000], [0.5, 0.5, 0.5, 3]), 13, 4)
    expect(many.lines.map(plain).map(line => line.slice(0, 4))).toEqual(['   █', '   █', '   █', '▅▅▅█'])
    // Unpriced turns are drawn in tokens.
    expect(costChart(turns([1000, 1000]), 13, 4).unit).toBe('tokens')
  })

  test('checks: a row a kind that ran, a square a run, newest on the right; a chain fails only the kinds it named', () => {
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
    const run = (id: string, command: string, outcome: 'ok' | 'error', text: string) => {
      const e = { at: T0, id, tool: 'Bash', input: { command } }
      c = onToolEnd(onToolStart(c, e), { ...e, outcome, text })
    }
    run('a', 'pnpm test', 'error', 'Exit code 1\n Tests  1 failed | 4 passed (5)')
    run('b', 'npx tsc -p . && pnpm test', 'ok', ' Tests  5 passed (5)')
    run('c', 'pnpm lint', 'ok', '')
    const rows = checkMatrix(c, 'en', 13, 4).map(plain)
    expect(rows).toEqual(['test ■■', 'type ■', 'lint ■'])
    const squares = checkMatrix(c, 'en', 13, 4)[0]?.slice(1).map(span => span.tone)
    expect(squares).toEqual(['bad', 'ok'])
  })

  test('files: a thin bar each against the most edited, the name and count after; the rest counted on the last row', () => {
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'go' })
    const edits: [string, number][] = [['a.ts', 4], ['b.ts', 2], ['c.ts', 1], ['d.ts', 1], ['e.ts', 1]]
    let n = 0
    for (const [file, times] of edits) {
      for (let i = 0; i < times; i++) {
        const e = { at: T0 + n++, id: `e${n}`, tool: 'Edit', input: { file_path: `/work/${file}` } }
        c = onToolEnd(onToolStart(c, e), { ...e, outcome: 'ok', text: 'ok' })
      }
    }
    // Of the files edited once, the one edited last comes first.
    expect(fileBars(c, 'en', 34, 4).map(plain)).toEqual(['━━━━━━━━━━ a.ts ×4', '━━━━━      b.ts ×2', '━━╸        e.ts ×1', '           +2 more'])
  })
})

describe('the languages', () => {
  test('auto follows the system locale: ja; zh-CN, zh-SG and zh-Hans to Simplified; zh-TW, zh-HK, zh-MO and zh-Hant to Traditional; else as before', () => {
    const cases: [string | undefined, string][] = [
      ['ja-JP', 'ja'],
      ['ja', 'ja'],
      ['zh-CN', 'zh-Hans'],
      ['zh-SG', 'zh-Hans'],
      ['zh-Hans', 'zh-Hans'],
      ['zh-Hans-CN', 'zh-Hans'],
      ['zh', 'zh-Hans'],
      ['zh-TW', 'zh-Hant'],
      ['zh_TW.UTF-8', 'zh-Hant'],
      ['zh-HK', 'zh-Hant'],
      ['zh-MO', 'zh-Hant'],
      ['zh-Hant', 'zh-Hant'],
      ['zh-Hant-TW', 'zh-Hant'],
      ['ko-KR', 'ko'],
      ['en-US', 'en'],
      ['fr-FR', 'en'],
      [undefined, 'en'],
    ]
    for (const [system, want] of cases) expect(resolveLocale('auto', system), String(system)).toBe(want)
    // A language set in /config wins over the system's; one that is no language follows the system.
    expect([resolveLocale('zh-Hant', 'ko-KR'), resolveLocale('ja', 'en-US'), resolveLocale('klingon', 'ja-JP')]).toEqual(['zh-Hant', 'ja', 'ja'])
  })

  test('every language has every word, with the same placeholders as English, and "Quack:" as it is', () => {
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
    const keys = Object.keys(EN) as Key[]
    for (const L of LOCALES) {
      for (const key of keys) {
        const said = t(L, key)
        expect(said.length, `${L} ${key}`).toBeGreaterThan(0)
        expect(holes(said), `${L} ${key}`).toEqual(holes(EN[key]))
      }
      expect(t(L, 'duck.quack'), L).toBe('Quack:')
    }
  })
})
