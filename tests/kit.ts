// The world beneath quackpit in tests: a mock clock, a store and files the
// test can read, the session's usage, the tools' answers, and recorders for
// everything the mod shows. Imported by the *.test.ts files.

import type { ModelCompleteInput, ModelCompleteResult, ModelUsage, On, PaneOpenArgs, RenderPropsOf, SessionMessage, SessionRateLimit, SessionUsage, ToolCallArgs, TurnUsage } from 'claude-code'
import { mock, type Engine, type MockClock } from 'claude-code/testing'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

/** Local wall-clock time, so tests mean the same in every time zone. */
export function at(y: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(y, month - 1, day, hour, minute).getTime()
}

export type Usage = {
  fiveHour?: number
  /** Minutes from now until the five-hour window resets. */
  fiveResetsIn?: number
  sevenDay?: number
  costUsd?: number
  ctxPct?: number
  ctxTokens?: number
  /** Where auto-compact runs, in tokens; absent, auto-compact is off. */
  autoCompact?: number
  /** The window, 200k unless given. */
  ctxWindow?: number
}

/**
 * What a Bash command answers in the test: exit 0 or not, and its output; or
 * `refused` with the words it was refused in before it ran; or `interrupted`,
 * stopped by Esc while it ran.
 */
export type BashAnswer = { ok: boolean; stdout?: string; stderr?: string; refused?: string; interrupted?: true }

/** Claude Code's words when the person answers no at the permission dialog. */
export const DIALOG_NO =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

/** Claude Code's words when a permission rule refuses the call. */
export const RULE_NO = 'Permission to use Bash with command pnpm test has been denied.'

/** The Bash tool's own words when it will not run a command (here, a leading foreground sleep). */
export const BASH_BLOCKED =
  'Blocked: sleep 25 followed by: pnpm test. To wait for a condition, use Monitor with an until-loop (e.g. `until <check>; do sleep 2; done`). To wait for a command you started, use run_in_background: true.'

export type World = {
  clock: MockClock
  store: Map<string, unknown>
  /** Every key quackpit wrote to the store, in order. */
  storeWrites: string[]
  files: Map<string, string>
  written: { path: string; text: string }[]
  toasts: string[]
  notified: { text: string; title: string | undefined }[]
  copied: string[]
  played: number
  logs: string[]
  opened: PaneOpenArgs[]
  panes: string[]
  closed: string[]
  prompts: { text: string; context?: readonly string[] }[]
  blits: { key: string }[]
  usage: Usage
  usageThrows: boolean
  storeThrows: boolean
  notify: 'sent' | 'throws' | 'disabled'
  /** How the terminal answers the picture probe: shown, or drawn as its alt. */
  pictures: 'shown' | 'alt'
  sid: string
  messages: SessionMessage[]
  bash: (command: string) => BashAnswer
  /** How long a Bash command takes on the mock clock. */
  bashMs: number
  /** When set, a Bash call is put to the person first (the check answers `ask`) and their answer takes this long. */
  askMs?: number
  /**
   * With `askMs`: the ask shows a real permission dialog (`classic.PermissionRequest`,
   * which no hook beneath settles), as it does outside auto mode; without, the
   * auto-mode classifier settles it, as a live run showed, and no dialog shows.
   */
  dialog: boolean
  /** How long the person takes to answer a question (AskUserQuestion) or a plan (ExitPlanMode). */
  askUserMs: number
  /** A settings hook beneath every plugin answers the dialog by itself (`decision: allow`): it never shows. */
  isSettledByHook: boolean
  /** Background tasks the Bash tool has started, by id, with their commands: what a turn's end lists. */
  shells: { id: string; command: string; description?: string }[]
  /** Every tool call the engine ran, in order, with the id it was given. */
  calls: { tool: string; id: string }[]
  /** The test's own engine, to raise what core raises inside a call (its permission check). */
  engine?: Engine
  agents: { id: string; status: string; type?: string; description?: string; parentId?: string; spawnedBy?: string; teammateId?: string }[]
  /** How many times quackpit read `$.session.usage()` directly. */
  usageReads: number
  /** How many of those asked for the context's breakdown. */
  breakdownReads: number
  /** What the breakdown holds besides the auto-compact point: /context's rows and the lists beneath them (none unless the test sets them). */
  breakdown: { categories?: unknown[]; mcpTools?: unknown[]; memoryFiles?: unknown[]; agents?: unknown[]; skills?: unknown }
  /** How many breakdowns asked for `full` (which sends token-count requests): quackpit asks for none. */
  fullReads: number
  /** The conversation as the next request carries it (`$.session.messages({ as: 'api' })`). */
  apiMessages: unknown[]
  /** How many times quackpit read it. */
  apiReads: number
  /** How many redraws quackpit asked for (`$.ui.invalidate`). */
  invalidates: number
  /** What the next model response (`turn.step`) reports it cost. */
  nextStep: TurnUsage
  /** Every `$.model.complete` request the plugin made, as a hook on it reads it. */
  modelCalls: ModelCompleteInput[]
  /** How the model answers one: a canned result, after `modelMs` on the mock clock. */
  modelReply: (e: ModelCompleteInput) => ModelCompleteResult
  modelMs: number
  /** How many `$.model.fork` calls were made: quackpit makes none. */
  forks: number
  /** Every `/config` row the plugin changed (`$.config.set`). */
  configSets: { key: string; value: unknown }[]
  /** What the response of the next step says, besides its cost. */
  nextAnswer: string
  /** The model `$.session.model()` answers; undefined, it throws (nothing to say yet). */
  model: string | undefined
}

