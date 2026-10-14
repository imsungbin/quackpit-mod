// Text as a terminal lays it out: display width (Hangul and other wide
// characters take two cells), cutting to a width, and the styled spans a
// face is written in. Pure.

/**
 * What a span means, which each surface maps to its own colours: ok, warn
 * and bad are the threshold colours; muted is a dim label; track the unlit
 * part of a gauge; grey a needle with too little data to trust.
 */
export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'accent' | 'track' | 'grey'

/**
 * A run of text; `bg` paints the cell behind it (the lower pixel of a ▀).
 * `color` and `bgColor` are fixed colours (`#4c8df6`), for what is a key and
 * no state: the context bar's sources, each in its own colour on every theme.
 */
export type Span = { text: string; tone?: Tone; bg?: Tone; bold?: boolean; color?: string; bgColor?: string }

export type Line = Span[]

/**
 * The emoji below U+1F000 that draw two cells wide by default (Unicode East
 * Asian Width W): ⌚ ⏩ ⏰ ⏳ ☔ ♿ ⚡ ⚪ ⚽ ⛄ ⛔ ✅ ✊ ✨ ❌ ❓ ❗ ➕ ➰ ⬛ ⭐ ⭕ and kin.
 * The glyphs quackpit draws itself (✓ ✗ ● ◔ ▰ ↻ ⟲ ⚠) are not among them.
 */
const WIDE_BMP_EMOJI: readonly (readonly [number, number])[] = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
]

/** Whether a code point takes two terminal cells (East Asian wide or fullwidth, or an emoji drawn wide). */
function isWide(cp: number): boolean {
  if (cp < 0x1100) return false
  if (cp >= 0x231a && cp <= 0x2b55) return WIDE_BMP_EMOJI.some(([lo, hi]) => cp >= lo && cp <= hi)
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp === 0x1f004 ||
    cp === 0x1f0cf ||
    cp === 0x1f18e ||
    (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f200 && cp <= 0x1f2ff) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

export function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue
    w += isWide(cp) ? 2 : 1
  }
  return w
}

/**
 * A press's words ending on a narrow character: a space after a wide one.
 * Warp leaves the second half of a wide character that ends a focus ring
 * unlit, though Claude Code sends the whole run (see `TAB_PAD`).
 */
export function endNarrow(text: string): string {
  const last = [...text].at(-1)
  return last !== undefined && isWide(last.codePointAt(0) ?? 0) ? `${text} ` : text
}

/** Cuts `text` to `width` cells, ending in an ellipsis when it was cut (never a space before it). */
export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (displayWidth(text) <= width) return text
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = displayWidth(ch)
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return `${out.trimEnd()}…`
}

/** Pads `text` with spaces to `width` cells. */
export function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

export function lineWidth(line: Line): number {
  return line.reduce((sum, span) => sum + displayWidth(span.text), 0)
}

/** Cuts a line of spans to `width` cells, the last span kept ends in an ellipsis. */
export function fitLine(line: Line, width: number): Line {
  if (lineWidth(line) <= width) return line
  const out: Line = []
  let left = width
  for (const span of line) {
    const w = displayWidth(span.text)
    if (w <= left) {
      out.push(span)
      left -= w
      continue
    }
    if (left > 0) out.push({ ...span, text: fit(span.text, left) })
    break
  }
  return out
}


