// Packing tiles into the band: lines of 2-row tiles that wrap by width, the
// hero stretched over what its line has left, a 1-cell gutter between tiles,
// and one dense row when the band is narrower than 80 columns or set to a
// single row. Pure.

import { digitColumns } from './font'
import { compactFace, denseLine, duckFace, HERO_MAX, HERO_MIN, heroFace, tileFace, type Face, type Readings, type TileId } from './tiles'
import type { Line } from './text'

/** Under this many columns the band is one dense row. */
export const DENSE_BELOW = 80

/** Rows left for another mod's band beneath quackpit's before quackpit takes more than one. */
export const ROWS_LEFT_BENEATH = 4

/**
 * The rows quackpit may take when another mod's band is drawn beneath it,
 * which it cannot measure: the rows the person allows while at least 4 are
 * left for the band beneath (so the 2-row grid from `maxRows` 6 up), else the
 * one dense row, and none where even that would not fit beside it.
 */
export function sharedRows(rows: number, maxRows: number): number {
  if (maxRows >= 2 + ROWS_LEFT_BENEATH) return Math.max(1, Math.min(Math.floor(rows), Math.floor(maxRows) - ROWS_LEFT_BENEATH))
  return maxRows >= 2 ? 1 : 0
}
export const GUTTER = 1
/** The "+n" mark for tiles that found no room, with its gutter. */
export const OVERFLOW_MARK = 4

export type BandPlan =
  | { kind: 'dense'; line: Line; withDuck: boolean }
  | {
      kind: 'grid'
      lines: Face[][]
      /** With 3 rows, the tiles that did not fit, as one dense row under the tiles. */
      strip?: Line
      /** Tiles that found no room at all. */
      overflow: TileId[]
    }

export type BandInput = {
  readings: Readings
  tiles: readonly TileId[]
  /** Columns the band may draw in. */
  width: number
  /** Rows the person allows (1 to 4) and rows the surface has. */
  rows: number
  maxRows: number
  withDuck: boolean
}

function lineUsed(faces: readonly Face[]): number {
  return faces.reduce((sum, f, i) => sum + f.width + (i > 0 ? GUTTER : 0), 0)
}

/** Columns a face's graphic and digits take, with their gaps: the rest is text. */
export function faceChrome(f: Face): number {
  return (f.graphic ? f.graphic.cols + 1 : 0) + (f.digits ? digitColumns(f.digits.text) + 1 : 0)
}

type Grid = { lines: Face[][]; overflow: TileId[] }

/** Places faces in lines, wrapping by width; what finds no room overflows. */
function place(r: Readings, tiles: readonly TileId[], width: number, lineCount: number, withDuck: boolean, isCompact: (id: TileId) => boolean): Grid {
  const lines: Face[][] = Array.from({ length: lineCount }, () => [])
  if (withDuck) lines[0]?.push(duckFace(r))
  const overflow: TileId[] = []
  let current = 0
  for (const id of tiles) {
    // The hero starts at its minimum; it takes the spare room once every tile is placed.
    const f = id === 'progress' ? heroFace(r, HERO_MIN) : isCompact(id) ? compactFace(r, id) : tileFace(r, id)
    let placed = false
    while (current < lineCount) {
      const line = lines[current] ?? []
      const room = width - lineUsed(line) - (line.length > 0 ? GUTTER : 0)
      if (f.width <= room) {
        line.push(f)
        placed = true
        break
      }
      current++
    }
    if (!placed) {
      overflow.push(id)
      current = lineCount - 1
    }
  }
  // The "+n" mark needs its room on the last line: tiles give way to it from the end.
  const last = lines[lineCount - 1]
  while (overflow.length > 0 && last && lineUsed(last) + OVERFLOW_MARK > width) {
    const i = last.findLastIndex(f => f.id !== 'progress' && f.id !== 'duck')
    if (i < 0) break
    const [gone] = last.splice(i, 1)
    if (gone && gone.id !== 'duck' && gone.id !== 'more') overflow.unshift(gone.id)
  }
  return { lines, overflow }
}

export function planBand(input: BandInput): BandPlan {
  const { readings: r, tiles, width } = input
  const budget = Math.max(1, Math.min(4, Math.floor(input.rows), Math.floor(input.maxRows)))
  if (width < DENSE_BELOW || budget < 2) {
    // The duck takes 5 columns beside the line: below 20 the line keeps them.
    const withDuck = input.withDuck && width >= 20
    return { kind: 'dense', line: denseLine(r, tiles, Math.max(1, width - (withDuck ? 5 : 0)), withDuck), withDuck }
  }
  const lineCount = budget >= 4 ? 2 : 1
  // Full faces first; short of room, the rightmost tiles turn compact one by one.
  const others = tiles.filter(id => id !== 'progress')
  let grid = place(r, tiles, width, lineCount, input.withDuck, () => false)
  for (let n = 1; grid.overflow.length > 0 && n <= others.length; n++) {
    const compact = new Set<TileId>(others.slice(others.length - n))
    const next = place(r, tiles, width, lineCount, input.withDuck, id => compact.has(id))
    if (next.overflow.length <= grid.overflow.length) grid = next
  }
  const { lines, overflow } = grid
  // The hero takes what its line has left, up to its maximum text width,
  // leaving room on the last line for the "+n" mark when tiles overflowed.
  lines.forEach((line, n) => {
    const i = line.findIndex(f => f.id === 'progress')
    const hero = line[i]
    if (!hero) return
    const reserve = overflow.length > 0 && n === lines.length - 1 ? OVERFLOW_MARK : 0
    const text = hero.width - faceChrome(hero)
    const grown = Math.min(HERO_MAX, text + (width - lineUsed(line) - reserve))
    if (grown > text) line[i] = heroFace(r, grown)
  })
  const plan: BandPlan = { kind: 'grid', lines: lines.filter(l => l.length > 0), overflow }
  if (budget === 3 && overflow.length > 0) plan.strip = denseLine(r, overflow, width, false)
  return plan
}

/** How many rows a plan draws. */
export function planRows(plan: BandPlan): number {
  if (plan.kind === 'dense') return 1
  return plan.lines.length * 2 + (plan.strip ? 1 : 0)
}
