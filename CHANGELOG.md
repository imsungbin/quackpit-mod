# Changelog

All notable changes to quackpit are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-14

The first release.

### Added

- **The band.** A live instrument panel above the prompt: task progress, how long the work in hand will take, pace, context left before auto-compact, plan limits with forecasts, checks and cost, as tiles you can add, remove and reorder (`/quackpit add|remove|move|rows`). Optional tiles: agents, files, session and health. Where tiles do not fit, the rightmost switch to compact faces, then to `+n`. Pixel gauges where the terminal shows pictures (kitty graphics: kitty, Ghostty), block-character gauges everywhere else, SVG in the desktop app. quackpit keeps any other mod's band and draws its own rows beneath it, nearest the prompt.
- **How long it will take.** One estimate for all the work in hand, from measured lengths: Claude's task list, the subagents it started and the background jobs it will come back to, ending at the latest of them, drawn as a duckling crossing a pond toward a flag. Time spent waiting on you (a question, a plan, a permission dialog) never counts, and the estimate keeps going after the turn while a background job runs. With nothing to measure, a long turn says how it compares with your usual turns.
- **The AI ETA (opt-in).** With it on (`/quackpit ai on`), Claude Haiku estimates the rest of a long turn, is asked again when the turn outruns its answer (4 calls a turn at most), and its accuracy is measured against what was really left and shown, never promised. It counts every token it spends.
- **The duck.** A rubber duck in the Master Caution slot, asleep until a failed check, the five-hour window, the context near auto-compact or a runaway turn needs you; then it wakes and says **Quack:**. Pressing it acknowledges the caution. An OS notification for a failed check and the five-hour window at 90%, at most 3 a day; an optional synthesised quack. `/quackpit duck off` silences it.
- **The pane.** Six views under a pinned header (overview, timeline, turns, band, handover and guide, keyed 1 to 6), sized to the window and driven by keyboard and mouse. The overview is how long the work will take, then eight instruments of one size: the pace dial, a fuel gauge for the account's five-hour window, what fills the context (one bar, a colour a source), the cost of each turn, the checks as a row a kind, the files edited, health and the session. Press an instrument for its detail: each check run with its failing lines, what fills the context source by source, the turns by cost, the readings behind each dial and their age.
- **Health.** A score from 0 to 100 for how the work is going, from seven parts (edits no passing check has seen, the context, the five-hour window, runaway turns, pace, breaks and night work), each with what it measured, its weight and what it took off. A judgement, not a measurement, and it says so.
- **Handover.** `/quackpit handover` writes `.claude/handover.md` for the next session: the goal and the task list, your own words along the way, what Claude left for you, what changed, how to run the checks and the ones still failing with their output, from the session's events alone and with credentials masked.
- **Readings that last.** Each session keeps a record, so a resume, a restart or `/reload-plugins` brings back its times; your usual pace comes from the last 14 days.
- **Five languages**: English, Korean, Japanese, Simplified Chinese and Traditional Chinese, for the band, the pane, toasts, notifications, the guide and the handover. `locale: auto` follows the system.
- **Free to run.** By default zero model tokens, no network requests, no processes, nothing added to the model's context.
- 274 tests under `claude plugin test .`.
