// What fills the context. The window as /context breaks it down: the rows it
// counts outside its Messages row (the system prompt, the tools, MCP, custom
// agents, memory files, skills: quackpit's "setup"), the Messages row, the
// free space and the compaction buffer. The Messages row is then split by
// source from the conversation as the next request carries it
// (`$.session.messages({ as: 'api' })`): each part measured (text and tool
// input by characters, a picture by its pixels, Claude's thinking by the size
// of its signature), and the shares scaled to the engine's own Messages row,
// which it reconciles to the API's real usage. So the total is the engine's
// and only the split is quackpit's estimate. Only sizes, tool names and, for
// the largest parts, a path or a command masked as quackpit masks them are
// kept: never the messages' words. Pure.

import { shownCommand } from './checks'
import { clip, relativePath } from './format'
import { maskSecrets } from './mask'
import type { Line, Span } from './text'

/** Where what fills the window came from, in the bar's fixed order: setup first, then the conversation, then the tools. */
export const SOURCE_IDS = ['setup', 'chat', 'thinking', 'files', 'edits', 'commands', 'agents', 'web', 'other'] as const
export type SourceId = (typeof SOURCE_IDS)[number]
/** The sources inside /context's Messages row. */
export type MessageSource = Exclude<SourceId, 'setup'>
export const MESSAGE_SOURCES: readonly MessageSource[] = SOURCE_IDS.filter((id): id is MessageSource => id !== 'setup')

/**
 * One fixed colour a source, never assigned by rank: chosen by drawing
 * candidates on dark and light themes with the README's renderer. Mid-tones
 * that read on both; never amber, red or green, which mean state; one grey
 * only (setup), so no two greys stand side by side as /context's do (early in
 * a session setup and other meet with nothing between them: other is brown);
 * and in the bar's order neighbours differ in hue or in lightness.
 */
export const SOURCE_COLORS: Readonly<Record<SourceId, string>> = {
  setup: '#6e7681',
  chat: '#c9a47e',
  thinking: '#d4a6e8',
  files: '#4c8df6',
  edits: '#1aaeb8',
  commands: '#8a6cf0',
  agents: '#cf5fae',
  web: '#5bb8ee',
  other: '#a3794f',
}

// ------------------------------------------------------------------ /context's rows

/** One of /context's rows, as the adapter flattened it. */
export type CategoryInput = { name: string; tokens: number; kind: string }

/** The breakdown `$.session.usage({ breakdown: 'summary' })` answers, flattened: its rows and the lists beneath them. */
export type BreakdownInput = {
  categories: readonly CategoryInput[]
  mcpTools?: readonly { serverName: string; tokens: number; isLoaded: boolean }[]
  memoryFiles?: readonly { path: string; tokens: number }[]
  agents?: readonly { agentType: string; tokens: number }[]
  skills?: { totalSkills: number; includedSkills: number; tokens: number }
}

/** /context's rows outside Messages, by what they hold; another row keeps its own name. */
export const SETUP_KEYS = ['prompt', 'tools', 'mcp', 'mcpNotes', 'agents', 'memory', 'skills'] as const
export type SetupKey = (typeof SETUP_KEYS)[number]

const SETUP_ROW: Readonly<Record<string, SetupKey>> = {
  'System prompt': 'prompt',
  'System tools': 'tools',
  'MCP tools': 'mcp',
  'MCP server instructions': 'mcpNotes',
  'Custom agents': 'agents',
  'Memory files': 'memory',
  Skills: 'skills',
}

/** The Messages row's name: the one row a breakdown is told apart by its name, since its `kind` is `used` like setup's. */
const MESSAGES_ROW = 'Messages'

export type SetupRow = { key: SetupKey | string; tokens: number }

