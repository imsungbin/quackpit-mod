import { describe, expect, test } from 'claude-code/testing'

import { addCall } from '../src/ai'
import { cautionFit, type Caution } from '../src/duck'
import { planBand } from '../src/layout'
import type { ContextSplit } from '../src/context'
import { newCockpit, onAgentList, onAgentSpawn, onBackgroundTasks, onContextSplit, onPrompt, onReading, onStep, onToolEnd, onToolStart, onTurnEnd, onTurnStart, onWaitStart, type Cockpit } from '../src/model'
import { addRun } from '../src/jobs'
import { detailOf } from '../src/details'
import { t } from '../src/i18n'
import { digitColumns } from '../src/font'
import { instrumentIds, instrumentOf, instrumentReading, INSTRUMENT_MIN_WIDTH } from '../src/instruments'
import { cautionsLine, cellOf, drillBody, GUTTER, guideBody, historyRows, markdownLines, missionLines, packed, readingsPart, sourceText, type BodyPart } from '../src/panes'
import { barWidth, hintLine, viewBar, VIEW_IDS } from '../src/views'
import { summaryLine } from '../src/top'
import { guideRows } from '../src/guide'
import { buildHandover } from '../src/handover'
import { LOCALES, type Locale } from '../src/i18n'
import { topSection } from '../src/top'
import { DEFAULT_TILES, DUCK_WORDS, heroFace, quietLine, readingsOf } from '../src/tiles'
import { timeBlocks, timeSection } from '../src/timeline'
import { displayWidth, lineWidth, pad, plain, wrapLine, type Line } from '../src/text'
import { at, HOUR, LIMIT_MS, MINUTE } from './kit'

const T0 = at(2026, 10, 12, 14)
const usage = (n: number) => ({ input_tokens: n, output_tokens: 300, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 2000 })

/** Six finished turns of real-looking work, the plan windows read, a failed run last: every cell has words in it. */
function busy(): Cockpit {
  let c = newCockpit(T0 - 2 * HOUR, 's')
  for (let i = 0; i < 6; i++) {
    const t0 = T0 - 100 * MINUTE + i * 12 * MINUTE
    c = onTurnStart(c, { at: t0, turnId: `t${i}`, text: 'go' })
    c = onStep(c, { at: t0 + MINUTE, startedAt: t0, turnId: `t${i}`, usage: usage(4000) })
    const edit = { at: t0 + 2 * MINUTE, id: `e${i}`, tool: 'Edit', input: { file_path: `/work/src/${['grammar', 'lexer', 'index'][i % 3]}.ts` } }
    c = onToolEnd(onToolStart(c, edit), { ...edit, outcome: 'ok', text: 'ok' })
    const run = { at: t0 + 3 * MINUTE, id: `b${i}`, tool: 'Bash', input: { command: 'pnpm test' } }
    c = onToolEnd(onToolStart(c, run), { ...run, at: t0 + 3 * MINUTE + 9000, outcome: i === 5 ? 'error' : 'ok', text: i === 5 ? 'Exit code 1\n Tests  2 failed | 46 passed (48)' : ' Tests  48 passed (48)' })
    c = onTurnEnd(c, { at: t0 + 8 * MINUTE, turnId: `t${i}`, tokens: 40_000, durationMs: 8 * MINUTE, isAborted: false })
  }
  for (const [m, pct] of [[-80, 50], [-60, 56], [-40, 63], [-20, 70], [0, 77]] as const) {
    c = onReading(c, { at: T0 + m * MINUTE, fiveHour: { pct, resetsAt: T0 + 100 * MINUTE }, sevenDay: { pct: 44, resetsAt: T0 + 120 * HOUR }, costUsd: 12.4, contextPct: 41, contextTokens: 410_000, contextWindow: 1_000_000, pushed: true })
  }
  return { ...c, compactions: 1, autoCompact: { at: T0, turn: 6, isOn: true, threshold: 967_000 } }
}

const view = (L: Locale) => ({ now: T0, locale: L, days: [1, 2, 3].map(d => ({ day: `2026-10-0${d}`, tokens: 3_000_000, activeMin: 120 })), today: '2026-10-12' })

/** The lines of every part of a body, at its width. */
function bodyLines(parts: readonly BodyPart[], width: number): { line: Line; width: number }[] {
  return parts.flatMap(p => {
    switch (p.kind) {
      case 'lines':
        return p.lines.map(line => ({ line, width }))
      case 'readings':
        return p.items.map(item => ({ line: [{ text: `▸ ${pad(item.name, p.nameWidth)}` }, ...item.reading], width: p.across === 2 ? p.cellWidth : width }))
      case 'back':
        return [{ line: [{ text: `b: ‹ ${p.label}   ▾ ${p.name}  ` }, ...p.title], width }]
      case 'beside':
        return [...bodyLines(p.left, p.leftWidth), ...bodyLines(p.right, width - p.leftWidth - GUTTER)]
      default:
        return []
    }
  })
}

