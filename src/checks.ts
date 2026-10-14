// Which Bash commands are checks (test, typecheck, lint, build), and what
// their result said. quackpit never runs anything: it reads the command the
// main agent ran and the result the tool answered. Pure.
//
// Detection reuses token-detox's `isVerifyCommand` (src/metrics.ts) as the
// first pass, widened by a few runners it does not know, then confirms the
// kind on the command's own segments, so `cat jest.config.js` is no check.
// A chain or a loop that runs several checks is one run of each.

import { maskSecrets } from './mask'
import { isVerifyCommand } from './metrics'

export type CheckKind = 'test' | 'typecheck' | 'lint' | 'build'

/** `hidden`: it ran, but what it said was cut away and its exit hidden (a test run's summary behind `| tail -4`): no verdict. */
export type CheckStatus = 'pass' | 'fail' | 'running' | 'interrupted' | 'background' | 'hidden'

export type CheckResult = {
  /** The tool call's id, so a result finds its own start. */
  id: string
  /** The kind it is named by: a failure's own kind, else the chain's last. */
  kind: CheckKind
  /** Every kind the call ran, in order, when it ran more than one (a chain, a loop). */
  kinds?: CheckKind[]
  /** The kinds a failed chain's output names as failing; absent, the failure is the whole chain's. */
  judged?: CheckKind[]
  /** The command as run, masked and cut to 200 characters. */
  command: string
  status: CheckStatus
  passed?: number
  failed?: number
  errors?: number
  warnings?: number
  startedAt: number
  endedAt?: number
  /** Measured around the tool call: what it took, not what it printed. */
  durationMs?: number
  turn: number
  /** Its call's place among the session's main calls, so what came after it is known even without times. */
  seq?: number
  /** A failed run's last lines, masked and short: what its detail shows. */
  tail?: string
  /** Rebuilt from a resumed transcript: when it ran is not known. */
  replayed?: true
}

/** Every kind a check ran. */
export function kindsOf(check: Pick<CheckResult, 'kind' | 'kinds'>): CheckKind[] {
  return check.kinds ?? [check.kind]
}

/**
 * The kinds a finished run counts for: all of them when it passed, and when
 * it failed, those its output names as failing (or, naming none, all of them:
 * the failure is the whole chain's).
 */
export function judgedKinds(check: Pick<CheckResult, 'kind' | 'kinds' | 'judged'>): CheckKind[] {
  return check.judged ?? kindsOf(check)
}

/** Runners `VERIFY_RE` does not list. */
const EXTRA_RE =
  /\bclaude\s+plugin\s+(test|validate)\b|\bnode\s+--test\b|\bdeno\s+(test|check|lint)\b|\bbun\s+test\b|\bcargo\s+(clippy|build|nextest)\b|\bgo\s+build\b|\b(vite|next|nuxt|astro)\s+build\b|\b(tsup|esbuild|webpack|rollup)\b|\bdocker\s+build\b|\b(pnpm|npm|yarn|bun)\s+(run\s+)?(type-?check|check-types|lint:\S+|test:\S+)\b|\b(biome|oxlint|pyright|flake8|pylint|golangci-lint|rubocop|stylelint|shellcheck|phpunit|rspec|vue-tsc|playwright\s+test|xcodebuild|swift\s+(build|test)|dotnet\s+(build|test)|gradlew?\s+(build|test|check)|mvn\s+(test|verify|package))\b/

/** Leading words that run the command after them: `npx vitest`, `pnpm exec tsc`, `pnpm vitest`. */
const WRAPPER_RE =
  /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)|(?:time|nice|command|exec|env|caffeinate|timeout\s+\S+)\s+|(?:npx|bunx|pnpx)(?:\s+-[a-zA-Z]+(?:\s+\S+@\S+|\s+-p\s+\S+)?)*\s+|(?:pnpm|yarn|npm)\s+(?:exec|dlx|x)\s+|(?:pnpm|yarn|bun)\s+(?=(?:vitest|jest|mocha|ava|tap|tsc|vue-tsc|eslint|oxlint|biome|prettier|playwright|tsup|esbuild|webpack|rollup|vite|next)\b)|(?:uv|poetry|pipenv|hatch)\s+run\s+|python3?\s+-m\s+)+/

