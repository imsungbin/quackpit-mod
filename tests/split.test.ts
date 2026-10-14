import { describe, expect, test } from 'claude-code/testing'

import { barCells, barLine, barParts, imageSize, imageTokens, measureMessages, MESSAGE_SOURCES, SOURCE_COLORS, SOURCE_IDS, sourceTokens, splitOf, textSource, thinkingTokens, type ApiMessageInput, type BreakdownInput, type ContextSplit } from '../src/context'
import { detailOf } from '../src/details'
import { contextLegend, instrumentOf } from '../src/instruments'
import { asCockpit, newCockpit, onCompact, onCompactPoint, onContextSplit, onReading, type Cockpit } from '../src/model'
import { readingsOf } from '../src/tiles'
import { displayWidth, plain } from '../src/text'
import { at, EN, MINUTE, PANE, start, turn, world } from './kit'

const T0 = at(2026, 10, 14, 9)
const VIEW = { now: T0 + MINUTE, locale: 'en' as const, days: [], today: '2026-10-14' }

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Bytes as base64, as a picture's data is carried. */
function base64(bytes: readonly number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[n & 63]! : '=')
  }
  return out
}

const be16 = (n: number) => [(n >> 8) & 255, n & 255]
const be32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]

/** A 1000 by 600 PNG's header, as a Read of a screenshot carries it. */
const PNG = base64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(1000), ...be32(600), 8, 6, 0, 0, 0, ...Array(34).fill(0)])
/** A 3000 by 2000 JPEG's, its EXIF before its frame header, as a pasted photo carries it. */
const JPEG = base64([0xff, 0xd8, 0xff, 0xe1, ...be16(208), ...Array(206).fill(0), 0xff, 0xc0, ...be16(17), 8, ...be16(2000), ...be16(3000), 3, ...Array(30).fill(0)])

/**
 * A conversation shaped as Claude Code 2.1.296 hands it over
 * (`$.session.messages({ as: 'api' })`, as a probe saw it): Claude Code's
 * notes in the first user message, the skills listing and the memory files
 * among them; tool calls paired with their results; thinking with its words
 * withheld and its signature kept; a picture inside a Read's result.
 */
function conversation(): ApiMessageInput[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>\nSessionStart:startup hook success: ready\n</system-reminder>' },
        { type: 'text', text: `<system-reminder>\nThe following skills are available for use with the Skill tool:\n${'x'.repeat(40_000)}\n</system-reminder>` },
        { type: 'text', text: `<system-reminder>\nCodebase and user instructions are shown below. ${'y'.repeat(4000)}\n</system-reminder>` },
        { type: 'text', text: 'Fix the parser in src/parser.ts; my key is sk-ant-abcdefghijklmnopqrstuvwx' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'S'.repeat(2600) },
        { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/work/app/src/parser.ts' } },
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'API_TOKEN=secret123 pnpm test', description: 'Run the tests' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'r1', content: 'a'.repeat(36_000) },
        // Claude Code adds its reminders inside a message's last tool result: its notes, none of the command's output.
        { type: 'tool_result', tool_use_id: 'b1', content: [{ type: 'text', text: `${'b'.repeat(8000)}\n\n<system-reminder>\nThe following deferred tools are now available via ToolSearch.\n${'d'.repeat(400)}\n</system-reminder>\n\n<system-reminder>\n# MCP Server Instructions\n${'m'.repeat(4000)}\n</system-reminder>` }], is_error: false },
      ],
    },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/work/app/notes.md', content: 'c'.repeat(4000) } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'File created successfully at: /work/app/notes.md' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'i1', name: 'Read', input: { file_path: '/work/app/shot.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'i1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done: the parser is fixed.' }] },
  ]
}

