// Pace, medians, token sums and the tool-call-based verification detection.
//
// Adapted from token-detox, src/metrics.ts (MIT License, Copyright (c) 2026
// SeongBeen Im). Copied rather than imported, since quackpit has no
// dependencies. Kept verbatim: `PACE_WINDOW_MS`, `RUNAWAY_FACTOR`,
// `RUNAWAY_MIN_TURNS`, `VERIFY_RE`, `isEditTool`, `isVerifyCommand`,
// `toolKind`, `median`, `isRunaway`, `sumUsage`, `pruneRecent`, `paceAt` and
// `dayPace`. Changed: `TokenUsage` also takes `null` counts (the Agent tool's
// record spells a missing cache count as null) and `isNum` is exported.
// Added for quackpit: `HOUR`/`MINUTE` (token-detox keeps them in its time
// module), `paceCoverageMs`, which says how much of the pace window has
// data, the new-token unit pace counts in (`newTokens`,
// `cacheParts`, `hitRatio`, `addRecent`): cache reads stay out of it, and
// the "now" rate the pace dial reads (`nowRate`).

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

/** Pace is tokens over the last 60 minutes. */
export const PACE_WINDOW_MS = HOUR
/** A runaway turn costs more than 3x the session's median turn... */
export const RUNAWAY_FACTOR = 3
/** ...once the session has had at least 5 turns. */
export const RUNAWAY_MIN_TURNS = 5

const MAX_RECENT = 200

/** Bash commands that verify an edit: tests, typecheck, lint, build. */
export const VERIFY_RE =
  /\b(pnpm|npm|yarn|bun)\s+(run\s+)?(test|typecheck|lint|build|check)\b|\b(vitest|jest|pytest|mocha|tsc|cargo (test|check)|go (test|vet)|make (test|check)|ruff|eslint|mypy)\b/

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function isEditTool(tool: string): boolean {
  return EDIT_TOOLS.has(tool)
}

export function isVerifyCommand(command: string): boolean {
  return VERIFY_RE.test(command)
}

/**
 * What a tool call means for verification: an edit, a verification run, or
 * nothing. Only the main agent counts: a subagent's calls (`agentId`) never do.
 */
export function toolKind(call: { tool: string; agentId?: string | undefined; command?: unknown }): 'edit' | 'verify' | undefined {
  if (call.agentId !== undefined) return undefined
  if (isEditTool(call.tool)) return 'edit'
  if (call.tool === 'Bash' && typeof call.command === 'string' && isVerifyCommand(call.command)) return 'verify'
  return undefined
}

export const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

export function median(values: readonly number[]): number | undefined {
  const xs = values.filter(isNum).sort((a, b) => a - b)
  if (xs.length === 0) return undefined
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 === 1 ? xs[mid] : ((xs[mid - 1] ?? 0) + (xs[mid] ?? 0)) / 2
}

/** True when `cost` is over 3x the median of the session's earlier turns (5+). */
export function isRunaway(previous: readonly number[], cost: number): boolean {
  if (previous.length < RUNAWAY_MIN_TURNS) return false
  const mid = median(previous)
  return mid !== undefined && mid > 0 && cost > RUNAWAY_FACTOR * mid
}

export type TokenUsage = {
  readonly input_tokens?: number | null
  readonly output_tokens?: number | null
  readonly cache_read_input_tokens?: number | null
  readonly cache_creation_input_tokens?: number | null
}

/** All four token counts of a turn, summed (token-detox's unit; quackpit's pace no longer uses it). */
export function sumUsage(usage: TokenUsage | undefined): number {
  if (!usage) return 0
  const n = (x: unknown) => (isNum(x) && x > 0 ? x : 0)
  return (
    n(usage.input_tokens) +
    n(usage.output_tokens) +
    n(usage.cache_read_input_tokens) +
    n(usage.cache_creation_input_tokens)
  )
}

/**
 * What a response cost in new tokens: what it read uncached, what it wrote to
 * the prompt cache and what it generated. Cache reads stay out: every request
 * reads the whole context again, so counting them counts the context once per
 * request (a 4-minute turn at a 490k context read about 4.9M).
 */
export function newTokens(usage: TokenUsage | undefined): number {
  if (!usage) return 0
  const n = (x: unknown) => (isNum(x) && x > 0 ? x : 0)
  return n(usage.input_tokens) + n(usage.output_tokens) + n(usage.cache_creation_input_tokens)
}

/** A response's prompt as the cache saw it: read from it, written to it, and read uncached. */
export type CacheParts = { read: number; write: number; input: number }

export function cacheParts(usage: TokenUsage | undefined): CacheParts {
  const n = (x: unknown) => (isNum(x) && x > 0 ? x : 0)
  return { read: n(usage?.cache_read_input_tokens), write: n(usage?.cache_creation_input_tokens), input: n(usage?.input_tokens) }
}

/** The share of the prompts the cache served, 0 to 1: read ÷ (read + write + input); undefined before any prompt. */
export function hitRatio(parts: CacheParts): number | undefined {
  const total = parts.read + parts.write + parts.input
  return total > 0 ? parts.read / total : undefined
}

/** Keeps the last 60 minutes of `[t, tokens]`, newest last. */
export function pruneRecent(recent: readonly [number, number][], now: number): [number, number][] {
  return recent.filter(([t]) => t > now - PACE_WINDOW_MS && t <= now).slice(-MAX_RECENT)
}

/**
 * Adds `tokens` at `at` to the pace samples, one per minute: many responses a
 * minute fold into one, so a busy hour keeps every token it counted.
 */
export function addRecent(recent: readonly [number, number][], at: number, tokens: number): [number, number][] {
  if (!(tokens > 0)) return pruneRecent(recent, at)
  const minute = Math.floor(at / MINUTE) * MINUTE
  const last = recent.at(-1)
  const merged: [number, number][] =
    last && last[0] >= minute ? [...recent.slice(0, -1), [Math.max(last[0], at), last[1] + tokens]] : [...recent, [at, tokens]]
  return pruneRecent(merged, at)
}

/** Tokens per hour over the last 60 minutes. */
export function paceAt(recent: readonly [number, number][], now: number): number {
  return pruneRecent(recent, now).reduce((sum, [, tokens]) => sum + tokens, 0)
}

/** The "now" rate's half-life: a response counts half as much 5 minutes on, so 5 idle minutes halve it. */
export const NOW_HALF_LIFE_MS = 5 * MINUTE

/**
 * New tokens an hour at the last few minutes' pace: each sample weighed by
 * how recent it is, halving every 5 minutes (an exponentially weighted rate,
 * which a steady flow of tokens reads exactly). The hour's sum moves only as
 * samples leave its window, so 5 idle minutes changed nothing; this falls as
 * soon as the responses stop.
 */
export function nowRate(recent: readonly [number, number][], now: number, halfLifeMs = NOW_HALF_LIFE_MS): number {
  const lambda = Math.LN2 / halfLifeMs
  let perMs = 0
  for (const [at, tokens] of recent) {
    if (at > now || !(tokens > 0)) continue
    perMs += tokens * lambda * Math.exp(-lambda * (now - at))
  }
  return perMs * HOUR
}

/** A finished day's average pace: tokens per active hour, at least an hour. */
export function dayPace(tokens: number, activeMin: number): number {
  return tokens / Math.max(activeMin / 60, 1)
}

/**
 * How much of the pace window has data: from the earliest moment counting
 * started (the session's start, or the first entry still in the window) to
 * now, at most the whole window.
 */
export function paceCoverageMs(since: number, now: number): number {
  return Math.max(0, Math.min(PACE_WINDOW_MS, now - since))
}
