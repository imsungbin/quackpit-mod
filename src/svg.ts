// The desktop variant's drawings: the same gauges as SVG documents, which
// the Claude Code desktop app (and the editor and mobile panes) draw as
// images. Neutral ink follows the app's colour scheme through a media query
// inside the document; threshold colours are the same mid-tones as the
// terminal's. Pure strings; no host API.

import { SOURCE_COLORS, type BarPart } from './context'
import type { Level } from './derive'
import { dotColumns, GLYPH_HEIGHT } from './font'
import { HEX, type Graphic } from './gauges'
import { DUCK_16, DUCK_COLORS, STEADY, type Frame } from './sprites'

// Stroke and fill classes are separate: a class's `fill` would override a
// `fill="none"` attribute and turn every arc into a wedge.
const STYLE =
  '.s-ink{stroke:#1f2328;fill:none}.f-ink{fill:#1f2328}.s-dim{stroke:#8b949e;fill:none}.f-dim{fill:#8b949e}' +
  '@media (prefers-color-scheme: dark){.s-ink{stroke:#e6edf3}.f-ink{fill:#e6edf3}}' +
  `.s-ok{stroke:${HEX.ok};fill:none}.f-ok{fill:${HEX.ok}}.s-warn{stroke:${HEX.warn};fill:none}.f-warn{fill:${HEX.warn}}` +
  `.s-bad{stroke:${HEX.bad};fill:none}.f-bad{fill:${HEX.bad}}.s-track{stroke:${HEX.track};stroke-opacity:.45;fill:none}` +
  `.s-grey{stroke:${HEX.grey};fill:none}.f-grey{fill:${HEX.grey}}`

function doc(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${STYLE}</style>${body}</svg>`
}

function levelClass(level: Level): string {
  return level === 'bad' ? 'bad' : level === 'warn' ? 'warn' : level === 'ok' ? 'ok' : 'ink'
}

/** The stroke class and the fill class of a colour name. */
const st = (name: string) => `s-${name}`
const fi = (name: string) => `f-${name}`

const r1 = (n: number) => Math.round(n * 10) / 10

function polar(cx: number, cy: number, r: number, a: number): [number, number] {
  return [r1(cx + r * Math.cos(a)), r1(cy - r * Math.sin(a))]
}

/** An arc path from angle a0 to a1 (radians, 0 right, counter-clockwise), drawn the short way unless large. */
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  const sweep = a1 < a0 ? 1 : 0
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0
  return `M${x0} ${y0}A${r1(r)} ${r1(r)} 0 ${large} ${sweep} ${x1} ${y1}`
}

const dialAngle = (f: number) => Math.PI * (1 - Math.max(0, Math.min(1, f)))

export function dialSvg(g: Extract<Graphic, { kind: 'dial' }>, width = 72, height = 44): string {
  const cx = width / 2
  const cy = height - 6
  const stroke = 5
  const r = Math.min(width / 2 - stroke, cy - stroke)
  const parts = [
    `<path class="${st('track')}" stroke-width="${stroke}" stroke-linecap="round" d="${arcPath(cx, cy, r, Math.PI, 0)}"/>`,
    `<path class="${st('warn')}" stroke-width="${stroke}" d="${arcPath(cx, cy, r, dialAngle(g.warnFrom), dialAngle(g.badFrom))}"/>`,
    `<path class="${st('bad')}" stroke-width="${stroke}" stroke-linecap="round" d="${arcPath(cx, cy, r, dialAngle(g.badFrom), 0)}"/>`,
  ]
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const [x0, y0] = polar(cx, cy, r - stroke - (f === 0.5 ? 5 : 3), dialAngle(f))
    const [x1, y1] = polar(cx, cy, r - stroke + 1, dialAngle(f))
    parts.push(`<line class="${st('dim')}" stroke-width="${f === 0.5 ? 2 : 1}" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`)
  }
  const a = dialAngle(g.isGrey || g.needle === undefined ? 0 : g.needle)
  const [nx, ny] = polar(cx, cy, r - 3, a)
  const cls = g.isGrey ? 'grey' : 'ink'
  parts.push(`<line class="${st(cls)}" stroke-width="2.5" stroke-linecap="round" x1="${r1(cx)}" y1="${r1(cy)}" x2="${nx}" y2="${ny}"/>`)
  parts.push(`<circle class="${fi(cls)}" cx="${r1(cx)}" cy="${r1(cy)}" r="3.5"/>`)
  return doc(width, height, parts.join(''))
}

export function ringSvg(g: Extract<Graphic, { kind: 'ring' }>, size = 44): string {
  const stroke = 6
  const r = size / 2 - stroke / 2 - 1
  const c = size / 2
  const pct = Math.max(0, Math.min(100, g.pct ?? 0))
  const parts = [`<circle class="${st('track')}" stroke-width="${stroke}" cx="${c}" cy="${c}" r="${r1(r)}"/>`]
  if (pct >= 99.95) {
    parts.push(`<circle class="${st(levelClass(g.level))}" stroke-width="${stroke}" cx="${c}" cy="${c}" r="${r1(r)}"/>`)
  } else if (pct > 0) {
    parts.push(
      `<path class="${st(levelClass(g.level))}" stroke-width="${stroke}" stroke-linecap="round" d="${arcPath(c, c, r, Math.PI / 2, Math.PI / 2 - (2 * Math.PI * pct) / 100)}"/>`,
    )
  }
  return doc(size, size, parts.join(''))
}

export function duckSvg(frame: Frame, size = 40): string {
  const rows = DUCK_16[frame]
  const rects: string[] = []
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const ch = row[x] ?? '.'
      let run = 1
      while (row[x + run] === ch) run++
      const color = (DUCK_COLORS as Record<string, string>)[ch]
      if (color) rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${color}"/>`)
      x += run
    }
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges">${rects.join('')}</svg>`
}

