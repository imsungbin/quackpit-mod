// The pane's dials: the session's pace now, the account's five-hour window as
// a fuel gauge, and health's score, each a semicircle with one needle. What a
// reading is read against sits outside the rim, never as a second needle: a
// bug (a short mark) for a reference (the pace's usual), a thin sweep from the
// needle for where a trend ends (the five-hour window at its reset). Caution
// and red zones colour the arc where they are a small end of it; a dial whose
// zones would cover most of its arc (health's) colours its needle instead.
// Drawn in pixels on every surface: quadrant blocks for a terminal's Raster
// (2x2 pixels a cell, at most two colours a cell, the needle and the bug in
// the terminal's own ink so they read on any theme), an anti-aliased RGBA
// image where the terminal shows pictures (kitty graphics), and SVG for the
// desktop. Box-drawing characters look jagged at this size, so none are used.
// Pure.

import { base64, DEFAULT_COLOR, QUADRANTS, type RasterCells } from './cells'
import type { Level } from './derive'
import { HEX } from './gauges'
import { hex, PixelCanvas, type ImageSource } from './pixels'

/** What a dial shows: the needle's place on its scale, its marks outside the rim, and where caution and red begin, each 0 to 1. */
export type DialSpec = {
  needle?: number
  /** Too little data, or a reading gone stale: the needle is grey, not ink, and no sweep is drawn. */
  isGrey: boolean
  /** A short mark outside the rim: what the needle reads against (the pace's usual). */
  bug?: number
  /** A thin arc outside the rim, from the needle to here: where the trend ends (the five-hour window at its reset). */
  sweep?: number
  warnFrom: number
  badFrom: number
  /** Zones that would cover most of the arc are left off: the needle takes the threshold's colour instead. */
  needleLevel?: Level
  noZones?: boolean
}

/**
 * A dial's size in terminal cells: an odd number of columns puts the hub in
 * the middle of a cell, so it shares one with no arc colour. The full size
 * sits beside four lines of words; the small one, in a narrow pane, beside three.
 */
export const DIAL_COLUMNS = 13
export const DIAL_ROWS = 4
export const SMALL_DIAL_COLUMNS = 9
export const SMALL_DIAL_ROWS = 3

/** The terminal's own foreground: what the needle, the hub and the bug are drawn in. */
export const INK = DEFAULT_COLOR

const RGB = {
  track: 0x6e7681,
  warn: 0xe3a008,
  bad: 0xf85149,
  grey: 0x8b949e,
} as const

type Pixels = (number | undefined)[][]

/** The angle of a place on the scale: 0 at the left end, 1 at the right, over the top. */
const angleOf = (f: number) => Math.PI * (1 - Math.max(0, Math.min(1, f)))

const SAMPLES = 4

/** A trend's end this near the needle says nothing the needle does not: no sweep. */
const SWEEP_MIN = 0.01

/** The needle's colour: grey with too little data, a threshold's past one (health), else ink. */
function needleColour(spec: DialSpec): number {
  if (spec.isGrey) return RGB.grey
  return spec.needleLevel === 'bad' ? RGB.bad : spec.needleLevel === 'warn' ? RGB.warn : INK
}

/**
 * The dial as pixels, `columns * 2` by `rows * 2`, each pixel one unit wide and
 * two tall as a quadrant is: the arc and its zones set in from the edges, so
 * the marks outside it have room; the bug and the sweep outside the rim; the
 * needle from the hub, short of the arc so the two never share a cell. The hub
 * is the bottom half of the middle cell.
 */