/** Han and kana: a line may break between any two of them. Hangul, like Latin, breaks at spaces. */
const BREAKS_ANYWHERE = /[\u2e80-\u2fdf\u3005-\u3007\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/
/** Marks a line never starts with: they stay with what comes before them. */
const NO_LINE_START = /[、。，．・：；？！）」』】〉》〕］｝ー…‥ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ,.:;!?)\]}%]/
/** Marks a line never ends with: they stay with what comes after them. */
const NO_LINE_END = /[（「『【〈《〔［｛([{]/

/**
 * Text in the pieces a line may break between: runs of spaces, words, and in
 * Japanese and Chinese each character, its closing marks kept with it and an
 * opening bracket with what it opens.
 */
export function breakPieces(text: string): string[] {
  const out: string[] = []
  for (const run of text.split(/(\s+)/)) {
    if (run === '') continue
    if (/^\s+$/.test(run) || !BREAKS_ANYWHERE.test(run)) {
      out.push(run)
      continue
    }
    let unit = ''
    let wasWide = false
    for (const ch of run) {
      const isWide = BREAKS_ANYWHERE.test(ch)
      // An opening bracket stays with what it opens, and a number with the counter after it (`3回目`, `10分钟`).
      const holds = unit !== '' && (NO_LINE_END.test(unit.slice(-1)) || (isWide && /[0-9]$/.test(unit)))
      if (unit !== '' && !holds && !NO_LINE_START.test(ch) && (isWide || wasWide || NO_LINE_END.test(ch))) {
        out.push(unit)
        unit = ''
      }
      unit += ch
      if (!NO_LINE_START.test(ch)) wasWide = isWide
    }
    if (unit !== '') out.push(unit)
  }
  return out
}

/**
 * Word wrap to `width` columns, a wide character (Hangul, CJK, emoji) counting
 * two; at most `max` lines, the last cut with an ellipsis. Japanese and Chinese
 * break between characters; a word wider than the line is broken where it
 * reaches the edge.
 */
export function wrap(text: string, width: number, max: number): string[] {
  const w = Math.max(1, Math.floor(width))
  const lines: string[] = []
  let line = ''
  let spaced = false
  for (const piece of breakPieces(text.trim())) {
    if (/^\s+$/.test(piece)) {
      spaced = line !== ''
      continue
    }
    for (const word of breakWord(piece, w)) {
      const joined = line === '' ? word : `${line}${spaced ? ' ' : ''}${word}`
      if (displayWidth(joined) <= w) line = joined
      else {
        lines.push(line)
        line = word
      }
      spaced = false
    }
  }
  if (line) lines.push(line)
  if (lines.length > max) {
    const kept = lines.slice(0, max)
    kept[max - 1] = fit(`${kept[max - 1]} …`, w)
    return kept
  }
  return lines
}

/** A word wider than the line, in pieces that fit it. */
function breakWord(word: string, width: number): string[] {
  if (displayWidth(word) <= width) return [word]
  const pieces: string[] = []
  let piece = ''
  for (const ch of word) {
    if (piece !== '' && displayWidth(piece + ch) > width) {
      pieces.push(piece)
      piece = ''
    }
    piece += ch
  }
  if (piece) pieces.push(piece)
  return pieces
}

/**
 * A line of styled spans wrapped to `width` columns, at most `max` lines: each
 * word keeps its span's look, runs of spaces become one, Japanese and Chinese
 * break between characters, a word wider than a line breaks where it reaches
 * the edge, and the last line ends in an ellipsis when words were left over.
 */
export function wrapLine(line: Line, width: number, max: number): Line[] {
  const w = Math.max(1, Math.floor(width))
  const lines: Line[] = [[]]
  let used = 0
  let isLeftOver = false
  const add = (text: string, span: Span) => {
    const current = lines.at(-1) as Line
    const last = current.at(-1)
    if (last && last.tone === span.tone && last.bg === span.bg && last.bold === span.bold) last.text += text
    else current.push({ ...span, text })
    used += displayWidth(text)
  }
  const newLine = () => {
    const current = lines.at(-1) as Line
    const last = current.at(-1)
    if (last) last.text = last.text.trimEnd()
    lines.push([])
    used = 0
  }
  outer: for (const span of line) {
    for (const part of breakPieces(span.text)) {
      if (/^\s+$/.test(part)) {
        if (used > 0 && used < w) add(' ', span)
        continue
      }
      let word = part
      if (used > 0 && used + displayWidth(word) > w) {
        if (lines.length === max) {
          isLeftOver = true
          break outer
        }
        newLine()
      }
      // A word wider than a whole line breaks at the edge.
      while (displayWidth(word) > w - used) {
        let piece = ''
        for (const ch of word) {
          if (displayWidth(piece + ch) > w - used) break
          piece += ch
        }
        if (piece === '') break
        add(piece, span)
        word = word.slice(piece.length)
        if (lines.length === max) {
          isLeftOver = word !== ''
          break outer
        }
        newLine()
      }
      if (word !== '') add(word, span)
    }
  }
  const out = lines.filter(l => l.length > 0)
  for (const l of out) {
    const end = l.at(-1)
    if (end) end.text = end.text.trimEnd()
  }
  const last = out.at(-1)
  if (isLeftOver && last) {
    // The mark in the last word's look; where the line is full, its last word gives a column to it.
    const look = last.at(-1) ?? { text: '' }
    out[out.length - 1] = lineWidth(last) < w ? [...last, { ...look, text: '…' }] : fitLine(last, w - 1)
  }
  return out.length > 0 ? out : [[]]
}

/** The plain text of a line, for tests and the handover. */
export function plain(line: Line): string {
  return line.map(span => span.text).join('')
}

/** ▁▂▃▄▅▆▇█ for values, scaled to their max. */
export function sparkline(values: readonly number[]): string {
  const bars = '▁▂▃▄▅▆▇█'
  const max = Math.max(0, ...values)
  if (max <= 0) return values.map(() => bars[0]).join('')
  return values.map(v => bars[Math.min(7, Math.max(0, Math.round((v / max) * 7)))] ?? '▁').join('')
}

/**
 * Values as columns of eighth blocks `rows` tall, scaled to `max`, `width`
 * cells to a value: the top row first. A value above nothing shows at least
 * an eighth; `tone` colours a value's column (a threshold passed).
 */
export function columnChart(values: readonly number[], max: number, rows: number, tone: (value: number) => Tone | undefined = () => undefined, width = 1): Line[] {
  const levels = rows * 8
  const heights = values.map(v => (max > 0 && v > 0 ? Math.max(1, Math.round(Math.min(1, v / max) * levels)) : 0))
  return Array.from({ length: rows }, (_, row) => {
    const floor = (rows - 1 - row) * 8
    const line: Line = []
    heights.forEach((h, i) => {
      const inRow = h - floor
      const ch = (inRow >= 8 ? '█' : inRow <= 0 ? ' ' : ' ▁▂▃▄▅▆▇'[inRow] ?? ' ').repeat(width)
      const look = inRow > 0 ? tone(values[i] ?? 0) : undefined
      const last = line.at(-1)
      if (last && last.tone === look) last.text += ch
      else line.push({ text: ch, ...(look ? { tone: look } : {}) })
    })
    return line
  })
}

/** ◔◑◕● for a share of a whole: the one-cell ring. */
export function ringGlyph(pct: number | undefined): string {
  if (pct === undefined) return '○'
  if (pct >= 87.5) return '●'
  if (pct >= 62.5) return '◕'
  if (pct >= 37.5) return '◑'
  if (pct >= 12.5) return '◔'
  return '○'
}

/** A segmented meter, ▰▰▰▱▱. */
export function segments(fraction: number, count: number): [string, string] {
  const f = Math.max(0, Math.min(1, fraction))
  const lit = Math.round(f * count)
  return ['▰'.repeat(lit), '▱'.repeat(count - lit)]
}

/**
 * A segmented meter with a projection: ▰ used, ▰ again for the use projected
 * beyond it (drawn in a second, dim shade by the caller), ▱ the rest.
 */
export function projectedSegments(used: number, projected: number, count: number): [string, string, string] {
  const u = Math.max(0, Math.min(1, used))
  const lit = Math.round(u * count)
  const reach = Math.max(lit, Math.round(Math.max(u, Math.min(1, projected)) * count))
  return ['▰'.repeat(lit), '▰'.repeat(reach - lit), '▱'.repeat(count - reach)]
}

/** A thin progress rule: heavy for done, light for left. */
export function rule(fraction: number, width: number): [string, string] {
  const f = Math.max(0, Math.min(1, fraction))
  const lit = Math.round(f * width)
  return ['━'.repeat(lit), '─'.repeat(Math.max(0, width - lit))]
}