/** The largest single parts of the conversation: a tool's call and its result, a long prompt, a block of thinking. */
export type ContextItem = {
  source: MessageSource
  /** The tool that made it, for a tool's call and result. */
  tool?: string
  /** What the call was about: a path relative to the project, a command, a host, masked and cut. */
  what?: string
  /** For a part no tool made: what it is. */
  kind?: 'prompt' | 'reply' | 'summary' | 'image' | 'note' | 'notice' | 'thinking'
  /** For one of Claude Code's notes: which kind, from a fixed set (never its words). */
  note?: NoteKind
  tokens: number
}

/** Claude Code's notes by what they are, read from how each begins: the deferred tools' names, hooks' output, the skills in use, the session's environment. */
export type NoteKind = 'tools' | 'hooks' | 'skills' | 'session'

/** Which kind of note a note's body is, where it says; else none. */
export function noteKind(body: string): NoteKind | undefined {
  if (/^The following (?:deferred )?tools (?:are now|just became) available/.test(body)) return 'tools'
  if (/^\S+ hook (?:success|additional context|blocking error|error)|^SessionStart\b|^UserPromptSubmit\b|^(?:Pre|Post)ToolUse\b|^Stop hook\b/.test(body)) return 'hooks'
  if (/^The following skills were invoked/.test(body)) return 'skills'
  if (/^# Environment|^You are powered by the model|^Today's date is|^<total_tokens>|^As you answer the user's questions|^Attribution for git/.test(body)) return 'session'
  return undefined
}

/**
 * What fills the context, as measured at the end of a turn: /context's rows
 * outside Messages (the engine's), its Messages row (the engine's) and that
 * row split by source (quackpit's estimate, in the row's tokens).
 */
export type ContextSplit = {
  at: number
  /** The turns completed when it was measured. */
  turn: number
  setup: SetupRow[]
  /** MCP tools inside the window, by server, the largest first. */
  mcp?: [string, number][]
  /** Memory files: each one's path (from the home folder or the project) and tokens. */
  memory?: [string, number][]
  /** Custom agents described, and the skills listed of those there are. */
  agentCount?: number
  skills?: { included: number; total: number }
  /** /context's Messages row. */
  messages: number
  /** The Messages row by source, in its tokens. */
  sources: Partial<Record<MessageSource, number>>
  /** The largest single parts, the largest first. */
  items: ContextItem[]
  /** Tool schemas loaded on demand, outside the window: never part of the bar. */
  deferred?: { mcp: number; mcpTools: number; tools: number }
}

/** What a context split read back must hold; anything else is none. */
export function asContextSplit(x: unknown): ContextSplit | undefined {
  if (typeof x !== 'object' || x === null) return undefined
  const s = x as Partial<ContextSplit>
  const num = (n: unknown) => typeof n === 'number' && Number.isFinite(n)
  if (!num(s.at) || !num(s.turn) || !num(s.messages) || !Array.isArray(s.setup) || typeof s.sources !== 'object' || s.sources === null || !Array.isArray(s.items)) return undefined
  return s as ContextSplit
}

// ------------------------------------------------------------------ measuring the conversation

/** A message as the Messages API carries it (`$.session.messages({ as: 'api' })`): what is read of it. */
export type ApiMessageInput = { role?: unknown; content?: unknown }

type Block = Record<string, unknown>
const obj = (x: unknown): Block | undefined => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Block) : undefined)
const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined)

/** Where each tool's call and result go. */
const TOOL_SOURCE: Readonly<Record<string, MessageSource>> = {
  Read: 'files',
  Grep: 'files',
  Glob: 'files',
  LS: 'files',
  NotebookRead: 'files',
  LSP: 'files',
  Write: 'edits',
  Edit: 'edits',
  MultiEdit: 'edits',
  NotebookEdit: 'edits',
  Bash: 'commands',
  PowerShell: 'commands',
  BashOutput: 'commands',
  KillShell: 'commands',
  KillBash: 'commands',
  Monitor: 'commands',
  TaskOutput: 'commands',
  TaskStop: 'commands',
  Agent: 'agents',
  Task: 'agents',
  SendMessage: 'agents',
  Workflow: 'agents',
  TeamCreate: 'agents',
  TeamDelete: 'agents',
  WebFetch: 'web',
  WebSearch: 'web',
  ListMcpResourcesTool: 'web',
  ReadMcpResourceTool: 'web',
  ReadMcpResourceDirTool: 'web',
}