export function dialPixels(spec: DialSpec, columns = DIAL_COLUMNS, rows = DIAL_ROWS): Pixels {
  const w = columns * 2
  const h = rows * 2
  const isSmall = rows < DIAL_ROWS
  // In screen units: a pixel is 1 wide and 2 tall. The hub sits on the bottom pixel row.
  const cx = w / 2
  const cy = 2 * h - 1
  const outer = Math.min(cx - 0.5, cy - 2.4) - (isSmall ? 1.0 : 1.4)
  const inner = outer - 2.4
  // Short of the arc by a pixel row and more, so the needle and the arc never share a cell.
  const needleTo = inner - (isSmall ? 2.0 : 2.6)
  const theta = angleOf(spec.needle ?? 0)
  const needle = needleColour(spec)
  const zone = (f: number) => (spec.noZones ? RGB.track : f >= spec.badFrom ? RGB.bad : f >= spec.warnFrom ? RGB.warn : RGB.track)
  const ux = Math.cos(theta)
  const uy = Math.sin(theta)
  const hasNeedle = spec.needle !== undefined || spec.isGrey
  const bugTheta = spec.bug !== undefined ? angleOf(spec.bug) : undefined
  const bx = Math.cos(bugTheta ?? 0)
  const by = Math.sin(bugTheta ?? 0)
  // The sweep runs from the needle to the trend's end, either way round; none while grey.
  const from = Math.min(spec.needle ?? 0, spec.sweep ?? 0)
  const to = Math.max(spec.needle ?? 0, spec.sweep ?? 0)
  const hasSweep = spec.sweep !== undefined && !spec.isGrey && to - from >= SWEEP_MIN
  const grid: Pixels = []
  for (let py = 0; py < h; py++) {
    const row: (number | undefined)[] = []
    for (let px = 0; px < w; px++) {
      // The pixel's centre, and samples across it.
      const mx = px + 0.5 - cx
      const my = cy - (2 * py + 1)
      let colour: number | undefined
      let needleHits = 0
      let arcHits = 0
      let bugHits = 0
      let sweepHits = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const dx = px + (sx + 0.5) / SAMPLES - cx
          const dy = cy - (2 * py + (2 * (sy + 0.5)) / SAMPLES)
          const d = Math.hypot(dx, dy)
          const along = dx * ux + dy * uy
          if (hasNeedle && along >= 0 && along <= needleTo && Math.abs(dx * uy - dy * ux) <= 0.45) needleHits++
          if (dy >= -0.2 && d >= inner && d <= outer) arcHits++
          if (bugTheta !== undefined && Math.abs(dx * by - dy * bx) <= 1.4 && d >= outer + 0.15 && d <= outer + 2.2 && dx * bx + dy * by > 0) bugHits++
          if (hasSweep && dy >= -0.2 && d >= outer + 0.2 && d <= outer + 1.5) {
            const f = 1 - Math.atan2(Math.max(0, dy), dx) / Math.PI
            if (f >= from && f <= to) sweepHits++
          }
        }
      }
      // The hub: the bottom half of the middle cell.
      if (Math.abs(mx) < 1 && my <= 0.5 && my >= -1) colour = needle
      // Any touch of the needle draws it, so it stays one line at every angle.
      else if (needleHits > 0) colour = needle
      else if (bugHits >= 5) colour = INK
      else if (sweepHits >= 4) colour = RGB.grey
      else if (arcHits >= 6) colour = zone(1 - Math.atan2(Math.max(0, my), mx) / Math.PI)
      row.push(colour)
    }
    grid.push(row)
  }
  return grid
}

/** How strongly a colour holds its place in a cell that can show two: ink first, then grey, the zones, the track last. */
const RANK = (c: number) => (c === INK ? 5 : c === RGB.grey ? 4 : c === RGB.bad ? 3 : c === RGB.warn ? 2 : 1)

/**
 * The pixels as Raster cells, four to a cell. A cell shows two colours, clear
 * counting as one: where it holds more, the strongest stays and the others
 * join it (over clear) or the next strongest (behind it). Ink is always the
 * strongest and always the glyph's own colour, so it is drawn in the
 * terminal's foreground and never as a background.
 */
