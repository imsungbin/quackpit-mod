// The gauges as drawings, for each way a surface can show them:
//   - text: lines of block characters in theme colours, which any terminal
//     draws the same way: a tachometer ramp of eighth blocks for pace, a
//     half-block ring for context. The designed fallback.
//   - cells: a Raster for what needs two colours in a cell (the duck).
//   - pixels: an RGBA Image the terminal shows where it speaks the kitty
//     graphics protocol (kitty, Ghostty): a needle dial, a smooth ring.
// The SVG variant for the desktop lives in svg.ts. A graphic is described
// once (`Graphic`) and every drawer reads the same description. Pure.

import { quadrantCells, type RasterCells } from './cells'
import type { Level } from './derive'
import { hex, PixelCanvas, type ImageSource, type Rgba } from './pixels'
import { DUCK_12x4, DUCK_16, DUCK_8x2, DUCK_COLUMNS, DUCK_RGBA, IDLE_EYE, spritePixels, STEADY, type Frame, type Pose } from './sprites'
import type { Line, Span, Tone } from './text'

export type Graphic =
  | { kind: 'dial'; cols: number; rows: number; needle?: number; isGrey: boolean; warnFrom: number; badFrom: number; sweep?: number; bug?: number; needleLevel?: Level; noZones?: boolean }
  | { kind: 'ring'; cols: number; rows: number; pct?: number; level: Level }
  | { kind: 'duck'; cols: number; rows: number; pose: Pose }

/** Threshold colours for pictures, mid-tones that read on dark and light themes alike. */
export const HEX = {
  ok: '#3fb950',
  warn: '#e3a008',
  bad: '#f85149',
  track: '#6e7681',
  grey: '#8b949e',
  /** A needle and a ring's fill: light enough for dark themes, dark enough for light ones. */
  neutral: '#a3acb7',
} as const

function levelTone(level: Level): Tone | undefined {
  return level === 'bad' ? 'bad' : level === 'warn' ? 'warn' : level === 'ok' ? 'ok' : undefined
}

const EIGHTHS = ' ▁▂▃▄▅▆▇█'

// ------------------------------------------------------------------ text

/** Spans of one character each, merged where neighbours share a look. */
function merge(spans: Span[]): Line {
  const out: Line = []
  for (const s of spans) {
    const last = out.at(-1)
    if (last && last.tone === s.tone && last.bg === s.bg && last.bold === s.bold) last.text += s.text
    else out.push({ ...s })
  }
  return out
}

/**
 * A dial as a tachometer: `cols` bars rising left to right over `rows` rows,
 * lit up to the needle; the lead bar is the needle itself. The caution and
 * red zones are lit in their colours (or, on a dial with no zones, every lit
 * bar takes the needle's threshold colour), and with too little data every
 * lit bar is grey. A sweep (the fuel gauge's trend to its reset) lights the
 * bars beyond the needle in grey up to its end; the bug's bar is the accent.
 */
export function rampLines(g: Extract<Graphic, { kind: 'dial' }>): Line[] {
  const n = g.cols
  const eighths = g.rows * 8
  const lit = g.needle === undefined ? 0 : Math.max(g.needle > 0 ? 1 : 0, Math.round(g.needle * n))
  const sweep = g.sweep === undefined || g.isGrey ? lit : Math.max(lit, Math.round(Math.min(1, g.sweep) * n))
  const bug = g.bug === undefined ? -1 : Math.min(n - 1, Math.floor(g.bug * n))
  const needleTone = levelTone(g.needleLevel ?? 'none')
  const lines: Span[][] = Array.from({ length: g.rows }, () => [])
  for (let i = 0; i < n; i++) {
    const height = Math.max(1, Math.round((eighths * (i + 1)) / n))
    const f = (i + 0.5) / n
    let tone: Tone | undefined
    if (i >= lit) tone = i === bug ? 'accent' : i < sweep ? 'grey' : 'track'
    else if (g.isGrey) tone = 'grey'
    else if (g.noZones) tone = needleTone
    else tone = f >= g.badFrom ? 'bad' : f >= g.warnFrom ? 'warn' : undefined
    const isNeedle = i === lit - 1 && !g.isGrey
    for (let row = 0; row < g.rows; row++) {
      // Row 0 is the top: it holds what is left above the rows beneath it.
      const below = (g.rows - 1 - row) * 8
      const part = Math.max(0, Math.min(8, height - below))
      lines[row]?.push({ text: EIGHTHS[part] ?? ' ', ...(tone ? { tone } : {}), ...(isNeedle ? { bold: true } : {}) })
    }
  }
  return lines.map(merge)
}