/** A tool's source: its own, an MCP server's (`mcp__…`) as the web's, any other tool's as other. */
export function toolSource(tool: string): MessageSource {
  return TOOL_SOURCE[tool] ?? (tool.startsWith('mcp__') ? 'web' : 'other')
}

/**
 * Claude Code's notes that /context counts in its own rows outside Messages:
 * the skills listed, the memory files, the MCP servers' instructions, the
 * agent types. Measured again as messages, they would count twice.
 */
const SETUP_NOTES: readonly string[] = ['The following skills are available for use with the Skill tool', 'Codebase and user instructions are shown below', '# MCP Server Instructions', 'Available agent types for the Agent tool']

const REMINDER = '<system-reminder>'
const REMINDER_END = '</system-reminder>'

/**
 * A text's own words and the notes Claude Code put in it: it adds its
 * reminders to the conversation inside the last tool result of a message
 * (a deferred tool's arrival, MCP servers' instructions, the token budget),
 * which are its notes and none of the tool's output.
 */
export function splitNotes(text: string): { rest: string; notes: string[] } {
  if (!text.includes(REMINDER)) return { rest: text, notes: [] }
  const notes: string[] = []
  let rest = ''
  let at = 0
  while (at < text.length) {
    const open = text.indexOf(REMINDER, at)
    if (open < 0) break
    const close = text.indexOf(REMINDER_END, open)
    const end = close < 0 ? text.length : close + REMINDER_END.length
    rest += text.slice(at, open)
    notes.push(text.slice(open, end))
    at = end
  }
  rest += text.slice(at)
  return { rest: rest.trim() === '' ? '' : rest, notes }
}

/** Where a user message's text came from, and what it is; `skip` for a note /context counts in setup. */
export function textSource(text: string): { source: MessageSource; kind: NonNullable<ContextItem['kind']>; tool?: string; note?: NoteKind } | 'skip' {
  const t = text.trimStart()
  if (t.startsWith(REMINDER)) {
    const body = t.slice(REMINDER.length).trimStart()
    if (SETUP_NOTES.some(head => body.startsWith(head))) return 'skip'
    // After a compaction, the files read before come back as notes of the call and its result.
    const tool = /^(?:Called the (\S+) tool|Result of calling the (\S+) tool)/.exec(body)
    const name = tool?.[1] ?? tool?.[2]
    if (name) return { source: toolSource(name), kind: 'note', tool: name }
    if (/^Note: \S/.test(body)) return { source: 'files', kind: 'note' }
    const note = noteKind(body)
    return { source: 'other', kind: 'note', ...(note ? { note } : {}) }
  }
  if (t.startsWith('<task-notification>')) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(t)?.[1]?.trim() ?? ''
    return { source: /^(?:Background command|Monitor)\b/.test(summary) ? 'commands' : /^Agent\b|workflow/i.test(summary) ? 'agents' : 'other', kind: 'notice' }
  }
  if (/^<(?:teammate-message|agent-message)\b/.test(t) || /^Another Claude session sent a message/.test(t)) return { source: 'agents', kind: 'notice' }
  if (/^<(?:bash-input|bash-stdout|bash-stderr)>/.test(t)) return { source: 'commands', kind: 'prompt' }
  if (/^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/.test(t)) return { source: 'other', kind: 'note' }
  if (/^This session is being continued from a previous conversation/.test(t)) return { source: 'chat', kind: 'summary' }
  return { source: 'chat', kind: 'prompt' }
}

/**
 * About how many tokens a text takes: a character in four for ASCII, more for
 * other scripts (a Hangul syllable or a kanji is about a token or two).
 */