/** A model call's cost, as its usage reports it. */
export function modelUsage(input: number, output = 1, cacheRead = 0, cacheWrite = 0): ModelUsage {
  return { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite }
}

/** The model answering with `text`, as `$.model.complete` resolves. */
export function answered(text: string, usage: ModelUsage = modelUsage(900, 2)): ModelCompleteResult {
  return { isAnswered: true, text, usage }
}

export function world(on: On, options: { now: number; store?: Record<string, unknown>; files?: Record<string, string>; usage?: Usage }): World {
  const w: World = {
    clock: mock.clock(on, { now: options.now }),
    // A machine quackpit has run on before (its first-run toast shown), unless the test says otherwise.
    store: new Map(Object.entries({ welcomed: 1, ...options.store }).filter(([, value]) => value !== undefined)),
    storeWrites: [],
    files: new Map(Object.entries(options.files ?? {})),
    written: [],
    toasts: [],
    notified: [],
    copied: [],
    played: 0,
    logs: [],
    opened: [],
    panes: [],
    closed: [],
    prompts: [],
    blits: [],
    usage: { ...options.usage },
    usageThrows: false,
    storeThrows: false,
    notify: 'sent',
    pictures: 'alt',
    sid: 'session-1',
    messages: [],
    bash: () => ({ ok: true, stdout: '' }),
    bashMs: 1500,
    dialog: false,
    askUserMs: 0,
    isSettledByHook: false,
    shells: [],
    calls: [],
    agents: [],
    usageReads: 0,
    breakdownReads: 0,
    breakdown: {},
    fullReads: 0,
    apiMessages: [],
    apiReads: 0,
    invalidates: 0,
    nextStep: usage(0),
    modelCalls: [],
    modelReply: () => ({ isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: modelUsage(0, 0) }),
    modelMs: 1200,
    forks: 0,
    configSets: [],
    nextAnswer: '',
    model: 'claude-test-model',
  }
  const copy = (value: unknown) => (value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown))
  const broken = () => {
    if (w.storeThrows) throw new Error('the store is unavailable')
  }
  on('store.get', ($, e) => (broken(), { value: copy(w.store.get(e.key)) }))
  on('store.set', ($, e) => {
    broken()
    w.storeWrites.push(e.key)
    w.store.set(e.key, copy(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    broken()
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => (broken(), { value: [...w.store.keys()] }))
  mock.env(on, { HOME: '/home/test' })
  on('fs.read', ($, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    w.written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.context === undefined ? { text: e.text } : { text: e.text, context: e.context })
    return { text: e.text }
  })
  on('session.compact', ($, e) => ({ messages: e.messages, tokensBefore: 150_000, tokensAfter: 40_000 }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: w.sid }))
  on('session.root', () => ({ value: '/work' }))
  on('session.model', () => {
    if (w.model === undefined) throw new Error('no model to say yet')
    return { value: w.model }
  })
  on('session.turns', () => ({ value: w.messages.filter(m => m.role === 'user').length }))
  on('session.messages', ($, e) => {
    if (e?.as !== 'api') return { value: w.messages }
    w.apiReads++
    return { value: w.apiMessages as never }
  })
  on('session.usage', ($, e) => {
    w.usageReads++
    if (w.usageThrows) throw new Error('usage is unavailable')
    if (!e?.breakdown) return { value: usageNow(w) }
    w.breakdownReads++
    if (e.breakdown === 'full') w.fullReads++
    const value = usageNow(w)
    const window = value.context.window
    const isOn = w.usage.autoCompact !== undefined
    const breakdown = {
      categories: (w.breakdown.categories ?? []) as never[],
      totalTokens: w.usage.ctxTokens ?? 0,
      maxTokens: window,
      rawMaxTokens: window,
      autocompactSource: 'model-default' as const,
      percentage: Math.round(((w.usage.ctxTokens ?? 0) / window) * 100),
      gridRows: [],
      model: 'claude-test',
      memoryFiles: (w.breakdown.memoryFiles ?? []) as never[],
      mcpTools: (w.breakdown.mcpTools ?? []) as never[],
      agents: (w.breakdown.agents ?? []) as never[],
      ...(w.breakdown.skills ? { skills: w.breakdown.skills as never } : {}),
      ...(isOn ? { autoCompactThreshold: w.usage.autoCompact } : {}),
      isAutoCompactEnabled: isOn,
      apiUsage: null,
    }
    return { value: { ...value, context: { ...value.context, breakdown } } }
  })
  // The model, beneath every plugin: one response a step, costing what the test set.
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: w.nextAnswer, toolUses: [], stopReason: 'end_turn' as const, usage: w.nextStep }
  })
  // A completion of the plugin's own, answered by the test after the model's time.
  on('model.complete', async ($, e) => {
    w.modelCalls.push(e)
    await w.clock.sleep(w.modelMs)
    return { value: w.modelReply(e) }
  })
  on('model.fork', () => {
    w.forks++
    return { value: { isAnswered: false as const, reason: 'nothing-to-fork' as const } }
  })
  on('config.set', ($, e) => {
    w.configSets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('agent.list', () => ({
    value: w.agents.map(a => ({
      id: a.id,
      status: a.status as 'running',
      description: a.description ?? 'agent',
      type: a.type ?? 'Explore',
      ...(a.parentId ? { parentId: a.parentId } : {}),
      ...(a.spawnedBy ? { spawnedBy: a.spawnedBy } : {}),
      ...(a.teammateId ? { teammateId: a.teammateId } : {}),
    })),
  }))
  // Core starts an agent for every Agent call and answers with its id; a hook above sees it as `agent.spawn`.
  let agentCount = 0
  on('agent.spawn', () => ({ model: 'claude-test', agentId: `agent-${++agentCount}` }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', ($, e) => {
    if (w.notify === 'throws') throw new Error('$.ui.notify is not in this build')
    if (w.notify === 'disabled') return { value: { isSent: false, reason: 'disabled' } }
    w.notified.push({ text: e.text, title: e.title })
    return { value: { isSent: true, channel: 'kitty' } }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    w.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.blit', ($, e) => {
    w.blits.push({ key: e.key })
    return { value: w.pictures === 'shown' ? {} : { deny: 'the Image draws its alt here: no placeholder images' } }
  })
  on('ui.invalidate', () => {
    w.invalidates++
    return { value: undefined }
  })
  // The engine's own drawings beneath every plugin: where no hook beneath draws, `next(e)` answers these.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
  on('ui.render', { component: 'TurnDuration' }, () => ({ type: 'engine' as const, ref: 0 }))
  on('ui.render', { component: 'ToolProgress' }, () => ({ type: 'engine' as const, ref: 0 }))
  on('ui.open', ($, e) => {
    w.opened.push({ ...e })
    if (!w.panes.includes(e.id)) w.panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: w.panes.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.close', ($, e) => {
    w.panes = w.panes.filter(id => id !== e.id)
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('audio.play', () => {
    w.played++
    return { value: undefined }
  })
  on('tool.check', () => ({ decision: w.askMs === undefined ? ('allow' as const) : ('ask' as const) }))
  // A dialog shows and the person answers it, unless a settings hook beneath settles it by itself.
  on('classic.PermissionRequest', () => (w.isSettledByHook ? { decision: { behavior: 'allow' as const } } : {}))
  on('classic.Stop', () => ({}))
  on('tool.call', async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    w.calls.push({ tool: String(e.tool), id: e.tool_use_id })
    switch (String(e.tool)) {
      case 'Bash': {
        if (w.askMs !== undefined && w.engine) {
          // As core does: the permission check, then the dialog's wait, then the command.
          await w.engine.tool.check({ tool: 'Bash', input: { command: input.command }, tool_use_id: e.tool_use_id, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) } as never)
          // Outside auto mode the ask shows a dialog: the PermissionRequest classic event, with no call id.
          if (w.dialog) await w.engine.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: input.command }, ...(e.agentId !== undefined ? { agent_id: e.agentId, agent_type: 'Explore' } : {}) })
          await w.clock.sleep(w.askMs)
        }
        // Sent to the background: the call answers at once with the task's id; the shell runs on.
        if (input.run_in_background === true) {
          const id = `bash-${w.shells.length + 1}`
          w.shells.push({ id, command: String(input.command ?? ''), ...(typeof input.description === 'string' ? { description: input.description } : {}) })
          return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id }, text: `Command running in background with ID: ${id}.` }
        }
        await w.clock.sleep(w.bashMs)
        const answer = w.bash(String(input.command ?? ''))
        if (answer.refused !== undefined) return { isError: true as const, result: answer.refused, text: answer.refused }
        if (answer.interrupted) {
          // As Claude Code formats a shell cut by Esc: the exit, the interruption, what it had printed.
          const cut = ['Exit code 143', '[Request interrupted by user for tool use]', answer.stderr, answer.stdout].filter(Boolean).join('\n')
          return { isError: true as const, result: cut, text: cut }
        }
        const text = [answer.stdout, answer.stderr].filter(Boolean).join('\n')
        if (!answer.ok) return { isError: true as const, result: `Exit code 1\n${text}`, text: `Exit code 1\n${text}` }
        return { result: { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', interrupted: false }, text }
      }
      case 'TodoWrite':
        return { result: { oldTodos: [], newTodos: input.todos }, text: 'Todos have been modified successfully.' }
      case 'TaskCreate':
        return { result: { task: { id: String(input.subject).length.toString(), subject: input.subject } }, text: 'Task created' }
      case 'TaskUpdate':
        return { result: { success: true, taskId: input.taskId, updatedFields: ['status'] }, text: 'Updated' }
      case 'Agent': {
        // As core does: the agent starts (agent.spawn), then a background one answers at once.
        // A name makes it a teammate of the session's team (agent teams on), in the background, as 2.1.296 does.
        const teammate = typeof input.name === 'string' && input.name !== '' ? String(input.name) : undefined
        const isBackground = teammate !== undefined || input.run_in_background === true || input.run_in_background === 'true'
        const started = w.engine
          ? await w.engine.agent.spawn({ tool_use_id: e.tool_use_id, prompt: String(input.prompt ?? ''), description: String(input.description ?? ''), subagentType: teammate ? 'teammate' : String(input.subagent_type ?? 'general-purpose'), provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-test', background: isBackground, fork: false, ...(teammate ? { isTeammate: true } : {}), ...(e.agentId !== undefined ? { parentAgentId: e.agentId } : {}) } as never)
          : { agentId: 'agent-1' }
        const agentId = started.agentId ?? 'agent-1'
        if (teammate) return { result: { status: 'teammate_spawned', agentId, agent_id: agentId, teammate_id: `${teammate}@session-test`, name: teammate, prompt: '' }, text: 'Spawned successfully.' }
        if (isBackground) return { result: { status: 'async_launched', agentId, description: String(input.description ?? ''), prompt: '', outputFile: '/tmp/out' }, text: 'Async agent launched successfully.' }
        return { result: { status: 'completed', agentId, totalTokens: 50_000, totalDurationMs: 30_000, totalToolUseCount: 4, content: [], usage: {}, prompt: '' }, text: 'done' }
      }
      case 'AskUserQuestion':
      case 'ExitPlanMode':
        // The dialog waits on the person.
        await w.clock.sleep(w.askUserMs)
        return { result: { questions: input.questions ?? [], answers: {}, annotations: {} }, text: 'Your questions have been answered.' }
      default:
        return { result: 'ok', text: 'ok' }
    }
  })
  return w
}

