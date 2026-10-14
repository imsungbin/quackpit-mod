// The handover: a deterministic Markdown note for the next session, built
// from this session's events alone (no model, nothing summarised): Mission,
// Your words (the person's later prompts, the last one whole), Waiting on you
// (the question Claude's last answer ended on, when it did), Telemetry, How to
// run (the last passing command of each kind of check), Unverified (files
// edited after the last passing check), Anomalies and Next shift. It says to
// treat every line as a starting point, not a fact. The adapter writes it to
// `.claude/handover.md` in the project and shows it in the pane; quackpit
// never submits it anywhere. Pure.

import { clockText, formatPercent, formatTokens, formatUsd, relativePath, stampText } from './format'
import { t, type Locale } from './i18n'
import { maskSecrets } from './mask'
import { contextNow, unverified, type Cockpit } from './model'
import { progressOf, type Task } from './progress'

export const HANDOVER_PATH = '.claude/handover.md'

export type HandoverInput = {
  c: Cockpit
  now: number
  locale: Locale
  /** The project root, so paths read relative to it. */
  root?: string
}

function quote(text: string): string {
  return text
    .split('\n')
    .map(line => `> ${line}`.trimEnd())
    .join('\n')
}

function fence(text: string): string {
  const mark = text.includes('```') ? '~~~' : '```'
  return `${mark}\n${text}\n${mark}`
}

function taskLine(task: Task): string {
  const box = task.status === 'completed' ? '[x]' : '[ ]'
  const tail = task.status === 'in_progress' ? ' _(in progress)_' : ''
  return `- ${box} ${maskSecrets(task.title)}${tail}`
}

