// What runs now. One answer for every place that says it: the band's
// progress, the pane's progress (its top section and its one-line summary)
// and the AGENTS instrument all read `workOf`, and a test holds them to it.
// Running means at work: Claude's own agents running in the foreground or the
// background, and its background jobs. A teammate idle between its turns, an
// agent waiting on its own work or still queued, and a job listed but queued
// are alive and not running; a job with no expected end past its first 30
// minutes runs on aside. Those are a quiet line, never the headline. Pure.

import { isAgentOpen, isCounted, type Eta } from './eta'
import { isJobRunning, OPEN_HOLD_MS, type Job } from './jobs'
import type { AgentRun, Cockpit } from './model'

export type Work = {
  /** Claude's own agents at work (the main loop's and a workflow's), running in the foreground or the background. */
  agents: AgentRun[]
  /** Claude's background jobs at work that hold the headline: of a known length, or within their first 30 minutes. */
  jobs: Job[]
  /** Background jobs with no expected end past their first 30 minutes: running on, a quiet line. */
  aside: Job[]
  /** Jobs listed alive and not at work: queued. */
  queued: Job[]
  /** Teammates alive and not at work: idle between their turns, or waiting on their own work. */
  idle: AgentRun[]
  /** Claude's other agents alive and not at work: waiting on their own work, a plan, an agent they started, or queued. */
  waiting: AgentRun[]
  /** Agents at work that are not Claude's own (a plugin's, another agent's): listed, never counted. */
  others: AgentRun[]
}

/** What runs now and what waits, as of `now`, with the estimate's parts telling a job of a known length from one with none. */
export function workOf(c: Cockpit, now: number, eta?: Eta): Work {
  const timed = new Set((eta?.jobs ?? []).map(j => j.id))
  const running = c.jobs.filter(isJobRunning)
  const holds = (j: Job) => timed.has(j.id) || now - j.startedAt < OPEN_HOLD_MS
  return {
    agents: c.agents.filter(a => isCounted(a) && isAgentOpen(a)),
    jobs: running.filter(holds),
    aside: running.filter(j => !holds(j)),
    queued: c.jobs.filter(j => j.status === 'waiting'),
    idle: c.agents.filter(a => isCounted(a) && a.teammate === true && (a.status === 'idle' || a.status === 'waiting')),
    waiting: c.agents.filter(a => isCounted(a) && a.teammate !== true && (a.status === 'waiting' || a.status === 'idle')),
    others: c.agents.filter(a => !isCounted(a) && isAgentOpen(a)),
  }
}

/** Whether Claude's work runs: an agent at work or a job holding the headline. */
export function isAtWork(w: Work): boolean {
  return w.agents.length > 0 || w.jobs.length > 0
}

/** Whether anything is alive and not running, or runs aside: what the quiet line says. */
export function hasQuiet(w: Work): boolean {
  return w.idle.length > 0 || w.waiting.length > 0 || w.queued.length > 0 || w.aside.length > 0
}