export function graphicSvg(g: Graphic): string {
  switch (g.kind) {
    case 'dial':
      return dialSvg(g)
    case 'ring':
      return ringSvg(g)
    case 'duck':
      return duckSvg(STEADY[g.pose])
  }
}

/** The hero's number in the same block font as the terminal's. */
export function digitsSvg(text: string, height = 36, level: Level = 'none'): string {
  const columns = dotColumns(text)
  const px = height / GLYPH_HEIGHT
  const width = Math.max(1, Math.ceil(columns.length * px))
  const cells: string[] = []
  columns.forEach((column, x) => {
    column.forEach((lit, y) => {
      if (lit) cells.push(`<rect x="${r1(x * px)}" y="${r1(y * px)}" width="${r1(px * 0.94)}" height="${r1(px * 0.94)}" rx="${r1(px * 0.12)}"/>`)
    })
  })
  return doc(width, height, `<g class="${fi(levelClass(level))}">${cells.join('')}</g>`)
}



/**
 * The context's bar as SVG: each source's part a rectangle in its own colour,
 * at its exact share; the free space as dots and the buffer as hatching, both
 * in the neutral dim ink, so where the dots end is the auto-compact point.
 */
export function barSvg(parts: readonly BarPart[], width = 312, height = 18): string {
  const total = parts.reduce((sum, p) => sum + p.tokens, 0)
  const top = Math.round(height * 0.2)
  const h = height - 2 * top
  const out: string[] = []
  let x = 0
  for (const p of parts) {
    const w = total > 0 ? (p.tokens / total) * width : 0
    if (w <= 0) continue
    if (p.id === 'free') {
      // A dot every cell's width, centred, as the terminal draws `·`.
      for (let cx = x + 4; cx < x + w; cx += 8) out.push(`<circle class="${fi('dim')}" cx="${r1(cx)}" cy="${r1(height / 2)}" r="1"/>`)
    } else if (p.id === 'buffer') {
      for (let hx = x; hx < x + w; hx += 4) out.push(`<line class="${st('dim')}" stroke-width="1" x1="${r1(hx)}" y1="${top + h}" x2="${r1(Math.min(x + w, hx + h))}" y2="${top}"/>`)
    } else out.push(`<rect x="${r1(x)}" y="${top}" width="${r1(w)}" height="${h}" fill="${SOURCE_COLORS[p.id]}"/>`)
    x += w
  }
  return doc(width, height, out.join(''))
}
