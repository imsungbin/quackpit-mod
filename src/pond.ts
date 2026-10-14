// The swimming duck: how far across the work in hand is, drawn as a duck
// crossing water to a checkered flag. Behind it the water it crossed lies
// calm and pale; ahead, the water still to cross. The band's pond is one row
// with a duckling (the one-row duck); the pane's is two rows with the duck
// itself, eye open. It moves only when the band or pane redraws (an event, or
// the 30-second tick), never on its own. Cells for a terminal's Raster and
// the same pixels as SVG for the desktop. Pure.

import { quadrantCells, type RasterCells } from './cells'
import { DUCK_12x4, DUCK_8x2, DUCK_RGB } from './sprites'

/** Water still to cross, water crossed, and the flag's two squares (light and dark, so it reads on either theme). */
export const POND_RGB = { water: 0x3a8ee6, wake: 0x9fd0f7, flagLight: 0x9a9a9a, flagDark: 0x2b1d18 } as const

/** The narrowest pond worth drawing: the duckling, the flag and room to move. */
export const MIN_POND_COLUMNS = 8
/** The pane's pond: the duck, the flag and room to move. */
export const MIN_BIG_POND_COLUMNS = 12

type Pixels = (number | undefined)[][]

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0)

/** Paints a sprite's pixels over `grid` with its left edge at pixel `x`. */
function paint(grid: Pixels, sprite: readonly string[], x: number) {
  sprite.forEach((row, y) => {
    for (let i = 0; i < row.length; i++) {
      const rgb = DUCK_RGB[row[i] ?? '.']
      const line = grid[y]
      if (rgb !== undefined && line && x + i < line.length) line[x + i] = rgb
    }
  })
}

/**
 * The band's pond, `columns` wide and one row tall (2x2 pixels a cell): the
 * duckling at `fraction` of the way across, the flag in the last column.
 */
export function pondPixels(columns: number, fraction: number): Pixels {
  const w = Math.max(MIN_POND_COLUMNS, Math.floor(columns)) * 2
  const top: (number | undefined)[] = Array.from({ length: w }, () => undefined)
  const bottom: (number | undefined)[] = Array.from({ length: w }, () => POND_RGB.water)
  // The duckling is 4 columns wide; it swims from the first column to just short of the flag.
  const x = Math.round(clamp01(fraction) * (w / 2 - 1 - 4)) * 2
  for (let i = 0; i < x + 2; i++) bottom[i] = POND_RGB.wake
  top[w - 2] = POND_RGB.flagLight
  top[w - 1] = POND_RGB.flagDark
  bottom[w - 2] = POND_RGB.flagDark
  bottom[w - 1] = POND_RGB.flagLight
  const grid: Pixels = [top, bottom]
  paint(grid, DUCK_8x2, x)
  return grid
}

export function pondCells(columns: number, fraction: number): RasterCells {
  const pixels = pondPixels(columns, fraction)
  return quadrantCells(pixels, pixels[0]?.length ?? 0)
}

/**
 * The pane's pond, `columns` wide and two rows tall: water from column
 * `from` on (the work's start on the pane's time axis; blank before it), the
 * duck at `fraction` of the way across it, eye open, and the flag on its pole
 * at the end.
 */
export function bigPondPixels(columns: number, fraction: number, from = 0): Pixels {
  const w = Math.max(MIN_BIG_POND_COLUMNS, Math.floor(columns)) * 2
  const start = Math.max(0, Math.min(w / 2 - MIN_BIG_POND_COLUMNS, Math.floor(from))) * 2
  const grid: Pixels = Array.from({ length: 4 }, () => Array.from({ length: w }, () => undefined))
  const line = grid[3] as (number | undefined)[]
  for (let i = start; i < w; i++) line[i] = POND_RGB.water
  // The duck is 6 columns wide; it swims from the water's start to just short of the flag.
  const x = start + Math.round(clamp01(fraction) * ((w - start) / 2 - 1 - 6)) * 2
  for (let i = start; i < x + 4; i++) line[i] = POND_RGB.wake
  const flag = w - 2
  ;(grid[0] as (number | undefined)[])[flag] = POND_RGB.flagLight
  ;(grid[0] as (number | undefined)[])[flag + 1] = POND_RGB.flagDark
  ;(grid[1] as (number | undefined)[])[flag] = POND_RGB.flagDark
  ;(grid[1] as (number | undefined)[])[flag + 1] = POND_RGB.flagLight
  ;(grid[2] as (number | undefined)[])[flag] = POND_RGB.flagDark
  // The pole stands at the water's end: nothing beside it, so its cell keeps to two colours.
  line[flag] = POND_RGB.flagDark
  line[flag + 1] = undefined
  paint(grid, DUCK_12x4.shut, x)
  return grid
}

export function bigPondCells(columns: number, fraction: number, from = 0): RasterCells {
  const pixels = bigPondPixels(columns, fraction, from)
  return quadrantCells(pixels, pixels[0]?.length ?? 0)
}

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`

/** The same pixels as an SVG, for the desktop: one rect a run of a colour, crisp. */
export function pixelsSvg(pixels: Pixels, width: number, height: number): string {
  const rows = pixels.length
  const cols = pixels[0]?.length ?? 0
  const rects: string[] = []
  pixels.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const rgb = row[x]
      let run = 1
      while (x + run < row.length && row[x + run] === rgb) run++
      if (rgb !== undefined) rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${hex(rgb)}"/>`)
      x += run
    }
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${cols} ${rows}" preserveAspectRatio="none" shape-rendering="crispEdges">${rects.join('')}</svg>`
}