export function textTokens(text: string): number {
  let wide = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) wide++
  return (text.length - wide) / 4 + wide / 1.5
}

/**
 * Claude's thinking by the size of what came back of it: its words where
 * Claude Code keeps them, else its signature, which carries it encrypted (on
 * 2.1.296 the words are withheld). A signature is about 2.2 characters a
 * token of thinking past a few hundred characters of its own: measured
 * against turns whose reported output was mostly thinking.
 */
export function thinkingTokens(block: Block): number {
  const words = str(block.thinking)
  if (words && words.trim() !== '') return textTokens(words)
  const sealed = str(block.signature) ?? str(block.data) ?? ''
  return Math.max(0, sealed.length - 400) / 2.2
}

/** The most a picture costs: one of about 1.15 megapixels. */
export const IMAGE_MAX_TOKENS = 1600

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** The first bytes of base64 data, at most `max`. */
function headBytes(data: string, max: number): number[] {
  const out: number[] = []
  const end = Math.min(data.length, Math.ceil((max * 4) / 3 / 4) * 4)
  for (let i = 0; i + 3 < end; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | Math.max(0, B64.indexOf(data[i + k] ?? 'A')), 0)
    out.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  return out
}

/** A picture's pixels, from its header: PNG, GIF, WebP and JPEG; undefined for anything else. */
export function imageSize(data: string): { width: number; height: number } | undefined {
  const b = headBytes(data, 64)
  const at = (i: number) => b[i] ?? 0
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return { width: ((at(16) << 24) | (at(17) << 16) | (at(18) << 8) | at(19)) >>> 0, height: ((at(20) << 24) | (at(21) << 16) | (at(22) << 8) | at(23)) >>> 0 }
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return { width: at(6) | (at(7) << 8), height: at(8) | (at(9) << 8) }
  if (at(0) === 0x52 && at(1) === 0x49 && at(8) === 0x57 && at(9) === 0x45) {
    const chunk = String.fromCharCode(at(12), at(13), at(14), at(15))
    if (chunk === 'VP8 ') return { width: (at(26) | (at(27) << 8)) & 0x3fff, height: (at(28) | (at(29) << 8)) & 0x3fff }
    if (chunk === 'VP8L') return { width: 1 + (((at(22) & 0x3f) << 8) | at(21)), height: 1 + (((at(24) & 0xf) << 10) | (at(23) << 2) | ((at(22) & 0xc0) >> 6)) }
    if (chunk === 'VP8X') return { width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)), height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)) }
    return undefined
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    // A JPEG's size is in its frame header, after whatever comes first (its EXIF, its tables).
    const j = headBytes(data, 96 * 1024)
    let i = 2
    while (i + 9 < j.length) {
      if (j[i] !== 0xff) return undefined
      const marker = j[i + 1] ?? 0
      const length = ((j[i + 2] ?? 0) << 8) | (j[i + 3] ?? 0)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: ((j[i + 5] ?? 0) << 8) | (j[i + 6] ?? 0), width: ((j[i + 7] ?? 0) << 8) | (j[i + 8] ?? 0) }
      i += 2 + length
    }
  }
  return undefined
}

/** A picture's tokens: its pixels over 750, once scaled to fit 1568 pixels a side and about 1.15 megapixels. */
export function imageTokens(source: unknown): number {
  const data = str(obj(source)?.data)
  const size = data ? imageSize(data) : undefined
  if (!size || size.width <= 0 || size.height <= 0) return IMAGE_MAX_TOKENS
  let { width, height } = size
  const long = Math.max(width, height)
  if (long > 1568) {
    width = (width * 1568) / long
    height = (height * 1568) / long
  }
  const area = width * height
  if (area > 1_150_000) {
    const k = Math.sqrt(1_150_000 / area)
    width *= k
    height *= k
  }
  return Math.min(IMAGE_MAX_TOKENS, Math.max(1, Math.ceil((width * height) / 750)))
}