/** The ring's outline, clockwise from 12 o'clock, on a `w` x `h` pixel grid. */
export function ringPixels(w: number, h: number): [number, number][] {
  const top: [number, number][] = []
  for (let x = 1; x < w - 1; x++) top.push([x, 0])
  const right: [number, number][] = []
  for (let y = 1; y < h - 1; y++) right.push([w - 1, y])
  const bottom: [number, number][] = []
  for (let x = w - 2; x > 0; x--) bottom.push([x, h - 1])
  const left: [number, number][] = []
  for (let y = h - 2; y > 0; y--) left.push([0, y])
  const ring = [...top, ...right, ...bottom, ...left]
  const start = Math.floor((w - 2) / 2)
  return [...ring.slice(start), ...ring.slice(0, start)]
}

/**
 * Context as a ring of half-block pixels (`cols` wide, `rows * 2` tall),
 * filled clockwise from the top in the level's colour, the rest unlit.
 */
export function ringLines(g: Extract<Graphic, { kind: 'ring' }>): Line[] {
  const w = g.cols
  const h = g.rows * 2
  const ring = ringPixels(w, h)
  const pct = Math.max(0, Math.min(100, g.pct ?? 0))
  const lit = Math.round((ring.length * pct) / 100)
  const tone = levelTone(g.level)
  const grid: (Tone | 'lit' | undefined)[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => undefined))
  ring.forEach(([x, y], i) => {
    const row = grid[y]
    if (row) row[x] = i < lit ? (tone ?? 'lit') : 'track'
  })
  const lines: Line[] = []
  for (let cy = 0; cy < g.rows; cy++) {
    const spans: Span[] = []
    for (let x = 0; x < w; x++) {
      const top = grid[cy * 2]?.[x]
      const bottom = grid[cy * 2 + 1]?.[x]
      const as = (t: Tone | 'lit'): Tone | undefined => (t === 'lit' ? undefined : t)
      if (top === undefined && bottom === undefined) spans.push({ text: ' ' })
      else if (top !== undefined && bottom !== undefined) {
        if (top === bottom) spans.push({ text: '█', ...(as(top) ? { tone: as(top) } : {}) })
        else spans.push({ text: '▀', ...(as(top) ? { tone: as(top) } : {}), ...(as(bottom) ? { bg: as(bottom) } : {}) })
      } else if (top !== undefined) spans.push({ text: '▀', ...(as(top) ? { tone: as(top) } : {}) })
      else if (bottom !== undefined) spans.push({ text: '▄', ...(as(bottom) ? { tone: as(bottom) } : {}) })
    }
    lines.push(merge(spans))
  }
  return lines
}

/** A graphic as text lines, for surfaces drawing designed text. The duck has none. */
export function graphicLines(g: Graphic): Line[] | undefined {
  if (g.kind === 'dial') return rampLines(g)
  if (g.kind === 'ring') return ringLines(g)
  return undefined
}

// ------------------------------------------------------------------ cells

/** The duck as Raster cells: a frame of the 2-row duck (12x4 in quadrants, 6 columns), or the one-row band's 4 columns. */
export function duckCells(frame: Frame, rows: 1 | 2): RasterCells {
  if (rows === 1) return quadrantCells(spritePixels(DUCK_8x2), 8)
  return quadrantCells(spritePixels(DUCK_12x4[frame]), 12, frame === 'idle' ? IDLE_EYE : {})
}