export function dialCells(pixels: Pixels): RasterCells {
  const columns = Math.ceil((pixels[0]?.length ?? 0) / 2)
  const rows = Math.ceil(pixels.length / 2)
  const view = new DataView(new ArrayBuffer(columns * rows * 12))
  const glyphOf = (mask: number) => (QUADRANTS[mask] ?? ' ').codePointAt(0) ?? 0x20
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const quad = [pixels[y * 2]?.[x * 2], pixels[y * 2]?.[x * 2 + 1], pixels[y * 2 + 1]?.[x * 2], pixels[y * 2 + 1]?.[x * 2 + 1]]
      const [first, second] = [...new Set(quad.filter((c): c is number => c !== undefined))].sort((a, b) => RANK(b) - RANK(a))
      let cell: [number, number, number] = [0x20, DEFAULT_COLOR, DEFAULT_COLOR]
      if (first !== undefined && (second === undefined || quad.includes(undefined))) {
        // Over clear: every coloured pixel in the strongest colour.
        cell = [glyphOf(quad.reduce<number>((m, c, i) => (c !== undefined ? m | (1 << i) : m), 0)), first, DEFAULT_COLOR]
      } else if (first !== undefined && second !== undefined) {
        // Filled: the strongest as the glyph, over the next.
        cell = [glyphOf(quad.reduce<number>((m, c, i) => (c === first ? m | (1 << i) : m), 0)), first, second]
      }
      const at = (y * columns + x) * 12
      view.setUint32(at, cell[0], true)
      view.setUint32(at + 4, cell[1], true)
      view.setUint32(at + 8, cell[2], true)
    }
  }
  return { cells: base64(new Uint8Array(view.buffer)), columns, rows }
}

/** Pixels per cell for the picture: twice a usual 8x16 cell, for sharp edges. */
const PX_W = 16
const PX_H = 32

/** A threshold's picture colour for a needle that carries one. */
function needleHex(spec: DialSpec): string {
  return spec.needleLevel === 'bad' ? HEX.bad : spec.needleLevel === 'warn' ? HEX.warn : HEX.neutral
}

/**
 * The dial as an anti-aliased picture, for terminals that show them: the same
 * arc, zones, marks and needle. A picture cannot follow the theme, so the ink
 * is the mid-tone the band's dial uses.
 */
export function dialImage(spec: DialSpec, columns = DIAL_COLUMNS, rows = DIAL_ROWS): ImageSource {
  const w = columns * PX_W
  const h = rows * PX_H
  const canvas = new PixelCanvas(w, h)
  const cx = w / 2
  const cy = h - 10
  const thick = Math.max(6, Math.round(h / 11))
  // Set in from the edges so the bug and the sweep have room outside the rim.
  const r = Math.min(w / 2 - thick / 2 - 4, cy - thick / 2 - 12) - thick
  canvas.arc(cx, cy, r, thick, 0, Math.PI, hex(HEX.track, 170))
  if (!spec.noZones) {
    canvas.arc(cx, cy, r, thick, angleOf(spec.badFrom), angleOf(spec.warnFrom), hex(HEX.warn))
    canvas.arc(cx, cy, r, thick, 0, angleOf(spec.badFrom), hex(HEX.bad))
  }
  const ring = r + thick / 2 + 5
  if (spec.sweep !== undefined && !spec.isGrey) {
    const a0 = angleOf(Math.max(spec.needle ?? 0, spec.sweep))
    const a1 = angleOf(Math.min(spec.needle ?? 0, spec.sweep))
    if (a1 - a0 >= SWEEP_MIN * Math.PI) canvas.arc(cx, cy, ring, 4, a0, a1, hex(HEX.grey, 200))
  }
  if (spec.bug !== undefined) {
    const b = angleOf(spec.bug)
    canvas.line(cx + (ring - 3) * Math.cos(b), cy - (ring - 3) * Math.sin(b), cx + (ring + 7) * Math.cos(b), cy - (ring + 7) * Math.sin(b), 4, hex(HEX.neutral))
  }
  const ink = spec.isGrey ? hex(HEX.grey, 150) : hex(needleHex(spec))
  if (spec.needle !== undefined || spec.isGrey) {
    const a = angleOf(spec.needle ?? 0)
    const len = r - thick - 8
    canvas.line(cx, cy, cx + len * Math.cos(a), cy - len * Math.sin(a), 4, ink)
  }
  canvas.disc(cx, cy, 7, ink)
  return canvas.toSource()
}