/** A document's tokens (a PDF the person attached): its base64 by a rule of thumb, a few hundred a page. */
function documentTokens(source: unknown): number {
  const data = str(obj(source)?.data)
  return data ? data.length * 0.06 : textTokens(JSON.stringify(source ?? '') ?? '')
}

/** A tool result's content: its text, its pictures by their pixels; Claude Code's notes in it kept apart. */
function resultParts(content: unknown): { tokens: number; notes: string[] } {
  if (typeof content === 'string') {
    const { rest, notes } = splitNotes(content)
    return { tokens: textTokens(rest), notes }
  }
  if (!Array.isArray(content)) return { tokens: 0, notes: [] }
  let tokens = 0
  const notes: string[] = []
  for (const part of content) {
    const p = obj(part)
    if (!p) continue
    if (p.type === 'text') {
      const split = splitNotes(str(p.text) ?? '')
      tokens += textTokens(split.rest)
      notes.push(...split.notes)
    } else if (p.type === 'image') tokens += imageTokens(p.source)
    else if (p.type === 'document') tokens += documentTokens(p.source)
    else tokens += textTokens(safeJson(p))
  }
  return { tokens, notes }
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x) ?? ''
  } catch {
    return ''
  }
}

/** What a tool's call was about, masked as quackpit masks what it keeps, and cut. */
function subjectOf(tool: string, input: Block | undefined, root: string | undefined): string | undefined {
  if (!input) return undefined
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  if (path && (tool === 'Read' || tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit' || tool === 'NotebookRead' || tool === 'LS')) return tailOf(maskSecrets(relativePath(path, root)), 40)
  const command = str(input.command)
  if (command && (tool === 'Bash' || tool === 'PowerShell' || tool === 'Monitor')) return shownCommand(command, 40)
  if (tool === 'Grep' || tool === 'Glob') return str(input.pattern) ? clip(maskSecrets(String(input.pattern)), 32) : undefined
  if (tool === 'WebFetch') {
    const url = str(input.url)
    return url ? (/^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1] ?? clip(url, 32)) : undefined
  }
  if (tool === 'WebSearch') return str(input.query) ? clip(maskSecrets(String(input.query)), 32) : undefined
  if (tool === 'Agent' || tool === 'Task' || tool === 'Workflow') return str(input.description) ? clip(maskSecrets(String(input.description)), 32) : undefined
  if (tool.startsWith('mcp__')) {
    const [, server, name] = tool.split('__')
    return server && name ? `${server} · ${name}` : undefined
  }
  return undefined
}

/** A path cut to `max` characters, its end kept: the file's name says most. */
const tailOf = (text: string, max: number) => (text.length > max ? `…${text.slice(-(max - 1))}` : text)

/** The conversation measured: each source's parts summed, in estimated tokens, and the largest parts. */
export type Measured = { raw: Record<MessageSource, number>; items: ContextItem[] }

/** How many of the largest parts are kept. */
export const KEEP_ITEMS = 5

/**
 * The conversation the next request is built from, measured by source: a
 * tool's call and its result go to the tool's source together; the person's
 * words, Claude's replies, the compaction summary and pasted pictures are the
 * chat; Claude's thinking is its own; Claude Code's notes (hook output, the
 * session's surroundings, reminders) and every other tool are other. The
 * notes /context counts in setup are left out. Sizes only.
 */
export function measureMessages(messages: readonly ApiMessageInput[], root?: string): Measured {
  const raw: Record<MessageSource, number> = { chat: 0, thinking: 0, files: 0, edits: 0, commands: 0, agents: 0, web: 0, other: 0 }
  const calls = new Map<string, ContextItem>()
  const items: ContextItem[] = []
  const add = (source: MessageSource, tokens: number, item?: ContextItem) => {
    if (!(tokens > 0)) return
    raw[source] += tokens
    if (item) item.tokens += tokens
  }
  // Claude Code's own notes, each where it belongs: the ones setup counts left out.
  const addText = (text: string) => {
    const from = textSource(text)
    if (from === 'skip') return
    const item: ContextItem = { source: from.source, kind: from.kind, ...(from.tool ? { tool: from.tool } : {}), ...(from.note ? { note: from.note } : {}), tokens: 0 }
    items.push(item)
    add(from.source, textTokens(text), item)
  }
  for (const m of messages) {
    const role = m.role
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []
    for (const part of content) {
      const block = obj(part)
      if (!block) continue
      switch (block.type) {
        case 'text': {
          const text = str(block.text) ?? ''
          if (role === 'assistant') {
            const item: ContextItem = { source: 'chat', kind: 'reply', tokens: 0 }
            items.push(item)
            add('chat', textTokens(text), item)
            break
          }
          // Each note on its own, then what is left: the person's words, a summary, a notice.
          const { rest, notes } = splitNotes(text)
          for (const n of notes) addText(n)
          if (rest !== '') addText(rest)
          break
        }
        case 'thinking':
        case 'redacted_thinking': {
          const item: ContextItem = { source: 'thinking', kind: 'thinking', tokens: 0 }
          items.push(item)
          add('thinking', thinkingTokens(block), item)
          break
        }
        case 'tool_use':
        case 'server_tool_use': {
          const tool = str(block.name) ?? 'tool'
          const source = toolSource(tool)
          const what = subjectOf(tool, obj(block.input), root)
          const item: ContextItem = { source, tool, ...(what ? { what } : {}), tokens: 0 }
          const id = str(block.id)
          if (id) calls.set(id, item)
          items.push(item)
          add(source, textTokens(safeJson(block.input ?? {})), item)
          break
        }
        case 'tool_result':
        case 'web_search_tool_result': {
          const id = str(block.tool_use_id)
          const item = id ? calls.get(id) : undefined
          const result = resultParts(block.content)
          add(item?.source ?? (block.type === 'web_search_tool_result' ? 'web' : 'other'), result.tokens, item)
          for (const n of result.notes) addText(n)
          break
        }
        case 'image': {
          const item: ContextItem = { source: 'chat', kind: 'image', tokens: 0 }
          items.push(item)
          add('chat', imageTokens(block.source), item)
          break
        }
        case 'document': {
          const item: ContextItem = { source: 'chat', kind: 'prompt', tokens: 0 }
          items.push(item)
          add('chat', documentTokens(block.source), item)
          break
        }
        default:
          add('other', textTokens(safeJson(block)))
      }
    }
  }
  const largest = items
    .filter(item => item.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, KEEP_ITEMS)
  return { raw, items: largest }
}

// ------------------------------------------------------------------ the split

/** The breakdown's rows outside Messages that occupy the window, by what they hold. */
function setupRows(b: BreakdownInput): SetupRow[] {
  return b.categories
    .filter(c => c.kind === 'used' && c.name !== MESSAGES_ROW && c.tokens > 0)
    .map(c => ({ key: SETUP_ROW[c.name] ?? clip(c.name, 40), tokens: Math.round(c.tokens) }))
}

/** A memory file's path as the detail shows it: from the project or the home folder, masked, its end kept. */
function memoryPath(path: string, root: string | undefined, home: string | undefined): string {
  const fromProject = relativePath(path, root)
  const shown = fromProject !== path ? fromProject : home && path.startsWith(`${home.replace(/\/+$/, '')}/`) ? `~/${path.slice(home.replace(/\/+$/, '').length + 1)}` : path
  return tailOf(maskSecrets(shown), 48)
}

/**
 * What fills the context, from /context's breakdown and the conversation
 * measured: the setup rows and the Messages row as the engine counts them,
 * and the Messages row split by source in the measured shares.
 */
export function splitOf(b: BreakdownInput, measured: Measured, at: number, turn: number, paths: { root?: string; home?: string } = {}): ContextSplit {
  const messages = Math.max(0, Math.round(b.categories.find(c => c.kind === 'used' && c.name === MESSAGES_ROW)?.tokens ?? 0))
  const total = MESSAGE_SOURCES.reduce((sum, id) => sum + measured.raw[id], 0)
  const scale = total > 0 ? messages / total : 0
  const sources: Partial<Record<MessageSource, number>> = {}
  for (const id of MESSAGE_SOURCES) {
    const tokens = Math.round(measured.raw[id] * scale)
    if (tokens > 0) sources[id] = tokens
  }
  const items = measured.items.map(item => ({ ...item, tokens: Math.round(item.tokens * scale) })).filter(item => item.tokens > 0)
  const servers = new Map<string, number>()
  let deferredTools = 0
  for (const tool of b.mcpTools ?? []) {
    if (tool.isLoaded) servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + tool.tokens)
    else deferredTools++
  }
  const mcp = [...servers.entries()].filter(([, tokens]) => tokens > 0).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([name, tokens]): [string, number] => [clip(name, 40), Math.round(tokens)])
  const memory = (b.memoryFiles ?? []).slice(0, 6).map((f): [string, number] => [memoryPath(f.path, paths.root, paths.home), Math.round(f.tokens)])
  const deferred = b.categories.filter(c => c.kind === 'deferred')
  const deferredMcp = deferred.filter(c => /mcp/i.test(c.name)).reduce((sum, c) => sum + c.tokens, 0)
  const deferredOther = deferred.reduce((sum, c) => sum + c.tokens, 0) - deferredMcp
  return {
    at,
    turn,
    setup: setupRows(b),
    ...(mcp.length > 0 ? { mcp } : {}),
    ...(memory.length > 0 ? { memory } : {}),
    ...((b.agents ?? []).length > 0 ? { agentCount: (b.agents ?? []).length } : {}),
    ...(b.skills && b.skills.totalSkills > 0 ? { skills: { included: b.skills.includedSkills, total: b.skills.totalSkills } } : {}),
    messages,
    sources,
    items,
    ...(deferred.length > 0 ? { deferred: { mcp: Math.round(deferredMcp), mcpTools: deferredTools, tools: Math.round(deferredOther) } } : {}),
  }
}

