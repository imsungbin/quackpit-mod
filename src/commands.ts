// `/quackpit <args>` (and its alias `/quack`), parsed. Pure.

import { isViewId, VIEW_IDS, type ViewId } from './views'
import { isTileId, type TileId } from './tiles'

export type Command =
  | { kind: 'pane' }
  /** A view of the pane, by name or number; none named, the list of them. */
  | { kind: 'view'; view?: ViewId }
  /** A tile's detail, opened in the pane (the hero's is the timeline). */
  | { kind: 'detail'; tile: TileId }
  | { kind: 'add'; tile: string; at?: number }
  | { kind: 'remove'; tile: string }
  | { kind: 'move'; tile: string; to?: number }
  | { kind: 'reset' }
  | { kind: 'rows'; n?: number }
  | { kind: 'handover' }
  | { kind: 'duck'; on?: boolean }
  | { kind: 'help' }
  | { kind: 'guide' }
  /** The AI ETA: turned on or off, or with neither, how it stands. */
  | { kind: 'ai'; on?: boolean }

const ON = new Set(['on', 'yes', 'true', '1', 'show'])
const OFF = new Set(['off', 'no', 'false', '0', 'hide'])

function toNumber(word: string | undefined): number | undefined {
  if (word === undefined) return undefined
  const n = Number(word)
  return Number.isFinite(n) ? n : undefined
}

export function parseCommand(args: string): Command {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const [head, a, b] = words.map(w => w.toLowerCase())
  switch (head) {
    case undefined:
    case 'pane':
    case 'open':
      return { kind: 'pane' }
    case 'add':
      if (!a) return { kind: 'help' }
      return toNumber(b) !== undefined ? { kind: 'add', tile: a, at: toNumber(b) as number } : { kind: 'add', tile: a }
    case 'remove':
    case 'rm':
    case 'hide':
      return a ? { kind: 'remove', tile: a } : { kind: 'help' }
    case 'move':
    case 'mv': {
      if (!a) return { kind: 'help' }
      const to = toNumber(b)
      return to !== undefined ? { kind: 'move', tile: a, to } : { kind: 'move', tile: a }
    }
    case 'reset':
      return { kind: 'reset' }
    case 'rows': {
      const n = toNumber(a)
      return n !== undefined ? { kind: 'rows', n } : { kind: 'rows' }
    }
    case 'handover':
    case 'handoff':
      return { kind: 'handover' }
    case 'duck':
      if (a && ON.has(a)) return { kind: 'duck', on: true }
      if (a && OFF.has(a)) return { kind: 'duck', on: false }
      return { kind: 'duck' }
    case 'help':
    case 'guide':
    case '?':
      return { kind: 'guide' }
    case 'view':
    case 'tab': {
      const view = a === undefined ? undefined : isViewId(a) ? a : VIEW_IDS[(toNumber(a) ?? 0) - 1]
      return view ? { kind: 'view', view } : { kind: 'view' }
    }
    // A view by its own name; `handover` writes one and `guide` is above.
    case 'overview':
    case 'timeline':
    case 'turns':
    case 'band':
      return { kind: 'view', view: head }
    case 'ai':
    case 'eta':
      if (a && ON.has(a)) return { kind: 'ai', on: true }
      if (a && OFF.has(a)) return { kind: 'ai', on: false }
      return { kind: 'ai' }
    default:
      // A tile's name opens its detail.
      return head !== undefined && isTileId(head) ? { kind: 'detail', tile: head } : { kind: 'help' }
  }
}