describe("quackpit's own words fit, in every language", () => {
  test('at the widths people use: the band from 60 to 200, the pane from 56 to 96 (its instruments full from 69, small from 55), in all five languages', { timeoutMs: LIMIT_MS }, () => {
    const cut: string[] = []
    const check = (where: string, line: Line, width: number) => {
      if (lineWidth(line) > width) cut.push(`over ${where}: ${plain(line)}`)
      else if (plain(line).includes('…')) cut.push(`cut ${where}: ${plain(line)}`)
    }
    for (const L of LOCALES) {
      const read = onReading(newCockpit(T0, 's'), { at: T0, contextPct: 6, contextTokens: 56_000, contextWindow: 1_000_000, costUsd: 0.01, pushed: true })
      for (const c of [newCockpit(T0, 's'), read, busy(), onTurnStart(busy(), { at: T0 - 6 * MINUTE, turnId: 'live', text: 'go' })]) {
        const r = readingsOf(c, view(L))
        for (const width of [60, 70, 80, 100, 120, 160, 200]) {
          const plan = planBand({ readings: r, tiles: DEFAULT_TILES, width, rows: 2, maxRows: 6, withDuck: true })
          if (plan.kind === 'grid') for (const faces of plan.lines) for (const f of faces) for (const line of f.lines) check(`${L} band ${width} ${f.id}`, line, f.width - (f.graphic ? f.graphic.cols + 1 : 0))
        }
        for (const width of [56, 60, 64, 70, 76, 86, 96]) {
          // The view bar on one line, the open view's press over its rule; the hint and the summary inside the pane.
          for (const id of VIEW_IDS) if (barWidth(viewBar(L, id, width)) > width) cut.push(`over ${L} pane ${width} bar ${id}`)
          for (const isFocused of [false, true]) for (const id of VIEW_IDS) check(`${L} pane ${width} hint ${id}`, hintLine(L, { view: id, isDrilled: false, isFocused, canScroll: true }, width), width)
          const s = summaryLine(r, width)
          if (lineWidth(s.head) + (s.pond ? s.pond.columns : 0) + lineWidth(s.tail) > width) cut.push(`over ${L} pane ${width} summary`)
          // Each instrument at the size its pane gives it: its title, and every word beside its graphic.
          const twoW = Math.floor((width - GUTTER) / 2)
          for (const size of ['full', 'small'] as const) {
            if (twoW < INSTRUMENT_MIN_WIDTH[size]) continue
            for (const id of instrumentIds(r)) {
              const cell = instrumentOf(r, id, twoW, size)
              const room = twoW - (cell.graphic ? cell.graphic.columns + 1 : 0)
              cell.words.forEach(line => (id === 'files' ? lineWidth(line) > room && cut.push(`over ${L} pane ${width} ${size} ${id}`) : check(`${L} pane ${width} ${size} ${id}`, line, room)))
              check(`${L} pane ${width} ${size} ${id} title`, [{ text: '▾ ' }, ...cell.title], twoW)
            }
          }
          // Compact cells, where a pane is short; the instruments a line each, inline.
          for (const id of instrumentIds(r)) {
            const cell = cellOf(r, id, twoW)
            const chrome = cell.graphic ? cell.graphic.cols + 1 : 0
            cell.lines.forEach(line => check(`${L} pane ${width} compact ${id}`, line, twoW - chrome))
          }
          for (const { line, width: w } of bodyLines([readingsPart(r, width, width >= 70 ? 2 : 1)], width)) if (lineWidth(line) > w) cut.push(`over ${L} pane ${width} readings: ${plain(line)}`)
          // Progress on top: its head, the pond beside its words, the lines under it.
          const top = topSection(r, width)
          check(`${L} pane ${width} top`, top.head, width)
          for (const line of top.under) check(`${L} pane ${width} top under`, line, width)
          if (top.pond) {
            const digits = top.pond.digits ? digitColumns(top.pond.digits.text) + 1 : 0
            const words = Math.max(...top.pond.words.map(lineWidth))
            if (digits + top.pond.columns + 1 + words > width) cut.push(`over ${L} pane ${width} pond`)
          }
          // Each detail inside the pane, in place and beside the list; quackpit's own words in them whole (a command or a path is the person's).
          for (const id of ['pace', 'limits', 'context', 'cost', 'checks', 'files', 'agents', 'session', 'health'] as const) {
            const name = t(L, id === 'limits' ? 'dial.fiveTitle' : id === 'pace' ? 'dial.paceTitle' : `tile.${id}`)
            const parts = drillBody(r, width, { name, detail: detailOf(r, id, width) }, t(L, 'pane.back'), w => ({ name, detail: detailOf(r, id, w) }))
            for (const { line, width: w } of bodyLines(parts, width)) {
              if (lineWidth(line) > w) cut.push(`over ${L} pane ${width} detail ${id}: ${plain(line)}`)
            }
            if (id === 'health' || id === 'pace' || id === 'limits' || id === 'context') for (const line of detailOf(r, id, width).lines) check(`${L} pane ${width} detail ${id}`, line, width)
          }
          const cautions = cautionsLine(r, width)
          if (cautions && lineWidth(cautions) > width) cut.push(`over ${L} pane ${width} cautions`)
          const ai = { on: true, today: '2026-10-12', days: [{ day: '2026-10-12', tally: addCall(undefined, 'answered', usage(1200)) }], scores: { first: { n: 22, ai: 14, history: 8 }, revised: { n: 21, ai: 15, history: 7 } } }
          for (const line of timeBlocks(c, T0, L, width, '1h', r.eta, ai).head) check(`${L} pane ${width} time`, line, width)
          for (const row of historyRows(r, width).rows) check(`${L} pane ${width} turns`, row.line, width)
          // The guide and the handover as the pane sets them: no line past it.
          for (const { line } of bodyLines(guideBody(guideRows(L), width), width)) if (lineWidth(line) > width) cut.push(`over ${L} pane ${width} guide: ${plain(line)}`)
          for (const line of markdownLines(buildHandover({ c, now: T0, locale: L }), width)) if (lineWidth(line) > width) cut.push(`over ${L} pane ${width} handover: ${plain(line)}`)
        }
      }
    }
    expect(cut).toEqual([])
  })

  test("the words of waits and background work fit too: a wait on the person, background work after the turn, every agent, the AI's revisions", { timeoutMs: LIMIT_MS }, () => {
    const cut: string[] = []
    const check = (where: string, line: Line, width: number) => {
      if (lineWidth(line) > width) cut.push(`over ${where}: ${plain(line)}`)
      else if (plain(line).includes('…')) cut.push(`cut ${where}: ${plain(line)}`)
    }
    const over = (where: string, line: Line, width: number) => {
      if (lineWidth(line) > width) cut.push(`over ${where}: ${plain(line)}`)
    }
    const list = (c: Cockpit, at: number) => {
      const input = { todos: [{ content: 'Port the lexer', status: 'completed', activeForm: 'x' }, { content: 'Port the parser', status: 'completed', activeForm: 'x' }, { content: 'Run the suite', status: 'in_progress', activeForm: 'x' }, { content: 'Write the docs', status: 'pending', activeForm: 'x' }] }
      return onToolEnd(onToolStart(c, { at, id: `todo${at}`, tool: 'TodoWrite', input }), { at, id: `todo${at}`, tool: 'TodoWrite', input, outcome: 'ok', text: 'ok', result: {} })
    }
    // Waiting on the person mid-list, a background agent's dialog aside.
    let waiting = list(onTurnStart(busy(), { at: T0 - 9 * MINUTE, turnId: 'live', text: 'go' }), T0 - 8 * MINUTE)
    waiting = onToolStart(waiting, { at: T0 - 2 * MINUTE, id: 'ask', tool: 'AskUserQuestion', input: { questions: [{ question: 'Which parser generator should the new grammar use?' }] } })
    waiting = onAgentSpawn(waiting, { at: T0 - 5 * MINUTE, toolUseId: 'x', agentId: 'bg', type: 'Explore', description: 'Scan the grammar files', background: true, by: 'main' })
    waiting = onWaitStart(waiting, { at: T0 - MINUTE, kind: 'permission', tool: 'Bash', agentId: 'bg', agentType: 'Explore' })
    // After the turn: a background check of a known length, an agent with no usual length, every kind of agent listed.
    let after: Cockpit = { ...busy(), meta: { root: '/work' } }
    after = onTurnStart(after, { at: T0 - 6 * MINUTE, turnId: 'bg', text: 'go' })
    const run = { at: T0 - 5 * MINUTE, id: 'call-sh', tool: 'Bash', input: { command: 'make test-all', description: 'Run the full test suite', run_in_background: true } }
    after = onToolEnd(onToolStart(after, run), { ...run, outcome: 'ok', text: 'running', result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'sh1' } })
    after = onAgentSpawn(after, { at: T0 - 5 * MINUTE, toolUseId: 'p', agentId: 'pl', type: 'reviewer', description: 'Review the diff for style', background: true, by: 'plugin', byName: 'gatekeeper' })
    after = onAgentSpawn(after, { at: T0 - 5 * MINUTE, toolUseId: 'n', agentId: 'ne', type: 'Explore', description: 'Nested scan of the tests', background: true, by: 'agent', byName: 'general-purpose' })
    after = onAgentSpawn(after, { at: T0 - 5 * MINUTE, toolUseId: 'w', agentId: 'wf', type: 'Plan', description: 'Plan the release notes', background: true, by: 'workflow' })
    after = onAgentList(after, T0 - 4 * MINUTE, [{ id: 'tm', status: 'idle', type: 'teammate', description: 'scout', teammateId: 'scout@team' }, { id: 'pl', status: 'running', spawnedBy: 'gatekeeper' }, { id: 'ne', status: 'running', parentId: 'x' }])
    after = onBackgroundTasks(after, T0 - 3 * MINUTE, [{ id: 'sh1', type: 'shell', status: 'running', description: 'Run the full test suite', command: 'make test-all' }])
    after = onTurnEnd(after, { at: T0 - 3 * MINUTE, turnId: 'bg', tokens: 100, durationMs: 3 * MINUTE, isAborted: false })
    const lengths = addRun(undefined, '/work', 'make test-all', 8 * MINUTE, T0 - HOUR)
    // The AI's revision, the turn past it.
    let revised = onTurnStart(busy(), { at: T0 - 12 * MINUTE, turnId: 'ai', text: 'go' })
    revised = { ...revised, turn: revised.turn && { ...revised.turn, asks: [{ n: 1, why: 'first', askedAt: T0 - 11 * MINUTE, elapsedMs: MINUTE, state: 'answered', leftMs: 2 * MINUTE }, { n: 2, why: 'overrun', askedAt: T0 - 7 * MINUTE, elapsedMs: 5 * MINUTE, state: 'answered', leftMs: 3 * MINUTE }] } }
    for (const L of LOCALES) {
      // Found live: a window just reset has no trend yet, and its words were cut in a 71-column pane.
      const fresh = onReading(onTurnStart(newCockpit(T0 - MINUTE, 's'), { at: T0 - MINUTE, turnId: 'f', text: 'go' }), { at: T0 - MINUTE, fiveHour: { pct: 1, resetsAt: T0 + 5 * HOUR - 6 * MINUTE }, pushed: true })
      for (const [name, c, extra] of [['waiting', waiting, {}], ['after', after, { lengths }], ['revised', revised, { aiOn: true }], ['fresh', fresh, {}]] as const) {
        const r = readingsOf(c, { ...view(L), ...extra })
        for (const width of [60, 70, 80, 100, 120, 160, 200]) {
          const plan = planBand({ readings: r, tiles: DEFAULT_TILES, width, rows: 2, maxRows: 6, withDuck: true })
          if (plan.kind === 'grid') {
            for (const faces of plan.lines) {
              for (const f of faces) {
                for (const line of f.lines) {
                  // A background job's name is Claude's own description: it may be cut, never the tag after it.
                  const tag = t(L, 'job.background', { name: '' })
                  if (plain(line).endsWith(tag)) over(`${L} ${name} band ${width} ${f.id}`, line, f.width)
                  else check(`${L} ${name} band ${width} ${f.id}`, line, f.width - (f.graphic ? f.graphic.cols + 1 : 0))
                }
              }
            }
          }
        }
        for (const width of [56, 60, 64, 70, 76, 86, 96]) {
          const top = topSection(r, width)
          check(`${L} ${name} pane ${width} top`, top.head, width)
          for (const line of top.under) over(`${L} ${name} pane ${width} top under`, line, width)
          if (top.pond) {
            const digits = top.pond.digits ? digitColumns(top.pond.digits.text) + 1 : 0
            const words = Math.max(...top.pond.words.map(lineWidth))
            if (digits + top.pond.columns + 1 + words > width) cut.push(`over ${L} ${name} pane ${width} pond`)
            for (const line of top.pond.words) check(`${L} ${name} pane ${width} pond words`, line, width)
          }
          const twoW = Math.floor((width - GUTTER) / 2)
          for (const size of ['full', 'small'] as const) {
            if (twoW < INSTRUMENT_MIN_WIDTH[size]) continue
            for (const id of instrumentIds(r)) {
              const cell = instrumentOf(r, id, twoW, size)
              const room = twoW - (cell.graphic ? cell.graphic.columns + 1 : 0)
              for (const line of cell.words) (id === 'pace' || id === 'five' ? check : over)(`${L} ${name} pane ${width} ${size} ${id}`, line, room)
            }
          }
          for (const id of instrumentIds(r)) {
            const cell = cellOf(r, id, twoW)
            const chrome = cell.graphic ? cell.graphic.cols + 1 : 0
            cell.lines.forEach(line => over(`${L} ${name} pane ${width} compact ${id}`, line, twoW - chrome))
          }
          const s = summaryLine(r, width)
          if (lineWidth(s.head) + (s.pond ? s.pond.columns : 0) + lineWidth(s.tail) > width) cut.push(`over ${L} ${name} pane ${width} summary`)
          // The timeline: no row runs past the pane (a name of the person's or of Claude's may be cut).
          for (const line of timeSection(c, T0, L, width, '1h', r.eta)) over(`${L} ${name} pane ${width} timeline`, line, width)
          for (const id of ['agents', 'pace', 'limits'] as const) for (const line of detailOf(r, id, width).lines) over(`${L} ${name} pane ${width} detail ${id}`, line, width)
        }
      }
    }
    expect(cut).toEqual([])
  })

  test("the hero's sentences have short forms, never a word cut in half: no turns yet, watching since, shift change soon", () => {
    const fresh = readingsOf(newCockpit(T0, 's'), view('ko'))
    expect(plain(heroFace(fresh, 24).lines[1])).toBe('아직 턴이 없어요')
    expect(plain(heroFace(readingsOf(newCockpit(T0, 's'), view('en')), 24).lines[1])).toBe('No turns yet')
    const late = readingsOf({ ...newCockpit(T0, 's'), joinedLate: true }, view('en'))
    expect(plain(heroFace(late, 24).lines[1])).toBe('Watching since 14:00')
    const shift = readingsOf({ ...busy(), shift: { state: 'showing', untilTurn: 9 } }, view('en'))
    expect(plain(heroFace(shift, 24).lines[1])).toBe('shift change soon')
    expect(plain(heroFace(shift, 60).lines[1])).toBe('shift change soon · /quackpit handover')
  })

  test("found after release: the duck's caution, the five-hour rate while it is the window's average, a narrow tile's running job: whole in every language", () => {
    // The band's duck cut its caution to 14 columns: `5h window at…` lost its percent, a runaway turn its factor.
    const cautions: Omit<Caution, 'key' | 'level' | 'isNotify' | 'at'>[] = [
      { kind: 'check', checkKind: 'test' }, { kind: 'check', checkKind: 'typecheck' }, { kind: 'check', checkKind: 'lint' }, { kind: 'check', checkKind: 'build' },
      { kind: 'five', pct: 84 }, { kind: 'five', pct: 100 }, { kind: 'context', pct: 100 }, { kind: 'context', pct: 93, left: 97_000 }, { kind: 'runaway', turn: 123, factor: 12.3 },
    ]
    for (const L of LOCALES) {
      for (const k of cautions) {
        const text = cautionFit({ key: 'k', level: 'warn', isNotify: false, at: T0, ...k }, L, DUCK_WORDS)
        expect(`${L} ${k.kind} ${text}`).not.toContain('…')
        expect(displayWidth(text)).toBeLessThanOrEqual(DUCK_WORDS)
        if (k.kind === 'five' || (k.kind === 'context' && k.left === undefined)) expect(text).toContain(`${k.pct}%`)
        if (k.kind === 'runaway') expect(text).toContain('12.3')
      }
    }
    // The rate's line and what it means were cut at 56 to 64 columns before 3 readings 10 minutes apart were in.
    let early = newCockpit(T0 - 30 * MINUTE, 's')
    early = onReading(early, { at: T0 - 5 * MINUTE, fiveHour: { pct: 10, resetsAt: T0 + 3 * HOUR }, pushed: true })
    early = onReading(early, { at: T0, fiveHour: { pct: 12.4, resetsAt: T0 + 3 * HOUR }, pushed: true })
    // A background job with no length known, after the turn, in the band's narrowest progress tile.
    let job = onTurnStart(newCockpit(T0 - 40 * MINUTE, 's'), { at: T0 - 30 * MINUTE, turnId: 't', text: 'go' })
    job = onBackgroundTasks(job, T0 - 26 * MINUTE, [{ id: 'sh', type: 'shell', status: 'running', description: 'Run the dev server', command: 'pnpm dev' }])
    job = onTurnEnd(job, { at: T0 - 25 * MINUTE, turnId: 't', tokens: 100, durationMs: 5 * MINUTE, isAborted: false })
    for (const L of LOCALES) {
      for (const width of [56, 58, 60, 62, 64, 70, 80, 96]) {
        for (const line of detailOf(readingsOf(early, view(L)), 'limits', width).lines) {
          expect(`${L} ${width} ${plain(line)}`).not.toMatch(/…$/)
          expect(lineWidth(line)).toBeLessThanOrEqual(width)
        }
      }
      for (const width of [20, 22, 24, 26]) {
        const second = heroFace(readingsOf(job, view(L)), width).lines[1] ?? []
        expect(`${L} ${width} ${plain(second)}`).not.toContain('…')
        expect(lineWidth(second)).toBeLessThanOrEqual(width)
      }
    }
  })

  test("a narrow progress tile keeps the time left: the AI's revised answer stands alone where its pond does not fit", () => {
    // Found live in Traditional Chinese: at 24 columns `剩餘 ~2m（AI，已修正）` and its pond did not fit, and the tile said the turn's count instead.
    let c = onTurnStart(newCockpit(T0 - 10 * MINUTE, 's'), { at: T0 - 6 * MINUTE, turnId: 'ai', text: 'go' })
    c = { ...c, turn: c.turn && { ...c.turn, asks: [{ n: 1, why: 'first', askedAt: T0 - 5 * MINUTE, elapsedMs: MINUTE, state: 'answered', leftMs: 2 * MINUTE }, { n: 2, why: 'overrun', askedAt: T0 - MINUTE, elapsedMs: 5 * MINUTE, state: 'answered', leftMs: 3 * MINUTE }] } }
    for (const L of LOCALES) {
      const r = readingsOf(c, { ...view(L), aiOn: true })
      const said = t(L, 'hero.leftAiRevised', { left: '2m' })
      for (let width = displayWidth(said); width <= 40; width++) {
        const face = heroFace(r, width)
        expect(`${L} ${width} ${plain(face.lines[1] ?? []).trim()}`).toEndWith(said)
        expect(lineWidth(face.lines[1] ?? [])).toBeLessThanOrEqual(width)
      }
    }
  })

  test('a head never runs into its words: the mission, the timeline and the session detail make room for the longest head in each language', () => {
    // Found live in Japanese: `キャッシュウォーム: 残り 57m` and `ミッションRun the unit tests`.
    const c = onPrompt(busy(), { at: T0 - 2 * HOUR, text: 'Run the unit tests and fix the bug', isPersonal: true })
    for (const L of LOCALES) {
      const r = readingsOf(c, view(L))
      const lines: Line[] = [...missionLines(r, 71), ...timeBlocks(c, T0, L, 71, '1h').head, ...detailOf(r, 'session', 71).lines]
      const heads = lines.map(line => line[0]).filter(span => span?.bold && span.tone === 'muted')
      expect(heads.length).toBeGreaterThanOrEqual(5)
      for (const head of heads) expect(`${L} ${head?.text}`).toMatch(/\S {2,}$/)
    }
  })

  test("the context's words fit too: the context's bar, its legend and its detail; the quiet line of what waits", { timeoutMs: LIMIT_MS }, () => {
    const cut: string[] = []
    const check = (where: string, line: Line, width: number) => {
      if (lineWidth(line) > width) cut.push(`over ${where}: ${plain(line)}`)
      else if (plain(line).includes('…')) cut.push(`cut ${where}: ${plain(line)}`)
    }
    const over = (where: string, line: Line, width: number) => {
      if (lineWidth(line) > width) cut.push(`over ${where}: ${plain(line)}`)
    }
    // Every source in it, so the legend's longest names stand side by side.
    const split: ContextSplit = {
      at: T0,
      turn: 6,
      setup: [
        { key: 'prompt', tokens: 4726 },
        { key: 'tools', tokens: 27_472 },
        { key: 'mcp', tokens: 823 },
        { key: 'mcpNotes', tokens: 846 },
        { key: 'agents', tokens: 1982 },
        { key: 'memory', tokens: 225 },
        { key: 'skills', tokens: 9934 },
      ],
      mcp: [['docs', 823]],
      memory: [['~/.claude/CLAUDE.md', 225]],
      agentCount: 5,
      skills: { included: 212, total: 212 },
      messages: 364_000,
      sources: { thinking: 150_000, commands: 70_000, files: 60_000, edits: 30_000, chat: 20_000, agents: 15_000, web: 12_000, other: 7000 },
      items: [
        { source: 'files', tool: 'Read', what: 'src/model.ts', tokens: 9000 },
        { source: 'thinking', kind: 'thinking', tokens: 8000 },
        { source: 'chat', kind: 'summary', tokens: 6000 },
        { source: 'commands', tool: 'Bash', what: 'pnpm test', tokens: 4000 },
      ],
      deferred: { mcp: 132_905, mcpTools: 194, tools: 40_419 },
    }
    const filled = onContextSplit(busy(), split)
    // Claude Code's notes among the largest parts, each named by its kind.
    const noted = onContextSplit(busy(), { ...split, items: (['tools', 'hooks', 'skills', 'session'] as const).map((note, i) => ({ source: 'other' as const, kind: 'note' as const, note, tokens: 4000 - i * 500 })) })
    // Teammates idle, an agent waiting, a job queued and two running aside past their hold.
    let quiet = busy()
    for (const i of [0, 1, 2]) quiet = onAgentSpawn(quiet, { at: T0 - HOUR, toolUseId: `tm${i}`, agentId: `tm${i}`, type: 'teammate', description: `Draft the locale table ${i}`, background: true, by: 'main', isTeammate: true })
    quiet = onAgentSpawn(quiet, { at: T0 - HOUR, toolUseId: 'w', agentId: 'wa', type: 'Plan', description: 'Plan the rewrite', background: true, by: 'main' })
    quiet = onAgentList(quiet, T0 - 30 * MINUTE, [...[0, 1, 2].map(i => ({ id: `tm${i}`, status: 'idle', type: 'teammate', description: 'x', teammateId: `tm${i}@team` })), { id: 'wa', status: 'waiting', type: 'Plan', description: 'Plan the rewrite' }])
    quiet = onBackgroundTasks(quiet, T0 - 2 * HOUR, [
      { id: 'bdev', type: 'shell', status: 'running', description: 'Start the development server', command: 'pnpm dev --port 5173' },
      { id: 'bwatch', type: 'shell', status: 'running', description: 'Watch the types', command: 'pnpm tsc --watch' },
      { id: 'bq', type: 'shell', status: 'pending', description: 'Build', command: 'pnpm build' },
    ])
    for (const L of LOCALES) {
      const r = readingsOf(filled, view(L))
      for (const width of [56, 60, 64, 70, 71, 76, 81, 86, 96]) {
        const twoW = Math.floor((width - GUTTER) / 2)
        for (const size of ['full', 'small'] as const) {
          if (twoW < INSTRUMENT_MIN_WIDTH[size]) continue
          const cell = instrumentOf(r, 'context', twoW, size)
          if (!cell.bar) cut.push(`no bar ${L} ${width} ${size}`)
          cell.words.forEach(line => check(`${L} pane ${width} ${size} context`, line, twoW))
          // The legend keeps at least the largest source whole.
          if (plain(cell.words[2] ?? []).split('■').length < 2) cut.push(`no legend ${L} ${width} ${size}`)
        }
        check(`${L} pane ${width} context reading`, instrumentReading(r, 'context'), width)
        // The detail, in place and beside the list: quackpit's own words whole; a path or a command is the person's.
        const name = t(L, 'tile.context')
        const parts = drillBody(r, width, { name, detail: detailOf(r, 'context', width) }, t(L, 'pane.back'), w => ({ name, detail: detailOf(r, 'context', w) }))
        for (const { line, width: w } of bodyLines(parts, width)) over(`${L} pane ${width} context detail`, line, w)
        for (const line of detailOf(r, 'context', width).lines) {
          const text = plain(line)
          if (/src\/model\.ts|pnpm test|CLAUDE\.md|docs/.test(text)) over(`${L} pane ${width} context detail`, line, width)
          else check(`${L} pane ${width} context detail`, line, width)
        }
        for (const line of detailOf(readingsOf(noted, view(L)), 'context', width).lines) {
          if (/CLAUDE\.md|docs/.test(plain(line))) over(`${L} pane ${width} context notes`, line, width)
          else check(`${L} pane ${width} context notes`, line, width)
        }
      }
      const q = readingsOf(quiet, view(L))
      for (const width of [56, 60, 64, 70, 76, 86, 96]) {
        const top = topSection(q, width)
        for (const line of top.under) over(`${L} quiet pane ${width} top under`, line, width)
        const line = quietLine(q, width)
        if (!line) cut.push(`no quiet line ${L} ${width}`)
        // The counts stay whole: only a job's name gives way.
        else if (!plain(line).startsWith(t(L, 'work.idle', { n: 3 }))) cut.push(`quiet line ${L} ${width}: ${plain(line)}`)
        const twoW = Math.floor((width - GUTTER) / 2)
        for (const size of ['full', 'small'] as const) {
          if (twoW < INSTRUMENT_MIN_WIDTH[size]) continue
          instrumentOf(q, 'agents', twoW, size).words.forEach(line => over(`${L} quiet pane ${width} ${size} agents`, line, twoW))
        }
        over(`${L} quiet pane ${width} agents reading`, instrumentReading(q, 'agents'), width)
        const s = summaryLine(q, width)
        if (lineWidth(s.head) + (s.pond ? s.pond.columns : 0) + lineWidth(s.tail) > width) cut.push(`over ${L} quiet pane ${width} summary`)
        for (const line of heroFace(q, Math.max(20, width - 40)).lines) over(`${L} quiet band ${width}`, line, Math.max(20, width - 40))
      }
    }
    expect(cut).toEqual([])
  })

  test('the mission wraps to a second line under its head; the cautions are one line, the duck\'s word first', () => {
    const c = { ...busy(), goal: 'Port the parser to the new grammar, keep the public API stable, and make every test pass' }
    const lines = missionLines(readingsOf(c, view('en')), 50).map(plain)
    expect(lines).toEqual(['MISSION  Port the parser to the new grammar, keep', '         the public API stable, and make every…'])
    // A failed run and a turn that ran away: two cautions, wrapping under their head when narrow.
    const twice = { ...c, history: [...c.history.slice(0, -1), { ...(c.history.at(-1) as Cockpit['history'][number]), runaway: true as const, factor: 3.4 }] }
    expect(plain(cautionsLine(readingsOf(twice, view('en')), 70) ?? [])).toBe('Quack: tests failed · turn 6 cost 3.4× the median')
    expect(plain(cautionsLine(readingsOf(twice, view('ko')), 70) ?? [])).toBe('Quack: 테스트 실패 · 턴 6이 중앙값의 3.4배 비용')
    // None, no line: the overview says nothing when all is quiet.
    expect(cautionsLine(readingsOf(newCockpit(T0, 's'), view('en')), 70)).toBeUndefined()
    for (const L of LOCALES) expect(lineWidth(cautionsLine(readingsOf(twice, view(L)), 30) ?? [])).toBeLessThanOrEqual(30)
  })

  test("the turns table's head stands over its columns by display width, Hangul two columns a character", () => {
    let c = onTurnStart(newCockpit(T0, 's'), { at: T0, turnId: 't', text: 'Fix the parser' })
    c = onTurnEnd(c, { at: T0 + 272_000, turnId: 't', tokens: 48_213, durationMs: 272_000, isAborted: false })
    c = { ...c, history: c.history.map(h => ({ ...h, costUsd: 0.41, tools: 12, edits: 3 })) }
    for (const L of ['en', 'ko'] as const) {
      const h = historyRows(readingsOf(c, { ...view(L), now: T0 + 300_000 }), 70)
      const head = plain(h.head ?? [])
      const row = plain(h.rows[0]?.line ?? [])
      expect(head, L).toBe(L === 'en' ? '  #  start     time   tokens    cost  tools  edits' : '  #   시작     시간     토큰    비용   도구   수정')
      expect(row.startsWith('  1  14:00   4m 32s      48k   $0.41     12      3'), L).toBe(true)
      // The head is exactly as wide as the figures under it.
      expect(displayWidth(head), L).toBe(50)
    }
  })

  test('files over two lines with the rest counted; a label for a turn no person typed is cut, never wider than its room', () => {
    expect(packed(['grammar.ts ×5', 'lexer.ts ×3', 'README.md ×2', 'index.ts ×1', 'a-long-name.ts ×1'], 30, 2)).toEqual(['grammar.ts ×5 · lexer.ts ×3', 'README.md ×2 · index.ts ×1 +1'])
    expect(packed(['x'.repeat(40)], 30, 2)).toEqual([`${'x'.repeat(29)}…`])
    expect(sourceText({ kind: 'report' }, 'en', 12)).toBe('(a subagent…')
    // A name cut where a word ends keeps no space before the ellipsis.
    expect(sourceText({ kind: 'task', name: 'Sleep 15 seconds in background' }, 'en', 40)).toBe('(background task: Sleep 15 seconds in…)')
    expect(wrapLine([{ text: 'one two three four five six', tone: 'muted' }], 9, 2).map(plain)).toEqual(['one two', 'three…'])
    expect(wrapLine([{ text: 'supercalifragilistic' }], 8, 3).map(plain)).toEqual(['supercal', 'ifragili', 'stic'])
  })
})