/** /context's rows as a `summary` breakdown answered them on 2.1.296, deferred tools among them. */
function breakdown(messages: number): BreakdownInput {
  return {
    categories: [
      { name: 'System prompt', tokens: 4726, kind: 'used' },
      { name: 'System tools', tokens: 27_472, kind: 'used' },
      { name: 'MCP tools', tokens: 823, kind: 'used' },
      { name: 'MCP server instructions', tokens: 846, kind: 'used' },
      { name: 'MCP tools (deferred)', tokens: 132_905, kind: 'deferred' },
      { name: 'System tools (deferred)', tokens: 40_419, kind: 'deferred' },
      { name: 'Custom agents', tokens: 1982, kind: 'used' },
      { name: 'Memory files', tokens: 225, kind: 'used' },
      { name: 'Skills', tokens: 9934, kind: 'used' },
      { name: 'Messages', tokens: messages, kind: 'used' },
      { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
      { name: 'Free space', tokens: 919_616, kind: 'free' },
    ],
    mcpTools: [
      { serverName: 'claude_ai_Claude_Docs', tokens: 823, isLoaded: true },
      { serverName: 'gitnexus', tokens: 26_160, isLoaded: false },
      { serverName: 'playwright', tokens: 7433, isLoaded: false },
    ],
    memoryFiles: [{ path: '/home/test/.claude/CLAUDE.md', tokens: 225 }],
    agents: [
      { agentType: 'karen', tokens: 516 },
      { agentType: 'pr-reviewer', tokens: 41 },
    ],
    skills: { totalSkills: 212, includedSkills: 212, tokens: 9934 },
  }
}

/** A session `tokens` into a window, compacting at `point` (off when undefined), its context measured. */
function measured(tokens: number, window: number, point: number | undefined, split: ContextSplit | undefined): Cockpit {
  let c = onReading(newCockpit(T0, 's'), { at: T0, contextTokens: tokens, contextPct: (100 * tokens) / window, contextWindow: window })
  c = onCompactPoint(c, { at: T0, isOn: point !== undefined, ...(point !== undefined ? { threshold: point } : {}) })
  return split ? onContextSplit(c, split) : c
}

const SETUP = 4726 + 27_472 + 823 + 846 + 1982 + 225 + 9934

describe('what fills the context', () => {
  test("a message's text: Claude Code's notes are other, the ones /context counts in setup are left out, a compaction's files come back as reads", () => {
    expect(textSource('<system-reminder>\nThe following skills are available for use with the Skill tool:\n- a')).toBe('skip')
    expect(textSource('<system-reminder>\nAvailable agent types for the Agent tool:\n- claude')).toBe('skip')
    expect(textSource('<system-reminder>\n# MCP Server Instructions\n')).toBe('skip')
    expect(textSource('<system-reminder>\n# Environment\nYou have been invoked')).toMatchObject({ source: 'other', kind: 'note' })
    expect(textSource('<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/a"}')).toMatchObject({ source: 'files', tool: 'Read' })
    expect(textSource('<system-reminder>\nResult of calling the Bash tool:\nok')).toMatchObject({ source: 'commands' })
    expect(textSource('This session is being continued from a previous conversation that ran out of context.')).toMatchObject({ source: 'chat', kind: 'summary' })
    expect(textSource('<task-notification>\n<task-id>b1</task-id>\n<summary>Background command "Run" completed (exit code 0)</summary>')).toMatchObject({ source: 'commands', kind: 'notice' })
    expect(textSource('<task-notification>\n<task-id>a1</task-id>\n<summary>Agent "Map" finished</summary>')).toMatchObject({ source: 'agents' })
    expect(textSource('Another Claude session sent a message:\n<teammate-message teammate_id="helper">')).toMatchObject({ source: 'agents' })
    expect(textSource('Fix the parser')).toMatchObject({ source: 'chat', kind: 'prompt' })
  })

  test("Claude Code's notes named by what they are, read from how each begins, never by their words", () => {
    const noteOf = (body: string) => {
      const from = textSource(`<system-reminder>\n${body}`)
      return from === 'skip' ? 'skip' : from.note
    }
    expect(noteOf('The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded')).toBe('tools')
    expect(noteOf('The following tools just became available and are ready to use:')).toBe('tools')
    expect(noteOf('SessionStart:compact hook success: ready')).toBe('hooks')
    expect(noteOf('SessionStart hook additional context: <EXTREMELY_IMPORTANT>')).toBe('hooks')
    expect(noteOf('UserPromptSubmit hook success: ok')).toBe('hooks')
    expect(noteOf('The following skills were invoked in this session. Continue to follow these guidelines:')).toBe('skills')
    expect(noteOf("As you answer the user's questions, you can use the following context:\n# gitStatus")).toBe('session')
    expect(noteOf('<total_tokens>14948608 tokens left</total_tokens>')).toBe('session')
    expect(noteOf("Today's date is 2026-10-14.")).toBe('session')
    // Any other note is Claude Code's note, unnamed; the ones /context counts in setup are still left out.
    expect(noteOf("The user hasn't heard from you in a while.")).toBeUndefined()
    expect(noteOf('The following skills are available for use with the Skill tool:')).toBe('skip')
    // In the detail a note says what it is and nothing of its words.
    const messages: ApiMessageInput[] = [
      { role: 'user', content: [{ type: 'text', text: `<system-reminder>\nSessionStart hook additional context: ${'s'.repeat(40_000)}\n</system-reminder>` }, { type: 'text', text: 'Fix the parser' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
    ]
    const split = splitOf(breakdown(48_000), measureMessages(messages, '/work/app'), T0, 1, { root: '/work/app', home: '/home/test' })
    expect(split.items[0]).toMatchObject({ source: 'other', kind: 'note', note: 'hooks' })
    const text = detailOf(readingsOf(measured(96_000, 200_000, 167_000, split), VIEW), 'context', 80).lines.map(plain).join('\n')
    expect(text).toMatch(/■ hooks' output ~\d+k/)
    expect(text).not.toContain('sss')
  })

  test("a picture by its pixels, from its header (PNG, JPEG past its EXIF); thinking by its words, else by its signature's size", () => {
    expect(imageSize(PNG)).toEqual({ width: 1000, height: 600 })
    expect(imageSize(JPEG)).toEqual({ width: 3000, height: 2000 })
    expect(imageTokens({ type: 'base64', data: PNG })).toBe(800)
    // Scaled to fit 1568 a side and about 1.15 megapixels: the most a picture costs.
    expect(imageTokens({ type: 'base64', data: JPEG })).toBe(1534)
    expect(imageTokens({ type: 'url', url: 'https://example.com/a.png' })).toBe(1600)
    expect(thinkingTokens({ type: 'thinking', thinking: 'a'.repeat(400) })).toBe(100)
    expect(Math.round(thinkingTokens({ type: 'thinking', thinking: '', signature: 'S'.repeat(2600) }))).toBe(1000)
    expect(thinkingTokens({ type: 'thinking', thinking: '', signature: 'S'.repeat(300) })).toBe(0)
  })

  test('the conversation measured by source: a call and its result together, the notes setup counts left out, sizes only', () => {
    const m = measureMessages(conversation(), '/work/app')
    // The Read's 36,000 characters and the picture's 800 tokens are file reads (with the calls' inputs); the command's output is commands.
    expect(Math.round(m.raw.files)).toBe(9000 + 800 + 18)
    expect(Math.round(m.raw.commands)).toBe(2000 + 19)
    expect(Math.round(m.raw.thinking)).toBe(1000)
    // What Claude wrote is the call's input: 4,000 characters and the path, with the result's line.
    expect(Math.round(m.raw.edits)).toBe(1000 + 24)
    // The skills listing (40,000 characters), the memory files and the MCP servers' instructions are setup's: not here.
    // The deferred tools' arrival, inside the command's result, is Claude Code's note: other, never the command's.
    const hook = '<system-reminder>\nSessionStart:startup hook success: ready\n</system-reminder>'
    const deferred = `<system-reminder>\nThe following deferred tools are now available via ToolSearch.\n${'d'.repeat(400)}\n</system-reminder>`
    expect(Math.round(m.raw.other)).toBe(Math.round((hook.length + deferred.length) / 4))
    expect(m.raw.chat).toBeLessThan(30)
    // The largest parts: the tool and what it was about, a path from the project, a command masked; never the words.
    expect(m.items[0]).toMatchObject({ source: 'files', tool: 'Read', what: 'src/parser.ts' })
    expect(m.items.find(item => item.tool === 'Bash')).toMatchObject({ source: 'commands', what: 'API_TOKEN=*** pnpm test' })
    expect(m.items.find(item => item.kind === 'thinking')).toMatchObject({ source: 'thinking' })
    const kept = JSON.stringify(m)
    expect(kept).not.toContain('aaaa')
    expect(kept).not.toContain('secret123')
    expect(kept).not.toContain('sk-ant')
  })

  test("the split: /context's rows as it counts them, its Messages row by source in the measured shares; deferred tools apart", () => {
    const split = splitOf(breakdown(12_000), measureMessages(conversation(), '/work/app'), T0, 3, { root: '/work/app', home: '/home/test' })
    expect(split.messages).toBe(12_000)
    // The sources add up to the Messages row (to rounding): the total is the engine's.
    const sum = MESSAGE_SOURCES.reduce((n, id) => n + (split.sources[id] ?? 0), 0)
    expect(Math.abs(sum - 12_000)).toBeLessThanOrEqual(4)
    expect(split.setup.map(row => row.key)).toEqual(['prompt', 'tools', 'mcp', 'mcpNotes', 'agents', 'memory', 'skills'])
    expect(split.setup.reduce((n, row) => n + row.tokens, 0)).toBe(SETUP)
    // MCP tools inside the window by server; the deferred ones only counted apart, never in setup or the bar.
    expect(split.mcp).toEqual([['claude_ai_Claude_Docs', 823]])
    expect(split.deferred).toEqual({ mcp: 132_905, mcpTools: 2, tools: 40_419 })
    expect(split.memory).toEqual([['~/.claude/CLAUDE.md', 225]])
    expect(split.skills).toEqual({ included: 212, total: 212 })
    expect(split.agentCount).toBe(2)
    // The ranking: setup, then the file reads.
    expect(sourceTokens(split).slice(0, 3).map(s => s.id)).toEqual(['setup', 'files', 'commands'])
  })

  test("the colours: one fixed a source, never by rank; never amber, red or green, which mean state; one grey only", () => {
    expect(new Set(Object.values(SOURCE_COLORS)).size).toBe(SOURCE_IDS.length)
    const hsl = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const l = (max + min) / 2
      const d = max - min
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
      const h = d === 0 ? 0 : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4)
      return { h: (h + 360) % 360, s, l }
    }
    for (const [id, hex] of Object.entries(SOURCE_COLORS)) {
      const { h, s } = hsl(hex)
      const isRed = (h < 20 || h > 340) && s > 0.35
      const isAmber = h >= 20 && h < 70 && s > 0.5
      const isGreen = h >= 70 && h < 165 && s > 0.3
      expect([id, isRed || isAmber || isGreen]).toEqual([id, false])
    }
    // One grey, setup's: early in a session setup and other meet with nothing between them, and two greys there would read as one.
    const greys = Object.entries(SOURCE_COLORS).filter(([, hex]) => hsl(hex).s < 0.2)
    expect(greys.map(([id]) => id)).toEqual(['setup'])
    expect([SOURCE_IDS[0], SOURCE_IDS.at(-1)]).toEqual(['setup', 'other'])
    // Ranked otherwise, a source keeps its colour.
    const split: ContextSplit = { at: T0, turn: 1, setup: [{ key: 'tools', tokens: 1000 }], messages: 9000, sources: { thinking: 6000, files: 3000 }, items: [] }
    const legend = contextLegend(readingsOf(measured(50_000, 200_000, 167_000, split), VIEW), 60)
    expect(legend.filter(span => span.text === '■').map(span => span.color)).toEqual([SOURCE_COLORS.thinking, SOURCE_COLORS.files, SOURCE_COLORS.setup])
  })

  test('the bar: eighth-cell boundaries, no part given a minimum, the dots ending at the auto-compact point; a 1M window; auto-compact off', () => {
    const split = splitOf(breakdown(12_000), measureMessages(conversation(), '/work/app'), T0, 3)
    // A 1M window, 59.6k used: the used part is a few cells of a 39-cell bar, the rest dots, the last 33k hatched.
    const big = barCells(barParts(split, { tokens: 59_600, window: 1_000_000, autoCompact: 967_000 }), 39)
    expect(big.filter(cell => cell.fg !== undefined).length).toBe(3)
    expect(big.at(-1)?.glyph).toBe('░')
    expect(big.filter(cell => cell.glyph === '░').length).toBe(1)
    // Tiny parts take no cell of their own: the bar never overflows its width.
    for (const columns of [13, 26, 39, 46, 60]) expect(barCells(barParts(split, { tokens: 100_000, window: 200_000, autoCompact: 167_000 }), columns)).toHaveLength(columns)
    // Off: no buffer at all.
    const off = barParts(split, { tokens: 100_000, window: 200_000 })
    expect(off.find(p => p.id === 'buffer')?.tokens).toBe(0)
    expect(barLine(off, 39).map(span => span.text).join('')).not.toContain('░')
  })

  test('the instrument: the fill and what is left, one bar across its cell, the three largest sources in a legend; no numbers', () => {
    const split = splitOf(breakdown(48_000), measureMessages(conversation(), '/work/app'), T0, 3)
    const r = readingsOf(measured(84_000, 200_000, 167_000, split), VIEW)
    const full = instrumentOf(r, 'context', 39, 'full')
    expect(full.graphic).toBeUndefined()
    expect(full.words.map(plain)).toEqual(['42% · 83k left', plain(full.words[1] ?? []), '■ setup  ■ file reads  ■ commands', 'no compaction yet'])
    expect(plain(full.words[1] ?? [])).toHaveLength(39)
    expect(full.bar?.row).toBe(1)
    // Small: three rows, the compactions' line goes; the legend keeps what fits of its three.
    const small = instrumentOf(r, 'context', 26, 'small')
    expect(small.words.map(plain)).toEqual(['42% · 83k left', plain(small.words[1] ?? []), '■ setup  ■ file reads'])
    // Auto-compact off: what is left is to the window's end.
    expect(plain(instrumentOf(readingsOf(measured(84_000, 200_000, undefined, split), VIEW), 'context', 39, 'full').words[0] ?? [])).toBe('42% · 116k left')
    // Every legend in every language inside its cell.
    for (const L of ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant'] as const) {
      for (const w of [26, 27, 34, 39, 46, 47]) {
        const cell = instrumentOf(readingsOf(measured(84_000, 200_000, 167_000, split), { ...VIEW, locale: L }), 'context', w, w < 33 ? 'small' : 'full')
        for (const line of cell.words) expect([L, w, displayWidth(plain(line)) <= w]).toEqual([L, w, true])
      }
    }
  })

  test("no reading yet (a fresh session, just after a compaction): no bar, and the words as before; a compaction drops the split it replaced", () => {
    const split = splitOf(breakdown(48_000), measureMessages(conversation()), T0, 3)
    const fresh = instrumentOf(readingsOf(onContextSplit(newCockpit(T0, 's'), split), VIEW), 'context', 39, 'full')
    expect(fresh.bar).toBeUndefined()
    expect(fresh.words.map(plain)).toEqual(['—', 'no reading yet', 'no compaction yet'])
    const compacted = onCompact(measured(84_000, 200_000, 167_000, split), { at: T0 + 1000, isSkipped: false, isPrecompute: false })
    expect(compacted.ctx).toBeUndefined()
    expect(instrumentOf(readingsOf(compacted, { ...VIEW, now: T0 + 2000 }), 'context', 39, 'full').bar).toBeUndefined()
    // A split that does not read is dropped alone; the cockpit stays.
    const odd = asCockpit({ ...measured(84_000, 200_000, 167_000, split), ctx: { at: 'x' } })
    expect(odd?.ctx).toBeUndefined()
    expect(odd?.reading?.contextTokens).toBe(84_000)
  })

  test("the detail: every source with its tokens and share, setup's rows, the largest parts, the deferred tools apart, how it was measured", () => {
    const split = splitOf(breakdown(48_000), measureMessages(conversation(), '/work/app'), T0, 3, { root: '/work/app', home: '/home/test' })
    const lines = detailOf(readingsOf(measured(96_000, 200_000, 167_000, split), VIEW), 'context', 80).lines.map(plain)
    const text = lines.join('\n')
    expect(lines[0]).toBe('auto-compacts at 167k: 71k to go')
    expect(lines[1]).toBe('What fills it, as measured at 09:00:')
    // setup is /context's own figure; the rest is split by quackpit, with a ~.
    expect(lines[2]).toMatch(/^■ setup +46k +49%$/)
    expect(lines.some(line => /^■ file reads +~\d+k +\d+%$/.test(line))).toBe(true)
    expect(text).toContain('MCP tools')
    expect(text).toContain('claude_ai_Claude_Docs 823')
    expect(text).toContain('~/.claude/CLAUDE.md 225')
    expect(text).toContain('212 of 212 listed')
    expect(text).toContain('The largest parts:')
    expect(text).toMatch(/■ Read src\/parser\.ts ~\d+k/)
    expect(lines.join(' ')).toContain('Outside the window, loaded when used: MCP tools 133k (2 tools) · system tools 40k')
    expect(text).toContain("How it is measured: the total and setup are Claude Code's own count")
    expect(lines.every(line => displayWidth(line) <= 80)).toBe(true)
  })

  test('in a session: the breakdown and the conversation are read once at start-up and at most once a turn, never in full, and again after a compaction', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { ctxTokens: 84_000, ctxPct: 42, autoCompact: 167_000 } })
    w.breakdown = { categories: breakdown(48_000).categories as unknown[], mcpTools: [], memoryFiles: [], agents: [] }
    w.apiMessages = conversation()
    await start($, w)
    expect([w.breakdownReads, w.apiReads]).toEqual([1, 1])
    for (let i = 0; i < 3; i++) await turn($, w, { tools: [{ tool: 'Read', file_path: '/work/a.ts' }] })
    expect([w.breakdownReads, w.apiReads, w.fullReads]).toEqual([4, 4, 0])
    // The pane draws the bar's text in the sources' own colours, and the legend names the largest.
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...PANE })
    const colored = await ui.findAll({ type: 'Text' })
    expect(colored.some(node => node.props.color === SOURCE_COLORS.setup)).toBe(true)
    expect(await ui.find({ type: 'Text', text: ' file reads' })).toBeDefined()
    await ui.unmount()
    // A compaction, which no reading follows: what fills the window is measured at once.
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'Fix the parser', toolUses: [] }] })
    await w.clock.settle()
    expect(w.apiReads).toBe(5)
    await turn($, w)
    // The desktop draws it as SVG.
    const desk = await $.ui.mount({ plugin: 'quackpit', surface: 'desktop', ...PANE })
    const svgs = await desk.findAll({ type: 'Svg' })
    expect(svgs.some(node => String(node.props.source).includes(SOURCE_COLORS.setup))).toBe(true)
    await desk.unmount()
  })
})
