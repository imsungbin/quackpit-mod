// First run for claude-hud users: its config (read only, never written)
// says which lines they keep on, and each maps to a tile, so the band starts
// out familiar. Pure: the adapter reads the two files and hands their text in.
//
//   claude-hud                          quackpit
//   todos (display.showTodos)           progress (the hero, always first)
//   context (always on)                 context
//   usage (display.showUsage, on)       limits, pace
//   tools (display.showTools)           checks, files
//   agents (display.showAgents)         agents
//   git (gitStatus.enabled, on)         session
//   cost (display.showCost)             cost
//   duration (display.showDuration)     session

import type { TileId } from './tiles'

/** Where claude-hud keeps its config, relative to the Claude config directory. */
export const HUD_FILES = ['plugins/claude-hud/config.json', 'claude-hud.json'] as const

type Json = Record<string, unknown>

function obj(x: unknown): Json | undefined {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Json) : undefined
}

/** Parses a config file's text; undefined when it is no JSON object. */
export function parseHudConfig(text: string | undefined): Json | undefined {
  if (text === undefined) return undefined
  try {
    return obj(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** Layers the per-directory file over the shared one, as claude-hud does. */
export function layerHud(base: Json | undefined, over: Json | undefined): Json | undefined {
  if (!base && !over) return undefined
  const merge = (a: Json | undefined, b: Json | undefined): Json => {
    const out: Json = { ...(a ?? {}) }
    for (const [k, v] of Object.entries(b ?? {})) {
      const inner = obj(v)
      out[k] = inner && obj(out[k]) ? merge(obj(out[k]), inner) : v
    }
    return out
  }
  return merge(base, over)
}

export type HudLines = { todos: boolean; context: boolean; usage: boolean; tools: boolean; agents: boolean; git: boolean; cost: boolean; duration: boolean }

/** Which of claude-hud's lines are on, with claude-hud's own defaults. */
export function hudLines(config: Json): HudLines {
  const display = obj(config.display) ?? {}
  const git = obj(config.gitStatus) ?? {}
  return {
    todos: display.showTodos === true,
    context: true,
    usage: display.showUsage !== false,
    tools: display.showTools === true,
    agents: display.showAgents === true,
    git: git.enabled !== false,
    cost: display.showCost === true,
    duration: display.showDuration === true,
  }
}

/** The tiles claude-hud's lines map to, in quackpit's order. */
export function hudTiles(config: Json): TileId[] {
  const on = hudLines(config)
  const tiles: TileId[] = ['progress']
  if (on.usage) tiles.push('pace')
  if (on.context) tiles.push('context')
  if (on.usage) tiles.push('limits')
  if (on.tools) tiles.push('checks')
  if (on.cost) tiles.push('cost')
  if (on.agents) tiles.push('agents')
  if (on.tools) tiles.push('files')
  if (on.git || on.duration) tiles.push('session')
  return tiles
}
