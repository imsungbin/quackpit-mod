// Cell grids for a terminal's Raster element: quadrant blocks for pixel
// sprites (four pixels a cell, 2x2, at most two colours), encoded as the
// Raster wants them: one little-endian u32 triplet [codePoint, foreground,
// background] per cell, base64. Pure; no host API.

/** The terminal's own colour, for a Raster cell (bit 24 alone). */
export const DEFAULT_COLOR = 0x01000000

export type RasterCells = { cells: string; columns: number; rows: number }

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64, without leaning on a host global. */
export function base64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}==`
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}${B64[(n >> 6) & 63]!}=`
  }
  return out
}

function encode(columns: number, rows: number, cell: (x: number, y: number) => readonly [number, number, number]): RasterCells {
  const view = new DataView(new ArrayBuffer(columns * rows * 12))
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const [glyph, fg, bg] = cell(x, y)
      const at = (y * columns + x) * 12
      view.setUint32(at, glyph, true)
      view.setUint32(at + 4, fg, true)
      view.setUint32(at + 8, bg, true)
    }
  }
  return { cells: base64(new Uint8Array(view.buffer)), columns, rows }
}

const FULL = 0x2588

/**
 * The quadrant block for each 4-bit mask of lit pixels: bit 1 top left, 2 top
 * right, 4 bottom left, 8 bottom right. 0 is a space. Every glyph is a
 * printable width-1 BMP character, as a Raster cell must be.
 */
export const QUADRANTS: readonly string[] = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█']

/** A cell's glyph, its colour and what is behind it, where a sprite says more than its pixels do. */
export type CellOverride = { glyph: string; fg: number; bg: number }

/**
 * Pixels four to a cell, 2x2: `pixels[y][x]` is 0xRRGGBB or undefined for
 * clear. A cell holds at most two colours, clear counting as one, and clear is
 * the terminal's own background. The glyph is the quadrant block of the
 * cell's lit pixels: with clear in it, of its one colour; with two colours, of
 * the one with fewer pixels, drawn over the other. A cell of more than two
 * colours keeps its two most common. `overrides` replaces whole cells by
 * index (`y * columns + x`): the idle duck's shut eye, a line no quadrant draws.
 */
export function quadrantCells(pixels: readonly (readonly (number | undefined)[])[], width: number, overrides: Readonly<Record<number, CellOverride>> = {}): RasterCells {
  const columns = Math.ceil(width / 2)
  const rows = Math.ceil(pixels.length / 2)
  return encode(columns, rows, (x, y) => {
    const special = overrides[y * columns + x]
    if (special) return [special.glyph.codePointAt(0) ?? 0x20, special.fg, special.bg]
    const quad = [pixels[y * 2]?.[x * 2], pixels[y * 2]?.[x * 2 + 1], pixels[y * 2 + 1]?.[x * 2], pixels[y * 2 + 1]?.[x * 2 + 1]]
    const counts = new Map<number | undefined, number>()
    for (const p of quad) counts.set(p, (counts.get(p) ?? 0) + 1)
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
    const [first, second] = ranked
    const maskOf = (colour: number | undefined) => quad.reduce<number>((mask, p, i) => (p === colour ? mask | (1 << i) : mask), 0)
    const glyph = (mask: number) => (QUADRANTS[mask] ?? ' ').codePointAt(0) ?? 0x20
    if (!first) return [0x20, DEFAULT_COLOR, DEFAULT_COLOR]
    if (!second) return first[0] === undefined ? [0x20, DEFAULT_COLOR, DEFAULT_COLOR] : [FULL, first[0], DEFAULT_COLOR]
    // Clear is behind: the colour is the glyph.
    if (first[0] === undefined || second[0] === undefined) {
      const colour = (first[0] ?? second[0]) as number
      return [glyph(maskOf(colour)), colour, DEFAULT_COLOR]
    }
    // Two colours: the fewer pixels drawn over the more. A third colour's pixels go to the second.
    const over = second[0]
    const under = first[0]
    const mask = quad.reduce<number>((m, p, i) => (p !== under ? m | (1 << i) : m), 0)
    return [glyph(mask), over, under]
  })
}