/** Every source's tokens in a split, setup's as /context's rows sum, the largest first; the empty ones left out. */
export function sourceTokens(split: ContextSplit): { id: SourceId; tokens: number }[] {
  const setup = split.setup.reduce((sum, row) => sum + row.tokens, 0)
  return [{ id: 'setup' as SourceId, tokens: setup }, ...MESSAGE_SOURCES.map(id => ({ id: id as SourceId, tokens: split.sources[id] ?? 0 }))].filter(s => s.tokens > 0).sort((a, b) => b.tokens - a.tokens || SOURCE_IDS.indexOf(a.id) - SOURCE_IDS.indexOf(b.id))
}

// ------------------------------------------------------------------ the bar

/** One stretch of the bar: a source's share of what is used, the free space, the compaction buffer. */
export type BarPart = { id: SourceId | 'free' | 'buffer'; tokens: number }

/** The window as the bar draws it. */
export type BarFill = { tokens: number; window: number; autoCompact?: number }

/**
 * The bar's parts across the whole window: what is used (the fill now, split
 * in the measured shares, in the sources' fixed order), the free space up to
 * the auto-compact point, and the buffer past it (none while auto-compact is
 * off). Deferred tools are outside the window and never part of it.
 */
export function barParts(split: ContextSplit, fill: BarFill): BarPart[] {
  const window = Math.max(1, fill.window)
  const used = Math.max(0, Math.min(window, fill.tokens))
  const point = fill.autoCompact !== undefined ? Math.max(0, Math.min(window, fill.autoCompact)) : window
  const shares = SOURCE_IDS.map(id => ({ id, tokens: id === 'setup' ? split.setup.reduce((sum, row) => sum + row.tokens, 0) : (split.sources[id] ?? 0) }))
  const total = shares.reduce((sum, s) => sum + s.tokens, 0)
  const parts: BarPart[] = total > 0 ? shares.map(s => ({ id: s.id, tokens: (s.tokens / total) * used })) : []
  parts.push({ id: 'free', tokens: Math.max(0, point - used) }, { id: 'buffer', tokens: Math.max(0, window - Math.max(point, used)) })
  return parts
}