const r1 = (n: number) => Math.round(n * 10) / 10

/** A point on a circle, angle 0 to the right and counter-clockwise, screen y down. */
function polar(cx: number, cy: number, r: number, a: number): [number, number] {
  return [r1(cx + r * Math.cos(a)), r1(cy - r * Math.sin(a))]
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  return `M${x0} ${y0}A${r1(r)} ${r1(r)} 0 0 ${a1 < a0 ? 1 : 0} ${x1} ${y1}`
}

/**
 * The dial as SVG, for the desktop: its ink follows the app's colour scheme
 * through a media query inside the document.
 */
export function dialSvg(spec: DialSpec, width: number, height: number): string {
  const stroke = Math.max(4, Math.round(height / 9))
  const cx = width / 2
  const cy = height - stroke
  const r = Math.min(width / 2 - stroke, cy - stroke * 1.6) - stroke
  const style =
    `.t{stroke:${HEX.track};stroke-opacity:.55;fill:none}.w{stroke:${HEX.warn};fill:none}.b{stroke:${HEX.bad};fill:none}.s{stroke:${HEX.grey};fill:none}` +
    `.i{stroke:#1f2328;fill:#1f2328}.g{stroke:#8b949e;fill:#8b949e}.nw{stroke:${HEX.warn};fill:${HEX.warn}}.nb{stroke:${HEX.bad};fill:${HEX.bad}}@media (prefers-color-scheme: dark){.i{stroke:#e6edf3;fill:#e6edf3}}`
  const parts = [`<path class="t" stroke-width="${stroke}" stroke-linecap="round" d="${arcPath(cx, cy, r, Math.PI, 0)}"/>`]
  if (!spec.noZones) {
    parts.push(`<path class="w" stroke-width="${stroke}" d="${arcPath(cx, cy, r, angleOf(spec.warnFrom), angleOf(spec.badFrom))}"/>`)
    parts.push(`<path class="b" stroke-width="${stroke}" stroke-linecap="round" d="${arcPath(cx, cy, r, angleOf(spec.badFrom), 0)}"/>`)
  }
  const ring = r + stroke / 2 + 3
  if (spec.sweep !== undefined && !spec.isGrey) {
    const a0 = angleOf(Math.min(spec.needle ?? 0, spec.sweep))
    const a1 = angleOf(Math.max(spec.needle ?? 0, spec.sweep))
    if (a0 - a1 >= SWEEP_MIN * Math.PI) parts.push(`<path class="s" stroke-width="2" d="${arcPath(cx, cy, ring, a0, a1)}"/>`)
  }
  if (spec.bug !== undefined) {
    const [bx0, by0] = polar(cx, cy, ring - 1, angleOf(spec.bug))
    const [bx1, by1] = polar(cx, cy, ring + stroke, angleOf(spec.bug))
    parts.push(`<line class="i" stroke-width="2.5" x1="${bx0}" y1="${by0}" x2="${bx1}" y2="${by1}"/>`)
  }
  const cls = spec.isGrey ? 'g' : spec.needleLevel === 'bad' ? 'nb' : spec.needleLevel === 'warn' ? 'nw' : 'i'
  if (spec.needle !== undefined || spec.isGrey) {
    const [nx, ny] = polar(cx, cy, r - stroke - 3, angleOf(spec.needle ?? 0))
    parts.push(`<line class="${cls}" stroke-width="2.5" stroke-linecap="round" x1="${r1(cx)}" y1="${r1(cy)}" x2="${nx}" y2="${ny}"/>`)
  }
  parts.push(`<circle class="${cls}" cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(stroke * 0.8)}"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${style}</style>${parts.join('')}</svg>`
}
