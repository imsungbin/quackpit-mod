// The prompt cache's clock: how long the main conversation's cached prompt
// stays warm after its last request, and what the next prompt rewrites once
// it has gone cold. The lifetime is decided the way Claude Code decides it
// (code.claude.com/docs/en/prompt-caching; claude-cache-timer, MIT, reads it
// the same way), first match wins: FORCE_PROMPT_CACHING_5M, then
// CLAUDE_CODE_PROMPT_CACHE_TTL, then the `promptCacheTtl` setting, then
// ENABLE_PROMPT_CACHING_1H, then the account: an hour on a subscription within
// its plan, 5 minutes otherwise. The lifetime counts from the start of the
// request that last read or wrote it. Pure.

import { MINUTE } from './metrics'
import type { Cockpit, Reading } from './model'

export type Ttl = '5m' | '1h'

/** What the environment and the settings say, before the account has a say. */
export type TtlInputs = { force5m?: string; ttlVar?: string; setting?: unknown; enable1h?: string }

const isOn = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true'
const asTtl = (v: unknown): Ttl | undefined => (v === '5m' || v === '1h' ? v : undefined)

/** The lifetime the environment or the settings force, if any does. */
export function forcedTtl(inputs: TtlInputs): Ttl | undefined {
  return (isOn(inputs.force5m) ? '5m' : undefined) ?? asTtl(inputs.ttlVar) ?? asTtl(inputs.setting) ?? (isOn(inputs.enable1h) ? '1h' : undefined)
}

/**
 * The lifetime in force: the forced one, else the account's. A five-hour or
 * seven-day window in the readings means a subscription; one at 100% means
 * requests now draw on usage credits, which cache for 5 minutes.
 */
export function ttlOf(forced: Ttl | undefined, reading: Reading | undefined): Ttl {
  if (forced) return forced
  const windows = [reading?.fiveHour, reading?.sevenDay].filter(w => w !== undefined)
  return windows.length > 0 && windows.every(w => w.pct < 100) ? '1h' : '5m'
}

export const ttlMs = (ttl: Ttl) => (ttl === '1h' ? 60 * MINUTE : 5 * MINUTE)

export type CacheClock = { state: 'turn'; ttl: Ttl } | { state: 'warm'; ttl: Ttl; left: number } | { state: 'cold'; ttl: Ttl; rewrite: number }

/** Where the cache stands now: warm while a turn runs, then the minutes left, then cold. Undefined before the first response. */
export function cacheClock(c: Cockpit, now: number, ttl: Ttl): CacheClock | undefined {
  const last = c.lastStep
  if (!last) return undefined
  if (c.turn) return { state: 'turn', ttl }
  const left = last.startedAt + ttlMs(ttl) - now
  if (left > 0) return { state: 'warm', ttl, left }
  return { state: 'cold', ttl, rewrite: last.read + last.write + last.input }
}