/** What `$.session.usage()` answers in the test, and what `session.measure` pushes. */
export function usageNow(w: World): SessionUsage {
  const rateLimits: SessionRateLimit[] = []
  const now = w.clock.now()
  if (w.usage.fiveHour !== undefined) {
    rateLimits.push({
      kind: 'five_hour',
      percentUsed: w.usage.fiveHour,
      ...(w.usage.fiveResetsIn !== undefined ? { resetsAt: new Date(now + w.usage.fiveResetsIn * MINUTE).toISOString() } : {}),
    })
  }
  if (w.usage.sevenDay !== undefined) rateLimits.push({ kind: 'seven_day', percentUsed: w.usage.sevenDay })
  return {
    startedAt: now,
    context: {
      window: w.usage.ctxWindow ?? 200_000,
      ...(w.usage.ctxPct !== undefined ? { percent: w.usage.ctxPct } : {}),
      ...(w.usage.ctxTokens !== undefined ? { tokens: w.usage.ctxTokens } : {}),
    },
    rateLimits,
    ...(w.usage.costUsd === undefined ? {} : { cost: { usd: w.usage.costUsd } }),
  }
}

/** The engine measuring the session, as it does after each main turn: `session.measure` with the figures now. */
export async function measure($: Engine, w: World): Promise<void> {
  const { context, rateLimits, cost } = usageNow(w)
  await $.session.measure({ context, rateLimits, ...(cost ? { cost } : {}), changed: ['context', 'rateLimits', 'cost'] })
  await w.clock.settle()
}

