// The hero's big number: a 3x4-pixel block font drawn in half blocks, so a
// digit is 3 cells wide and 2 rows tall and renders solid in any terminal
// font. The pixel and SVG variants draw the same glyph table. Pure.

/** Each glyph: 4 rows top to bottom, `#` lit. Width varies. */
const GLYPHS: Record<string, readonly string[]> = {
  '0': ['###', '#.#', '#.#', '###'],
  '1': ['##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '#..', '###'],
  '3': ['###', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#'],
  '5': ['###', '#..', '..#', '###'],
  '6': ['.##', '#..', '###', '###'],
  '7': ['###', '..#', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '###'],
  '9': ['###', '#.#', '###', '..#'],
  '/': ['..#', '.#.', '.#.', '#..'],
  ':': ['.', '#', '.', '#'],
  '.': ['.', '.', '.', '#'],
  '-': ['..', '..', '##', '..'],
  ' ': ['.', '.', '.', '.'],
}

export const GLYPH_HEIGHT = 4

/** Whether the font can draw every character of `text`. */
export function canDraw(text: string): boolean {
  return [...text].every(ch => ch in GLYPHS)
}

/** The lit pixels of `text`: columns of the whole string, one gap column between glyphs. */
export function dotColumns(text: string): boolean[][] {
  const columns: boolean[][] = []
  const chars = [...text].filter(ch => ch in GLYPHS)
  chars.forEach((ch, i) => {
    const rows = GLYPHS[ch] ?? []
    const width = rows[0]?.length ?? 0
    for (let x = 0; x < width; x++) columns.push(rows.map(row => row[x] === '#'))
    if (i < chars.length - 1) columns.push(Array.from({ length: GLYPH_HEIGHT }, () => false))
  })
  return columns
}

/** How many terminal columns the rendering of `text` takes. */
export function digitColumns(text: string): number {
  return dotColumns(text).length
}

/** `text` as two lines of half blocks (▀ ▄ █), one cell per pixel column. */
export function blockDigits(text: string): [string, string] {
  const cols = dotColumns(text)
  const line = (top: number) =>
    cols
      .map(col => {
        const a = col[top] === true
        const b = col[top + 1] === true
        return a && b ? '█' : a ? '▀' : b ? '▄' : ' '
      })
      .join('')
  return [line(0), line(2)]
}