// ------------------------------------------------------------------ pixels

/** Pixels per cell for the Image variant: twice the usual 8x16 cell, for sharp edges. */
export const PX_W = 16
export const PX_H = 32

function levelRgba(level: Level, fallback: Rgba): Rgba {
  return level === 'bad' ? hex(HEX.bad) : level === 'warn' ? hex(HEX.warn) : level === 'ok' ? hex(HEX.ok) : fallback
}

const dialAngle = (f: number) => Math.PI * (1 - Math.max(0, Math.min(1, f)))

/** A needle gauge: caution and red arcs, five ticks, the needle grey with too little data. */
export function dialImage(g: Extract<Graphic, { kind: 'dial' }>): ImageSource {
  const w = g.cols * PX_W
  const h = g.rows * PX_H
  const canvas = new PixelCanvas(w, h)
  const cx = w / 2
  const cy = h - 7
  const thick = Math.max(3, Math.round(h / 11))
  const r = Math.min(w / 2 - thick - 2, cy - thick - 2)
  canvas.arc(cx, cy, r, thick, 0, Math.PI, hex(HEX.track, 150))
  canvas.arc(cx, cy, r, thick, dialAngle(g.badFrom), dialAngle(g.warnFrom), hex(HEX.warn))
  canvas.arc(cx, cy, r, thick, 0, dialAngle(g.badFrom), hex(HEX.bad))
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const a = dialAngle(f)
    const inner = r - thick - (f === 0.5 ? 5 : 3)
    canvas.line(cx + inner * Math.cos(a), cy - inner * Math.sin(a), cx + (r - thick) * Math.cos(a), cy - (r - thick) * Math.sin(a), f === 0.5 ? 2.5 : 1.5, hex(HEX.grey, 200))
  }
  // With too little data the needle is a faint grey; otherwise solid.
  const needleColor = g.isGrey ? hex(HEX.grey, 110) : hex(HEX.neutral)
  const a = dialAngle(g.isGrey || g.needle === undefined ? 0 : g.needle)
  canvas.line(cx, cy, cx + (r - 2) * Math.cos(a), cy - (r - 2) * Math.sin(a), 3, needleColor)
  canvas.disc(cx, cy, 5, needleColor)
  return canvas.toSource()
}

export function ringImage(g: Extract<Graphic, { kind: 'ring' }>): ImageSource {
  const w = g.cols * PX_W
  const h = g.rows * PX_H
  const canvas = new PixelCanvas(w, h)
  const size = Math.min(w, h)
  const thick = Math.max(5, Math.round(size / 7))
  const r = size / 2 - thick / 2 - 2
  const cx = w / 2
  const cy = h / 2
  canvas.arc(cx, cy, r, thick, 0, 2 * Math.PI, hex(HEX.track, 110))
  const pct = Math.max(0, Math.min(100, g.pct ?? 0))
  if (pct > 0) {
    const start = Math.PI / 2 - (2 * Math.PI * pct) / 100
    canvas.arc(cx, cy, r, thick, start, Math.PI / 2, levelRgba(g.level, hex(HEX.neutral)))
  }
  return canvas.toSource()
}

/** The 16x16 duck at four pixels a pixel, centred in its 2-row cell's own shape so the terminal does not stretch it. */
export function duckImage(pose: Frame): ImageSource {
  const width = DUCK_COLUMNS * PX_W
  const canvas = new PixelCanvas(width, 2 * PX_H)
  canvas.sprite(DUCK_16[pose], DUCK_RGBA, Math.floor((width - 64) / 2), 0, 4)
  return canvas.toSource()
}

export function graphicImage(g: Graphic): ImageSource {
  switch (g.kind) {
    case 'dial':
      return dialImage(g)
    case 'ring':
      return ringImage(g)
    case 'duck':
      return duckImage(STEADY[g.pose])
  }
}

/** A 1x1 clear pixel: what the band blits once to learn whether images show. */
export function probeImage(): ImageSource {
  return new PixelCanvas(1, 1).toSource()
}