/** One model response of a turn, streamed through every plugin's `turn.step` hook and read to its end. */
export async function step($: Engine, w: World, turnId: string, cost: TurnUsage, index = 0, answer = ''): Promise<void> {
  w.nextStep = cost
  w.nextAnswer = answer
  const stream = $.turn.step({ turnId, index, model: 'claude-test', messageCount: 1 + index })
  for await (const chunk of stream) void chunk
  await w.clock.settle()
}

export async function start($: Engine, w: World): Promise<void> {
  w.engine = $
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

let turnCount = 0

export type TurnOptions = {
  /** What the person typed; the first one becomes the mission. */
  prompt?: string
  tokens?: number
  minutes?: number
  tools?: ToolCallArgs[]
  /** What the session's cost ledger grows by during the turn. */
  costUsd?: number
  /** Claude's final words for the turn. */
  answer?: string
}

/** One main turn: the prompt, its tools, its end. */
export async function turn($: Engine, w: World, options: TurnOptions = {}): Promise<string> {
  const turnId = `turn-${++turnCount}`
  if (options.prompt !== undefined) await $.prompt.submit({ text: options.prompt, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: options.prompt ?? 'go', turnId })
  for (const call of options.tools ?? []) {
    // The call runs while the clock moves: a Bash command takes `bashMs`.
    const ran = $.tool.call(call)
    await w.clock.advance(w.bashMs + (w.askMs ?? 0))
    await ran
  }
  await w.clock.advance((options.minutes ?? 0.25) * MINUTE)
  if (options.costUsd !== undefined) w.usage.costUsd = (w.usage.costUsd ?? 0) + options.costUsd
  // The turn's one response, then its end carrying the same usage, then the engine's measurement.
  const cost = usage(options.tokens ?? 1000)
  await step($, w, turnId, cost)
  const done = await $.turn.complete({
    answer: options.answer ?? 'done',
    durationMs: (options.minutes ?? 0.25) * MINUTE,
    isAborted: false,
    turnId,
    reason: 'answer',
    usage: cost,
  })
  if (done.text !== (options.answer ?? 'done')) throw new Error(`turn.complete answered "${done.text}"`)
  await measure($, w)
  return turnId
}

/** One tool call outside a turn, the clock moving while it runs. */
export async function call($: Engine, w: World, args: ToolCallArgs) {
  const ran = $.tool.call(args)
  await w.clock.advance(w.bashMs + (w.askMs ?? 0))
  return ran
}

/** A response's cost: `tokens` read uncached; with `cached`, cache reads and writes beside them. */
export function usage(tokens: number, cached: { read?: number; write?: number; output?: number } = {}): TurnUsage {
  return {
    input_tokens: tokens,
    output_tokens: cached.output ?? 0,
    cache_read_input_tokens: cached.read ?? 0,
    cache_creation_input_tokens: cached.write ?? 0,
    model: 'claude-test',
  }
}

/** `/quackpit <args>` (or `/quack`) as the person types it at a fullscreen terminal. */
export async function command($: Engine, args: string, name: 'quackpit' | 'quack' = 'quackpit') {
  return $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
}

export function band(bodyColumns = 150, maxRows = 6) {
  return {
    component: 'AbovePrompt' as const,
    requestId: 'band',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows,
      bodyColumns,
      scroll: { offset: 0, bodyRows: maxRows - 1 },
      view: {},
    } satisfies RenderPropsOf['AbovePrompt'],
  }
}

