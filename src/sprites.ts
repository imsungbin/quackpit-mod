// The duck: quackpit's own rubber duck, drawn for this project (not Clawd,
// not any existing character): a round head over a body a little longer than
// it is tall, a plain dark eye. Three frames: `idle`, asleep with its eye
// shut; `alert`, eye open, bill open; and `shut`, eye open, bill closed,
// which is also how it holds while a caution stands. Each comes at three
// sizes: 16x16 for the pixel and SVG variants, 12x4 for the terminal's 2-row
// cell (quadrant blocks, 6 columns) and 8x2 for the one-row band (4 columns).
// The body is the same in every frame. Pure data.

import type { CellOverride } from './cells'
import type { Rgba } from './pixels'

export type Pose = 'idle' | 'alert'
/** A frame of the duck: its two poses, and `shut`, the alert pose with its bill closed. */
export type Frame = Pose | 'shut'

/** Body, wing shade, belly shade, bill, open mouth, and the eye (a warm dark, so it reads as an eye and not a hole). */
export const DUCK_COLORS = {
  Y: '#ffd23f',
  s: '#f2b72a',
  y: '#e0a91c',
  O: '#ff8a1f',
  m: '#7a2a10',
  K: '#2b1d18',
} as const

export const DUCK_RGBA: Record<string, Rgba> = Object.fromEntries(
  Object.entries(DUCK_COLORS).map(([k, v]) => [k, [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 255] as const]),
)

export const DUCK_RGB: Record<string, number> = Object.fromEntries(
  Object.entries(DUCK_COLORS).map(([k, v]) => [k, parseInt(v.slice(1), 16)]),
)

/** How the duck holds while it is not quacking: asleep, or with a caution standing, head up and bill closed. */
export const STEADY: Record<Pose, Frame> = { idle: 'idle', alert: 'shut' }

/** 16x16, facing right: a round head, the body a little longer than it is tall, the eye a plain dark mark. */
export const DUCK_16: Record<Frame, readonly string[]> = {
  idle: [
    '................',
    '................',
    '................',
    '................',
    '.........YYYY...',
    '........YYYYYY..',
    '........YYYYYYOO',
    '.Y......YYYKKYOO',
    '.YY.....YYYYYY..',
    '.YYY...YYYYYYY..',
    '.YYYYYYYYYYYYYY.',
    '.YYYsssssYYYYYY.',
    '..YYYsssYYYYYY..',
    '...YYYYYYYYYYY..',
    '.....yyyyyyyy...',
    '................',
  ],
  alert: [
    '................',
    '................',
    '................',
    '................',
    '.........YYYY...',
    '........YYYYYYOO',
    '........YYYYKYmm',
    '.Y......YYYYKYOO',
    '.YY.....YYYYYY..',
    '.YYY...YYYYYYY..',
    '.YYYYYYYYYYYYYY.',
    '.YYYsssssYYYYYY.',
    '..YYYsssYYYYYY..',
    '...YYYYYYYYYYY..',
    '.....yyyyyyyy...',
    '................',
  ],
  shut: [
    '................',
    '................',
    '................',
    '................',
    '.........YYYY...',
    '........YYYYYY..',
    '........YYYYKYOO',
    '.Y......YYYYKYOO',
    '.YY.....YYYYYY..',
    '.YYY...YYYYYYY..',
    '.YYYYYYYYYYYYYY.',
    '.YYYsssssYYYYYY.',
    '..YYYsssYYYYYY..',
    '...YYYYYYYYYYY..',
    '.....yyyyyyyy...',
    '................',
  ],
}

/** How many terminal columns the 2-row duck takes: 12 pixels, two to a column. */
export const DUCK_COLUMNS = 6

/**
 * 12x4: the terminal's 2-row cell in quadrant blocks, 6 columns. A quadrant
 * pixel is twice as tall as it is wide, so 12x4 of them draw about 1.5 wide to
 * 1 tall: a round head over a body that narrows underneath, a plain eye, a
 * two-pixel bill. Every 2x2 cell holds at most two colours (clear counting as
 * one). The quack opens the bill to the full height of the head.
 */
export const DUCK_12x4: Record<Frame, readonly string[]> = {
  idle: ['......YYYY..', 'Y.....YYYYOO', 'YYYYYYYYYY..', '..YYYYYYY...'],
  shut: ['......YYYY..', 'Y.....YYKYOO', 'YYYYYYYYYY..', '..YYYYYYY...'],
  alert: ['......YYYYOO', 'Y.....YYKYOO', 'YYYYYYYYYY..', '..YYYYYYY...'],
}

/** The idle duck's shut eye: a `-`, eye-dark over yellow, in the eye's cell, where no quadrant can draw a line. */
export const IDLE_EYE: Readonly<Record<number, CellOverride>> = { 4: { glyph: '-', fg: 0x2b1d18, bg: 0xffd23f } }

/** 8x2: the one-row band's duck, 4 columns of quadrants; it never moves. */
export const DUCK_8x2: readonly string[] = ['Y...YY..', 'YYYYYYOO']

/** The quack, played once when a caution appears: the head comes up, the bill flaps twice, then it holds `shut`. */
export const QUACK_FRAMES: readonly Frame[] = ['idle', 'alert', 'shut', 'alert', 'shut']
export const QUACK_FRAME_MS = 140

/** A sprite as 0xRRGGBB pixels (undefined clear), for the cell encoders. */
export function spritePixels(rows: readonly string[]): (number | undefined)[][] {
  return rows.map(row => [...row].map(ch => DUCK_RGB[ch]))
}