/** Whole eighths of a cell for each part, summing to the bar's (largest remainder): no part is given a minimum. */
export function eighths(parts: readonly BarPart[], columns: number): number[] {
  const units = Math.max(0, columns) * 8
  const total = parts.reduce((sum, p) => sum + p.tokens, 0)
  if (total <= 0) return parts.map(() => 0)
  const exact = parts.map(p => (p.tokens / total) * units)
  const whole = exact.map(Math.floor)
  let left = units - whole.reduce((sum, n) => sum + n, 0)
  const order = exact.map((x, i) => ({ i, rest: x - (whole[i] ?? 0) })).sort((a, b) => b.rest - a.rest)
  for (const { i } of order) {
    if (left <= 0) break
    whole[i] = (whole[i] ?? 0) + 1
    left--
  }
  return whole
}

const LEFT = ' ▏▎▍▌▋▊▉█'

/** One cell of the bar as text: its glyph and the sources whose colours it takes. */
export type BarCell = { glyph: string; fg?: SourceId; bg?: SourceId; muted?: true }

/**
 * The bar as text cells, a boundary at an eighth of a cell: a cell two parts
 * share is the first part's left block in its colour over the second's.
 * Where more meet in one cell, the first and the largest of the rest show.
 * The free space is dim dots, the buffer dim hatching (`░`): they differ by
 * glyph, never by colour, so where the dots end is the auto-compact point.
 */