const SEGMENT_KIND: readonly [CheckKind, RegExp][] = [
  [
    'test',
    /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|test:\S+|check)\b|(?:vitest|jest|pytest|mocha|ava|tap|rspec|phpunit|ctest|tox|nox)\b|playwright\s+test\b|cypress\s+run\b|go\s+test\b|cargo\s+(?:test|nextest)\b|make\s+(?:test|check)\b|node\s+--test\b|deno\s+test\b|bun\s+test\b|claude\s+plugin\s+test\b|swift\s+test\b|dotnet\s+test\b|gradlew?\s+(?:test|check)\b|mvn\s+(?:test|verify)\b|unittest\b)/,
  ],
  [
    'typecheck',
    /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|check-types|tsc|types)\b|(?:tsc|vue-tsc|mypy|pyright)\b|cargo\s+check\b|go\s+vet\b|deno\s+check\b|claude\s+plugin\s+validate\b)/,
  ],
  [
    'lint',
    /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:lint|lint:\S+)\b|(?:eslint|oxlint|ruff|flake8|pylint|golangci-lint|rubocop|stylelint|shellcheck)\b|biome\s+(?:check|lint|ci)\b|cargo\s+clippy\b|deno\s+lint\b|prettier\s+(?:--check|-c)\b)/,
  ],
  [
    'build',
    /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:build|build:\S+)\b|cargo\s+build\b|go\s+build\b|make\b(?!\s+(?:test|check|clean|install))|(?:vite|next|nuxt|astro)\s+build\b|(?:tsup|esbuild|webpack|rollup)\b|xcodebuild\b|swift\s+build\b|dotnet\s+build\b|gradlew?\s+build\b|mvn\s+package\b|docker\s+build\b)/,
  ],
]

/**
 * The words that open or close a compound command rather than run one: a
 * loop's `do`, an `if`'s condition and branches, a group's braces. A segment
 * that starts with one runs what follows it (`do node --test $f`).
 */
const SHELL_WORDS_RE = /^(?:(?:do|then|else|elif|if|while|until|time|!)\s+|[({]\s*)+/
/** A loop's head (`for f in a b`) and the words that close a compound command run nothing. */
const NO_COMMAND_RE = /^(?:for|select|case)\s|^(?:done|fi|esac|[)}])$/

/**
 * Splits a shell line on `&&`, `||`, `;` and `|` (not inside quotes) into the
 * commands it runs: `cd` left out, a loop's or an `if`'s own words taken off
 * (`for f in a b; do node --test $f; done` runs `node --test $f`).
 */
export function segments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? ''
    if (quote) {
      if (ch === quote) quote = undefined
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && command[i + 1] === '&')) {
      out.push(cur)
      cur = ''
      if ((ch === '|' && command[i + 1] === '|') || ch === '&') i++
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
    .map(s => s.trim())
    .filter(s => !NO_COMMAND_RE.test(s))
    .map(s => s.replace(SHELL_WORDS_RE, '').replace(/\s*[)}]+$/, '').trim())
    .filter(s => s !== '' && !NO_COMMAND_RE.test(s) && !/^cd\b/.test(s))
}

/**
 * Whether the line's exit status may not be the check's own: a pipe (`| tail`),
 * an `||`, or a `;` or newline after it. `&&` passes a failure on. Quotes are skipped.
 */
export function masksExit(command: string): boolean {
  let quote: string | undefined
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '|' || ch === ';' || ch === '\n') return true
  }
  return false
}

/**
 * Whether the line's exit status is a pipe's last command's (`pnpm test 2>&1
 * | grep -E "pass|fail"`), its other joins all `&&`: the filter decides the
 * exit, so where the runner's summary got through, the summary decides.
 */
export function exitIsPipe(command: string): boolean {
  let quote: string | undefined
  let last = ''
  const line = command.trim()
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? ''
    if (quote) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === ';' || ch === '\n' || (ch === '|' && line[i + 1] === '|')) return false
    else if (ch === '|') last = '|'
    else if (ch === '&' && line[i + 1] === '&') {
      last = '&&'
      i++
    }
  }
  return last === '|'
}

/**
 * Every kind of check a command runs, in the order it runs them, each once:
 * `pnpm typecheck && pnpm test` runs a typecheck and the tests. Empty when it
 * runs none.
 */
