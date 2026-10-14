// Settings and the band's layout. userConfig holds the defaults; the
// `/quackpit add|remove|move|rows|duck` commands write an override to the
// store that every session uses until the matching userConfig value itself
// changes (the override remembers which values it replaced). Pure: the
// adapter reads and writes the store.

import { resolveLocale, type Locale } from './i18n'
import { DEFAULT_TILES, isTileId, parseTiles, type TileId } from './tiles'

export type Graphics = 'auto' | 'pixels' | 'text'

export type Settings = {
  tiles: TileId[]
  /** userConfig's tiles as written, so an override knows what it replaced. */
  tilesText: string
  rows: number
  duck: boolean
  sound: boolean
  graphics: Graphics
  locale: Locale
  /** The opt-in AI ETA: off unless the person turned it on. */
  aiEta: boolean
}

export const MIN_ROWS = 1
export const MAX_ROWS = 4

export function clampRows(n: unknown, fallback = 2): number {
  const v = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN
  if (!Number.isFinite(v)) return fallback
  return Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round(v)))
}

/** userConfig as `register` receives it; anything missing or malformed gets its default. */
export function readSettings(options: Readonly<Record<string, unknown>>, systemLocale?: string): Settings {
  const tilesText = typeof options.tiles === 'string' ? options.tiles : DEFAULT_TILES.join(',')
  const parsed = parseTiles(tilesText)
  const graphics = options.graphics === 'pixels' || options.graphics === 'text' ? options.graphics : 'auto'
  return {
    tiles: parsed.length > 0 ? parsed : [...DEFAULT_TILES],
    tilesText,
    rows: clampRows(options.rows),
    duck: options.duck !== false,
    sound: options.sound === true,
    graphics,
    locale: resolveLocale(options.locale, systemLocale),
    aiEta: options.aiEta === true,
  }
}

/** The userConfig values an override was made against. */
export type Base = { tiles: string; rows: number; duck: boolean }

export type LayoutRecord = {
  v: 1
  tiles?: TileId[]
  rows?: number
  duck?: boolean
  base: Base
  /** Where the override came from: your commands, or claude-hud's config on first run. */
  source: 'command' | 'claude-hud'
}

export function baseOf(s: Settings): Base {
  return { tiles: s.tilesText, rows: s.rows, duck: s.duck }
}

export function asLayout(x: unknown): LayoutRecord | undefined {
  if (typeof x !== 'object' || x === null) return undefined
  const r = x as Record<string, unknown>
  const base = r.base as Record<string, unknown> | undefined
  if (r.v !== 1 || !base || typeof base.tiles !== 'string' || typeof base.rows !== 'number' || typeof base.duck !== 'boolean') return undefined
  const out: LayoutRecord = {
    v: 1,
    base: { tiles: base.tiles, rows: base.rows, duck: base.duck },
    source: r.source === 'claude-hud' ? 'claude-hud' : 'command',
  }
  if (Array.isArray(r.tiles)) out.tiles = r.tiles.filter(isTileId).filter((id, i, all) => all.indexOf(id) === i)
  if (typeof r.rows === 'number') out.rows = clampRows(r.rows)
  if (typeof r.duck === 'boolean') out.duck = r.duck
  return out
}

export type Layout = { tiles: TileId[]; rows: number; duck: boolean; source?: LayoutRecord['source'] }

/** Whether two layouts draw the same band: the same tiles in the same order, rows and duck. */
export function isSameLayout(a: Layout, b: Layout): boolean {
  return a.rows === b.rows && a.duck === b.duck && a.tiles.length === b.tiles.length && a.tiles.every((id, i) => b.tiles[i] === id)
}

/** Whether an override still stands: userConfig has not changed since it was made. */
export function isCurrent(record: LayoutRecord | undefined, s: Settings): record is LayoutRecord {
  if (!record) return false
  const b = baseOf(s)
  return record.base.tiles === b.tiles && record.base.rows === b.rows && record.base.duck === b.duck
}

export function effectiveLayout(s: Settings, record: LayoutRecord | undefined): Layout {
  if (!isCurrent(record, s)) return { tiles: [...s.tiles], rows: s.rows, duck: s.duck }
  return {
    tiles: record.tiles ?? [...s.tiles],
    rows: record.rows ?? s.rows,
    duck: record.duck ?? s.duck,
    source: record.source,
  }
}

function withChange(s: Settings, record: LayoutRecord | undefined, change: Partial<Pick<LayoutRecord, 'tiles' | 'rows' | 'duck'>>): LayoutRecord {
  const current = isCurrent(record, s) ? record : undefined
  return { v: 1, ...(current ?? {}), ...change, base: baseOf(s), source: 'command' }
}

export type Change = { record: LayoutRecord; outcome: 'done' } | { record: LayoutRecord | undefined; outcome: 'already' | 'missing' | 'unknown' | 'bad' }

export function addTile(s: Settings, record: LayoutRecord | undefined, name: string, at?: number): Change {
  const id = name.toLowerCase()
  if (!isTileId(id)) return { record, outcome: 'unknown' }
  const tiles = effectiveLayout(s, record).tiles
  if (tiles.includes(id)) return { record, outcome: 'already' }
  const next = [...tiles]
  next.splice(at === undefined ? next.length : Math.max(0, Math.min(next.length, at - 1)), 0, id)
  return { record: withChange(s, record, { tiles: next }), outcome: 'done' }
}

export function removeTile(s: Settings, record: LayoutRecord | undefined, name: string): Change {
  const id = name.toLowerCase()
  if (!isTileId(id)) return { record, outcome: 'unknown' }
  const tiles = effectiveLayout(s, record).tiles
  if (!tiles.includes(id)) return { record, outcome: 'missing' }
  return { record: withChange(s, record, { tiles: tiles.filter(t => t !== id) }), outcome: 'done' }
}

/** Moves a tile to position `n` (1 is leftmost); one not in the band is added there. */
export function moveTile(s: Settings, record: LayoutRecord | undefined, name: string, n: number | undefined): Change {
  const id = name.toLowerCase()
  if (!isTileId(id)) return { record, outcome: 'unknown' }
  if (n === undefined || !Number.isFinite(n) || n < 1) return { record, outcome: 'bad' }
  const tiles = effectiveLayout(s, record).tiles.filter(t => t !== id)
  tiles.splice(Math.min(tiles.length, Math.round(n) - 1), 0, id)
  return { record: withChange(s, record, { tiles }), outcome: 'done' }
}

export function setRows(s: Settings, record: LayoutRecord | undefined, n: number | undefined): Change {
  if (n === undefined || !Number.isInteger(n) || n < MIN_ROWS || n > MAX_ROWS) return { record, outcome: 'bad' }
  return { record: withChange(s, record, { rows: n }), outcome: 'done' }
}

export function setDuck(s: Settings, record: LayoutRecord | undefined, on: boolean): Change {
  return { record: withChange(s, record, { duck: on }), outcome: 'done' }
}

/** The record claude-hud's config maps to on first run. */
export function hudLayout(s: Settings, tiles: readonly TileId[]): LayoutRecord {
  return { v: 1, tiles: [...tiles], base: baseOf(s), source: 'claude-hud' }
}