export const PANE = {
  component: 'Pane',
  requestId: 'quackpit',
  props: {
    title: 'quackpit',
    isFocused: false,
    bodyColumns: 110,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  } satisfies RenderPropsOf['Pane'],
} as const

/**
 * How long a test that drives a session may take. Each takes well under a
 * second on a quiet machine; on a busy one the kit's own 5 seconds ran out.
 */
export const LIMIT_MS = 20_000

/** English, whatever the machine's locale, for tests that read words. */
export const EN = { options: { locale: 'en' }, timeoutMs: LIMIT_MS } as const

export const todo = (items: [string, 'pending' | 'in_progress' | 'completed'][]): ToolCallArgs => ({
  tool: 'TodoWrite',
  todos: items.map(([content, status]) => ({ content, status, activeForm: content })),
})

export const bash = (command: string): ToolCallArgs => ({ tool: 'Bash', command })

/** A line as text, the projected part of a meter (▰ in the dim shade) written ▓, as the brief writes it. */
export function shaded(line: readonly { text: string; tone?: string }[]): string {
  return line.map(span => (span.tone === 'muted' ? span.text.replace(/▰/g, '▓') : span.text)).join('')
}

/** A Raster's base64 cells read back: each cell's glyph, foreground and background. */
export function decode(cells: string): [string, number, number][] {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  const clean = cells.replace(/=+$/, '')
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | Math.max(0, alphabet.indexOf(clean[i + k] ?? 'A')), 0)
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  const word = (at: number) => ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0
  const out: [string, number, number][] = []
  for (let at = 0; at + 12 <= Math.floor((clean.length * 3) / 4); at += 12) out.push([String.fromCodePoint(word(at)), word(at + 4), word(at + 8)])
  return out
}