export function barCells(parts: readonly BarPart[], columns: number): BarCell[] {
  const n = eighths(parts, columns)
  const seq: BarPart['id'][] = []
  parts.forEach((p, i) => {
    for (let k = 0; k < (n[i] ?? 0); k++) seq.push(p.id)
  })
  const cells: BarCell[] = []
  for (let x = 0; x < columns; x++) {
    const unit = seq.slice(x * 8, x * 8 + 8)
    const first = unit[0]
    if (first === undefined) {
      cells.push({ glyph: ' ' })
      continue
    }
    const run = unit.filter(id => id === first).length
    const rest = unit.filter(id => id !== first)
    const counts = new Map<BarPart['id'], number>()
    for (const id of rest) counts.set(id, (counts.get(id) ?? 0) + 1)
    const second = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (first === 'free') cells.push({ glyph: '·', muted: true })
    else if (first === 'buffer') cells.push({ glyph: '░', muted: true })
    else if (second === undefined) cells.push({ glyph: '█', fg: first })
    else if (second === 'free' || second === 'buffer') cells.push({ glyph: LEFT[run] ?? '█', fg: first })
    else cells.push({ glyph: LEFT[run] ?? '█', fg: first, bg: second })
  }
  return cells
}

/** The bar as a line of spans in the sources' own colours, neighbours of one look merged. */
export function barLine(parts: readonly BarPart[], columns: number): Line {
  const out: Span[] = []
  for (const cell of barCells(parts, columns)) {
    const span: Span = { text: cell.glyph, ...(cell.fg ? { color: SOURCE_COLORS[cell.fg] } : {}), ...(cell.bg ? { bgColor: SOURCE_COLORS[cell.bg] } : {}), ...(cell.muted ? { tone: 'muted' as const } : {}) }
    const last = out.at(-1)
    if (last && last.color === span.color && last.bgColor === span.bgColor && last.tone === span.tone) last.text += span.text
    else out.push(span)
  }
  return out
}