export function checkKinds(command: string): CheckKind[] {
  if (!isVerifyCommand(command) && !EXTRA_RE.test(command)) return []
  const kinds: CheckKind[] = []
  for (const segment of segments(command)) {
    const bare = segment.replace(WRAPPER_RE, '')
    const kind = SEGMENT_KIND.find(([, pattern]) => pattern.test(bare))?.[0]
    if (kind && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

/** The first kind of check a command runs, or undefined when it runs none. */
export function checkKind(command: string): CheckKind | undefined {
  return checkKinds(command)[0]
}

/** Counts a result printed: tests passed and failed, errors and warnings. */
export type CheckCounts = { passed?: number; failed?: number; errors?: number; warnings?: number }

function num(match: RegExpMatchArray | null, group = 1): number | undefined {
  const v = match?.[group]
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Reads the summary lines of common runners; undefined fields were not
 * printed. A runner that printed its summary more than once (a loop ran it
 * several times) has its counts summed; the first runner whose summary
 * appears decides each count.
 */
export function parseCounts(text: string): CheckCounts {
  const out: CheckCounts = {}
  const set = (key: keyof CheckCounts, value: number | undefined) => {
    if (value !== undefined && out[key] === undefined) out[key] = value
  }
  /** Every match of a summary, its groups summed; undefined when it never appears. */
  const sums = (re: RegExp, groups: readonly number[]): (number | undefined)[] | undefined => {
    const totals: (number | undefined)[] = groups.map(() => undefined)
    let seen = false
    for (const m of text.matchAll(re)) {
      seen = true
      groups.forEach((g, i) => {
        const n = num(m, g)
        if (n !== undefined) totals[i] = (totals[i] ?? 0) + n
      })
    }
    return seen ? totals : undefined
  }
  // vitest: "Tests  2 failed | 10 passed (12)"
  const vitest = sums(/^\s*Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(?:\d+\s+skipped\s*\|\s*)?(\d+)\s+passed/gm, [1, 2])
  if (vitest) {
    set('failed', vitest[0] ?? 0)
    set('passed', vitest[1])
  }
  // jest: "Tests:       1 failed, 11 passed, 12 total"
  const jest = sums(/Tests:\s+(?:(\d+)\s+failed,\s+)?(?:\d+\s+skipped,\s+)?(?:\d+\s+todo,\s+)?(\d+)\s+passed,\s+\d+\s+total/g, [1, 2])
  if (jest) {
    set('failed', jest[0] ?? 0)
    set('passed', jest[1])
  }
  // cargo: "test result: FAILED. 10 passed; 2 failed;"
  const cargo = sums(/test result: \w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/g, [1, 2])
  if (cargo) {
    set('passed', cargo[0])
    set('failed', cargo[1])
  }
  // node --test / TAP: "# pass 12" "# fail 1"
  set('passed', sums(/^#\s+pass\s+(\d+)/gm, [1])?.[0])
  set('failed', sums(/^#\s+fail\s+(\d+)/gm, [1])?.[0])
  // mocha: "12 passing" "1 failing"
  set('passed', sums(/\b(\d+)\s+passing\b/g, [1])?.[0])
  set('failed', sums(/\b(\d+)\s+failing\b/g, [1])?.[0])
  // tsc: "Found 3 errors in 2 files." / "Found 1 error."
  set('errors', sums(/\bFound\s+(\d+)\s+errors?\b/g, [1])?.[0])
  // eslint: "✖ 5 problems (3 errors, 2 warnings)"
  const eslint = sums(/(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/g, [2, 3])
  if (eslint) {
    set('errors', eslint[0])
    set('warnings', eslint[1])
  }
  // pytest and the generic summary lines: "3 failed, 9 passed in 1.2s", "12 passed".
  // A count must end its clause, so "2 failed attempts" or "3 errors retried" is no summary.
  const ENDS = String.raw`(?=\s*(?:[,;|()=]|\bin\b|$))`
  set('failed', sums(new RegExp(String.raw`\b(\d+)\s+(?:tests?\s+)?failed\b${ENDS}`, 'gim'), [1])?.[0])
  set('passed', sums(/\b(\d+)\s+(?:tests?\s+)?passed\b/gi, [1])?.[0])
  set('errors', sums(new RegExp(String.raw`\b(\d+)\s+errors?\b${ENDS}(?!\s*in\s+\d)`, 'gim'), [1])?.[0])
  if (out.errors === undefined) {
    const tsErrors = text.match(/error TS\d+:/g)
    if (tsErrors) out.errors = tsErrors.length
  }
  return out
}

/** What in a failed run's output says which kind of check failed. */
const FAILED_SAYS: Record<CheckKind, RegExp> = {
  test: /^\s*(?:FAIL\b|not ok \d)|^#\s+fail\s+[1-9]|\b[1-9]\d*\s+(?:tests?\s+)?(?:failed|failing)\b/m,
  typecheck: /\berror TS\d+:|^Found [1-9]\d* errors? in \d+ files?|\berror: .*\[[a-z-]+\]$|^\S+\.py:\d+: error:/m,
  lint: /\b[1-9]\d* problems? \(|^\s*\d+:\d+\s+error\s|\bFound [1-9]\d* errors?\.\s*$|^.+:\d+:\d+: [A-Z]+\d+ /m,
  build: /\bBuild failed\b|\berror during build\b|\bFailed to compile\b|^ERROR in\b|\bCompilation failed\b|^error(?:\[E\d+\])?: |\bbuild failed\b/m,
}

/**
 * The kinds a failed run's output says failed, among those it ran: a runner's
 * failure count, tsc's or a type checker's errors, a linter's problems, a
 * build's error. Empty when it names none of them.
 */
export function failedKinds(text: string, kinds: readonly CheckKind[]): CheckKind[] {
  return kinds.filter(kind => FAILED_SAYS[kind].test(text))
}

/** How a finished check came out, from the tool's own verdict and its output. */
export function judgeCheck(input: {
  isError: boolean
  interrupted?: boolean
  background?: boolean
  text: string
  /** The exit status may not be the check's own (`masksExit`); unknown counts as maybe. */
  exitMasked?: boolean
  /** The exit status is a pipe's last command's, the line's only other joins being `&&` (`exitIsPipe`). */
  exitIsPipe?: boolean
  /** The kinds the call ran, for a chain's failure to be put on the one its output names. */
  kinds?: readonly CheckKind[]
}): { status: CheckStatus; counts: CheckCounts; judged?: CheckKind[] } {
  const counts = parseCounts(input.text)
  if (input.background) return { status: 'background', counts }
  if (input.interrupted) return { status: 'interrupted', counts }
  // A failing exit wins. Where a pipe may hide it (`| tail`), so does a summary naming failures;
  // where nothing hides it, a clean exit is a pass whatever the output mentions.
  const failedByText =
    input.exitMasked !== false && ((counts.failed ?? 0) > 0 || ((counts.errors ?? 0) > 0 && counts.passed === undefined))
  // Where the line ends in a pipe (`… | grep x`), the exit is the last filter's: a runner's own
  // summary that names passes and no failure decides then.
  const cleanSummary = input.exitIsPipe === true && counts.failed === 0 && (counts.passed ?? 0) > 0 && !failedByText
  const kinds = input.kinds ?? []
  // A test run behind a pipe whose output kept no runner's summary at all: its result was cut away
  // (`node --test 2>&1 | tail -4` keeps TAP's last counts, not its passes and failures). No verdict.
  const isHidden = input.exitMasked === true && !input.isError && kinds.includes('test') && counts.passed === undefined && counts.failed === undefined
  if (isHidden) return { status: 'hidden', counts }
  const status: CheckStatus = cleanSummary ? 'pass' : input.isError || failedByText ? 'fail' : 'pass'
  if (status !== 'fail' || kinds.length < 2) return { status, counts }
  // A chain that failed: the failure is put on the checks its output names, else on the chain as a whole.
  const named = failedKinds(input.text, kinds)
  return named.length > 0 && named.length < kinds.length ? { status, counts, judged: named } : { status, counts }
}

/** The command as shown and kept: one line, masked, at most `max` characters. */
export function shownCommand(command: string, max = 200): string {
  const one = maskSecrets(command).replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** A line that says what failed: a runner's FAIL, an error, an assertion, a count of failures; never a count of none. */
const FAILING_LINE_RE = /\bFAIL\b|✗|✖|×|\bnot ok\b|\bError\b|\berror\b|Assertion|\bexpected\b|\bfailed\b|\bfailing\b|^#\s+fail\s+[1-9]/
const NOTHING_FAILED_RE = /^#\s+fail\s+0\b|\b0 (?:failed|failing|errors?)\b/
/** A runner's bookkeeping, never what failed: TAP's zero counts and its timing. */
const NOISE_RE = /^#\s+(?:\w+\s+0|duration_ms\b)|^ℹ\s+(?:\w+\s+0|duration_ms\b)/

/**
 * A failed run's failing lines, for its detail: the first few that say what
 * failed (a FAIL, an error, an assertion), else its last lines; masked, each
 * one line, the whole cut to `maxChars`.
 */
export function failingLines(text: string, maxLines = 3, maxChars = 240): string {
  const lines = maskSecrets(text)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => line.trim() !== '' && !/^Exit code \d+$/.test(line.trim()))
  const failing = lines.filter(line => FAILING_LINE_RE.test(line.trim()) && !NOTHING_FAILED_RE.test(line.trim()))
  const telling = lines.filter(line => !NOISE_RE.test(line.trim()))
  const shown = (failing.length > 0 ? failing.slice(0, maxLines) : telling.slice(-maxLines)).map(line => line.trim())
  const joined = shown.join('\n')
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined
}

/** The tail of a failing output, masked: what the next shift needs to see first. */
export function failureTail(text: string, maxLines = 30, maxChars = 2000): string {
  const lines = maskSecrets(text).replace(/\r/g, '').split('\n')
  let tail = lines.slice(-maxLines).join('\n').trim()
  if (tail.length > maxChars) tail = `…${tail.slice(-maxChars)}`
  return tail
}