export function buildHandover(input: HandoverInput): string {
  const { c, now, locale: L, root } = input
  // What a resumed transcript gave back has no time of its own: say so rather than print the resume's.
  const stamp = (at: number, replayed?: true) => (replayed ? t(L, 'resume.before') : clockText(at))
  const out: string[] = []
  out.push(`# ${t(L, 'ho.title')}`, '')
  out.push(t(L, 'ho.generated', { stamp: stampText(now) }), t(L, 'ho.treat'), t(L, 'ho.paste'), '')

  // Mission
  out.push(`## ${t(L, 'ho.mission')}`, '')
  if (c.goal) out.push(t(L, 'ho.goal'), '', quote(maskSecrets(c.goal)), '')
  else out.push(t(L, c.goalLost ? 'ho.goalLost' : 'ho.noGoal'), '')
  const p = progressOf(c.tasks)
  if (c.tasks && p) {
    out.push(t(L, 'ho.tasks', { done: p.done, total: p.total }), '')
    for (const task of c.tasks.items) out.push(taskLine(task))
    out.push('')
  } else {
    out.push(t(L, 'ho.noTasks'), '')
  }

  // Your words: what the person said after the goal, the last of it whole.
  out.push(`## ${t(L, 'ho.words')}`, '')
  const earlier = c.prompts.slice(0, -1)
  if (c.lastPrompt === undefined) out.push(t(L, 'ho.noWords'), '')
  else {
    if (earlier.length > 0) {
      out.push(t(L, 'ho.wordsEarlier'), '')
      for (const said of earlier) out.push(`- ${said.replace(/\s+/g, ' ')}`)
      out.push('')
    }
    out.push(t(L, 'ho.wordsLast'), '', quote(c.lastPrompt), '')
  }

  // Waiting on you: only when Claude's last answer ended on a question.
  if (c.question !== undefined) out.push(`## ${t(L, 'ho.waiting')}`, '', t(L, 'ho.waitingIntro'), '', quote(c.question), '')

  // Telemetry
  out.push(`## ${t(L, 'ho.telemetry')}`, '')
  const files = [...c.files].sort((a, b) => b.lastAt - a.lastAt)
  if (files.length > 0) {
    out.push(t(L, 'ho.files', { n: files.length }))
    for (const f of files.slice(0, 40)) out.push(`- \`${relativePath(f.path, root)}\` (×${f.edits}${f.created ? ', new' : ''})`)
    if (files.length > 40) out.push(`- … +${files.length - 40}`)
    out.push('')
  } else {
    out.push(t(L, 'ho.noFiles'), '')
  }
  const commands = c.commands.slice(-15)
  if (commands.length > 0) {
    out.push(t(L, 'ho.commands', { n: commands.length }))
    for (const run of commands) {
      const mark = run.ok === true ? '✓' : run.ok === false ? '✗' : '·'
      out.push(`- ${mark} \`${run.command.replace(/`/g, "'")}\` (${stamp(run.at, run.replayed)})`)
    }
    out.push('')
  } else {
    out.push(t(L, 'ho.noCommands'), '')
  }
  const r = c.reading
  const fill = contextNow(c)
  const ctx =
    fill.pct !== undefined
      ? `${formatPercent(fill.pct)}${fill.tokens !== undefined && fill.window ? ` (${formatTokens(fill.tokens)} / ${formatTokens(fill.window)})` : ''}`
      : '—'
  const turns = c.turnCount === 1 ? t(L, 'ho.turns.one') : t(L, 'ho.turns.many', { n: c.turnCount })
  out.push(t(L, 'ho.usage', { tokens: formatTokens(c.tokens), turns, cost: formatUsd(r?.costUsd), ctx }), '')

  // How to run: the last passing command of each kind of check.
  out.push(`## ${t(L, 'ho.run')}`, '')
  if (c.passing.length === 0) out.push(t(L, 'ho.noRun'), '')
  else {
    out.push(t(L, 'ho.runIntro'))
    for (const pass of c.passing) out.push(`- ${t(L, `kind.${pass.kind}`)}: \`${pass.command.replace(/`/g, "'")}\` (${stamp(pass.at, pass.replayed)})`)
    out.push('')
  }

  // Unverified: what was edited after the last passing check.
  out.push(`## ${t(L, 'ho.unverified')}`, '')
  const unseen = unverified(c)
  const lastPass = c.checks.findLast(ch => ch.status === 'pass')
  if (!unseen || !lastPass) out.push(t(L, 'ho.noPass'), '')
  else if (unseen.paths.length === 0) out.push(t(L, 'ho.noUnverified'), '')
  else {
    out.push(t(L, 'ho.unverifiedIntro', { command: lastPass.command.replace(/`/g, "'"), stamp: stamp(lastPass.endedAt ?? lastPass.startedAt, lastPass.replayed) }))
    for (const path of unseen.paths) out.push(`- \`${relativePath(path, root)}\``)
    out.push('')
  }

  // Anomalies
  out.push(`## ${t(L, 'ho.anomalies')}`, '')
  const anomalies: string[] = []
  for (const check of c.checks.filter(ch => ch.status === 'fail').slice(-8)) {
    anomalies.push(`- ${t(L, 'ho.failedCheck', { kind: t(L, `kind.${check.kind}`), command: check.command.replace(/`/g, "'"), stamp: stamp(check.endedAt ?? check.startedAt, check.replayed) })}`)
  }
  for (const turn of c.history.filter(h => h.runaway)) {
    anomalies.push(`- ${t(L, 'ho.runaway', { n: turn.n, amount: turn.costUsd !== undefined ? formatUsd(turn.costUsd) : `${formatTokens(turn.tokens)} tokens` })}`)
  }
  if (c.compactions > 0) anomalies.push(`- ${t(L, 'ho.compactions', { n: c.compactions === 1 ? t(L, 'ho.times.one') : t(L, 'ho.times.many', { n: c.compactions }) })}`)
  out.push(...(anomalies.length > 0 ? anomalies : [t(L, 'ho.none')]), '')

  // Next shift
  out.push(`## ${t(L, 'ho.next')}`, '')
  const open = c.tasks?.items.filter(task => task.status !== 'completed') ?? []
  if (open.length > 0) {
    out.push(t(L, 'ho.open'), '')
    for (const task of open) out.push(taskLine(task))
    out.push('')
  } else {
    out.push(t(L, 'ho.noOpen'), '')
  }
  // Every kind of check whose latest run failed, the newest first: a lint that passed later
  // does not clear a test that is still failing.
  const failures = [...c.failures].reverse()
  for (const failure of failures) {
    out.push(t(L, 'ho.lastFailure', { command: failure.command.replace(/`/g, "'"), stamp: stamp(failure.at, failure.replayed) }), '', fence(failure.output || '(no output)'), '')
  }
  if (failures.length === 0) out.push(t(L, 'ho.noFailure'), '')
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
