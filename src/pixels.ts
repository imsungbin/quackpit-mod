// A small RGBA canvas for the pixel variant: anti-aliased arcs, lines and
// discs (coverage from signed distance, 4x4 supersampled at edges), and
// sprites from a palette grid. Its output is an Image source the terminal
// draws with the kitty graphics protocol. Pure; no host API.

import { base64 } from './cells'

export type Rgba = readonly [number, number, number, number]

export type ImageSource = { rgba: string; width: number; height: number }

export function hex(color: string, alpha = 255): Rgba {
  const h = color.replace('#', '')
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) || 0
  return [n(0), n(2), n(4), h.length >= 8 ? n(6) : alpha]
}

const SAMPLES = 4

export class PixelCanvas {
  readonly data: Uint8ClampedArray

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4)
  }

  /** Paints `color` over pixel (x, y) at `coverage` (0 to 1), source-over. */
  blend(x: number, y: number, color: Rgba, coverage: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || coverage <= 0) return
    const i = (y * this.width + x) * 4
    const sa = (color[3] / 255) * Math.min(1, coverage)
    const da = (this.data[i + 3] ?? 0) / 255
    const oa = sa + da * (1 - sa)
    if (oa <= 0) return
    for (let k = 0; k < 3; k++) {
      const s = color[k] ?? 0
      const d = this.data[i + k] ?? 0
      this.data[i + k] = (s * sa + d * da * (1 - sa)) / oa
    }
    this.data[i + 3] = oa * 255
  }

  /**
   * Fills where `inside(px, py)` holds, sampled 4x4 per pixel within the
   * bounding box, so edges come out smooth.
   */
  fill(color: Rgba, box: readonly [number, number, number, number], inside: (x: number, y: number) => boolean): void {
    const [x0, y0, x1, y1] = box
    const fx0 = Math.max(0, Math.floor(x0))
    const fy0 = Math.max(0, Math.floor(y0))
    const fx1 = Math.min(this.width - 1, Math.ceil(x1))
    const fy1 = Math.min(this.height - 1, Math.ceil(y1))
    for (let y = fy0; y <= fy1; y++) {
      for (let x = fx0; x <= fx1; x++) {
        let hits = 0
        for (let sy = 0; sy < SAMPLES; sy++) {
          for (let sx = 0; sx < SAMPLES; sx++) {
            if (inside(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES)) hits++
          }
        }
        if (hits > 0) this.blend(x, y, color, hits / (SAMPLES * SAMPLES))
      }
    }
  }

  disc(cx: number, cy: number, r: number, color: Rgba): void {
    this.fill(color, [cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1], (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r)
  }

  /**
   * A stroked arc of radius r and thickness w around (cx, cy) from a0 to a1
   * (radians, 0 right, counter-clockwise, screen y down), with round caps.
   */
  arc(cx: number, cy: number, r: number, w: number, a0: number, a1: number, color: Rgba): void {
    const lo = Math.min(a0, a1)
    const hi = Math.max(a0, a1)
    const half = w / 2
    const cap = (a: number) => [cx + r * Math.cos(a), cy - r * Math.sin(a)] as const
    const [sx, sy] = cap(lo)
    const [ex, ey] = cap(hi)
    const pad = r + w
    this.fill(color, [cx - pad, cy - pad, cx + pad, cy + pad], (x, y) => {
      const dx = x - cx
      const dy = cy - y
      const d = Math.hypot(dx, dy)
      if (Math.abs(d - r) <= half) {
        const a = Math.atan2(dy, dx)
        // The arc may run past -pi or pi: try the angle one turn either way too.
        for (const turn of [0, 2 * Math.PI, -2 * Math.PI]) {
          if (a + turn >= lo && a + turn <= hi) return true
        }
      }
      return (x - sx) ** 2 + (y - sy) ** 2 <= half * half || (x - ex) ** 2 + (y - ey) ** 2 <= half * half
    })
  }

  /** A line of width w with round caps. */
  line(x0: number, y0: number, x1: number, y1: number, w: number, color: Rgba): void {
    const half = w / 2
    const vx = x1 - x0
    const vy = y1 - y0
    const len2 = vx * vx + vy * vy || 1
    this.fill(color, [Math.min(x0, x1) - w, Math.min(y0, y1) - w, Math.max(x0, x1) + w, Math.max(y0, y1) + w], (x, y) => {
      const t = Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / len2))
      return (x - (x0 + t * vx)) ** 2 + (y - (y0 + t * vy)) ** 2 <= half * half
    })
  }

  /** A rounded rectangle, filled. */
  roundRect(x: number, y: number, w: number, h: number, r: number, color: Rgba): void {
    this.fill(color, [x - 1, y - 1, x + w + 1, y + h + 1], (px, py) => {
      const qx = Math.max(Math.abs(px - (x + w / 2)) - (w / 2 - r), 0)
      const qy = Math.max(Math.abs(py - (y + h / 2)) - (h / 2 - r), 0)
      return Math.hypot(qx, qy) <= r
    })
  }

  /** Paints a palette sprite at (ox, oy), `scale` canvas pixels per sprite pixel. */
  sprite(rows: readonly string[], palette: Readonly<Record<string, Rgba>>, ox: number, oy: number, scale: number): void {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const color = palette[row[x] ?? '.']
        if (!color) continue
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) this.blend(ox + x * scale + dx, oy + y * scale + dy, color, 1)
        }
      }
    })
  }

  toSource(): ImageSource {
    return { rgba: base64(new Uint8Array(this.data.buffer)), width: this.width, height: this.height }
  }
}
