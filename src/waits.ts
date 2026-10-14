// Waits on the person: the time Claude spends waiting for an answer is not
// work. A wait is a question Claude asked (AskUserQuestion), a plan put up for
// approval (ExitPlanMode), or a permission dialog that really showed (one no
// hook and no auto-mode classifier settled by itself). It holds the loop that
// asked, and the main loop too when that loop is a subagent the main loop
// waits on in the foreground. Lengths quackpit measures leave the held time
// out, and an expected end moves later by it: the work's own clock stands
// still while it waits. Pure.

/** A question put to the person, a plan to approve, or a permission dialog. */
export type WaitKind = 'question' | 'plan' | 'permission'

export type Wait = {
  from: number
  /** When it ended; absent while it is open. */
  to?: number
  kind: WaitKind
  /** The tool the dialog is for (`Bash`; `AskUserQuestion` for a question). */
  tool?: string
  /** The call it holds, when that is known. */
  toolUseId?: string
  /** A subagent's dialog: its loop's id. Absent for the main loop's. */
  agentId?: string
  /** The subagent's type, for the words (`Explore`). */
  agentType?: string
  /** Whether it holds the main loop: its own, or a foreground subagent's the main loop waits on. */
  main: boolean
}

/** Closed waits kept: enough to cover the open work's lengths; the open ones are always kept. */
export const MAX_WAITS = 40

/** Whose clock a wait holds: the main loop's, or one subagent's (by its loop id). */
export type Clock = 'main' | { agentId: string }

function holds(w: Wait, clock: Clock): boolean {
  return clock === 'main' ? w.main : w.agentId === clock.agentId
}

/** The waits open now, the newest last. */
export function openWaits(waits: readonly Wait[] | undefined, clock?: Clock): Wait[] {
  return (waits ?? []).filter(w => w.to === undefined && (clock === undefined || holds(w, clock)))
}

/** The wait that holds `clock` now, if any: the one that opened first, whose length the words give. */
export function waitingNow(waits: readonly Wait[] | undefined, clock: Clock = 'main'): Wait | undefined {
  return openWaits(waits, clock)[0]
}

/**
 * Milliseconds of [from, to] that waits holding `clock` covered, an open one
 * up to `to`. Waits that overlap count once.
 */
export function heldMs(waits: readonly Wait[] | undefined, from: number, to: number, clock: Clock = 'main'): number {
  if (!(to > from)) return 0
  const spans = (waits ?? [])
    .filter(w => holds(w, clock))
    .map(w => [Math.max(from, w.from), Math.min(to, w.to ?? to)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  let total = 0
  let end = -Infinity
  for (const [a, b] of spans) {
    if (b <= end) continue
    total += b - Math.max(a, end)
    end = b
  }
  return total
}

/** The time between `from` and `to` that was work: the waits holding `clock` left out. */
export function activeMs(waits: readonly Wait[] | undefined, from: number, to: number, clock: Clock = 'main'): number {
  return Math.max(0, to - from - heldMs(waits, from, to, clock))
}

/** The ledger with one more wait open, the oldest closed ones past the limit dropped. */
export function startWait(waits: readonly Wait[] | undefined, w: Wait): Wait[] {
  const all = [...(waits ?? []).filter(x => !(x.to === undefined && w.toolUseId !== undefined && x.toolUseId === w.toolUseId)), w]
  const closed = all.filter(x => x.to !== undefined)
  const drop = new Set(closed.slice(0, Math.max(0, closed.length - MAX_WAITS)))
  return all.filter(x => !drop.has(x))
}

/** Which open waits a closing applies to: one call's, one loop's, or every one. */
export type WaitMatch = { toolUseId: string } | { agentId: string | undefined } | 'all'

function matches(w: Wait, match: WaitMatch): boolean {
  if (match === 'all') return true
  if ('toolUseId' in match) return w.toolUseId === match.toolUseId
  return w.agentId === match.agentId
}

/** The ledger with the matching open waits closed at `at`; the same array when none was open. */
export function endWaits(waits: readonly Wait[] | undefined, match: WaitMatch, at: number): Wait[] {
  const list = waits ?? []
  if (!list.some(w => w.to === undefined && matches(w, match))) return [...list]
  return list.map(w => (w.to === undefined && matches(w, match) ? { ...w, to: Math.max(w.from, at) } : w))
}

/** Waits read back from storage: anything not in a wait's shape is dropped. */
export function asWaits(x: unknown): Wait[] {
  if (!Array.isArray(x)) return []
  return x.filter((w): w is Wait => {
    if (typeof w !== 'object' || w === null) return false
    const r = w as Record<string, unknown>
    return typeof r.from === 'number' && Number.isFinite(r.from) && (r.to === undefined || typeof r.to === 'number') && (r.kind === 'question' || r.kind === 'plan' || r.kind === 'permission') && typeof r.main === 'boolean'
  })
}
