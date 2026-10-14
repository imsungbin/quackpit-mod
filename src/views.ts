// The pane's views, a view at a time under a header that stays in view: the
// overview (progress and the instruments), the timeline, the turns, the
// band's layout, the handover and the guide. A bar of presses on top, each
// with its digit as its key; outside the overview a one-line summary of the
// progress under it; at the bottom one line naming the keys of the view in
// front. Host-neutral; the adapter draws them. Pure.

import type { DetailId } from './details'
import { t, type Key, type Locale } from './i18n'
import { displayWidth, endNarrow, fit, type Line, type Span } from './text'

export const VIEW_IDS = ['overview', 'timeline', 'turns', 'band', 'handover', 'guide'] as const
export type ViewId = (typeof VIEW_IDS)[number]

export function isViewId(x: unknown): x is ViewId {
  return typeof x === 'string' && (VIEW_IDS as readonly string[]).includes(x)
}

/** Which view is in front, and in the overview the instrument drilled into: what a redraw, a reload and /clear keep. */
export type PaneView = { view: ViewId; detail?: DetailId }

export const DEFAULT_VIEW: PaneView = { view: 'overview' }

const DETAIL_IDS: readonly DetailId[] = ['pace', 'limits', 'context', 'cost', 'checks', 'files', 'agents', 'session', 'health']

export function isDetailId(x: unknown): x is DetailId {
  return typeof x === 'string' && (DETAIL_IDS as readonly string[]).includes(x)
}

/**
 * A stored view read back. An older build kept `{ tab, detail }`: a tab and a detail
 * open under the grid, which no longer go together; it opens on the overview.
 * Anything else is none.
 */
export function asView(x: unknown): PaneView | undefined {
  if (typeof x !== 'object' || x === null) return undefined
  const v = x as { view?: unknown; detail?: unknown; tab?: unknown }
  if (!isViewId(v.view)) return v.tab !== undefined ? DEFAULT_VIEW : undefined
  // A detail is the overview's alone.
  return { view: v.view, ...(v.view === 'overview' && isDetailId(v.detail) ? { detail: v.detail } : {}) }
}

/** A view's press in the bar: its digit (its key once the pane has the keyboard), its label, its width as drawn (`1: label`). */
export type ViewTab = { id: ViewId; hotkey: string; label: string; width: number }

/** The bar, as wide as it is drawn: its tabs, the gap between them, and the rule under them. */
export type ViewBar = { tabs: ViewTab[]; gap: number; rule: Line }

/**
 * A space each press carries after its label where the label ends on a wide
 * character: the focus ring then ends on a narrow one. Warp leaves the second
 * half of a wide character that ends a highlighted run unlit (`1: 타임라인`
 * lit 10 of its 11 columns), though Claude Code sends the whole run.
 */
export function tabLabel(label: string): string {
  return endNarrow(label)
}

/** How wide the bar is drawn: each tab, the gaps between. */
export function barWidth(bar: Pick<ViewBar, 'tabs' | 'gap'>): number {
  return bar.tabs.reduce((sum, tab) => sum + tab.width, 0) + bar.gap * Math.max(0, bar.tabs.length - 1)
}

/**
 * The view bar `width` columns wide: each view its digit and its name, the
 * open one bold, and under them a rule, heavy under the open view. The names
 * are the full ones where they fit with a gap of two, then one; else the
 * short ones, which fit 56 columns in every language.
 */
export function viewBar(L: Locale, open: ViewId, width: number): ViewBar {
  const forms: { short: boolean; gap: number }[] = [
    { short: false, gap: 2 },
    { short: false, gap: 1 },
    { short: true, gap: 2 },
    { short: true, gap: 1 },
  ]
  const build = (short: boolean, gap: number): ViewBar => {
    const tabs = VIEW_IDS.map((id, i): ViewTab => {
      const label = tabLabel(t(L, short ? (`view.short.${id}` as Key) : (`view.${id}` as Key)))
      const hotkey = String(i + 1)
      return { id, hotkey, label, width: hotkey.length + 2 + displayWidth(label) }
    })
    return { tabs, gap, rule: [] }
  }
  const chosen = forms.map(f => build(f.short, f.gap)).find(bar => barWidth(bar) <= width) ?? build(true, 1)
  const at = chosen.tabs.findIndex(tab => tab.id === open)
  const from = chosen.tabs.slice(0, at).reduce((x, tab) => x + tab.width + chosen.gap, 0)
  const under = chosen.tabs[at]?.width ?? 0
  const w = Math.max(from + under, width)
  const rule: Line = [{ text: '─'.repeat(from), tone: 'muted' }, { text: '━'.repeat(under), tone: 'accent' }, { text: '─'.repeat(Math.max(0, w - from - under)), tone: 'muted' }]
  return { ...chosen, rule }
}

/** What the hint at the bottom names: the view in front, whether a detail is open, whether the pane has the keyboard. */
export type HintState = { view: ViewId; isDrilled: boolean; isFocused: boolean; canScroll: boolean }

/**
 * The line at the bottom: the keys of the view in front, its most useful
 * first, as many as fit. Until a click gives the pane the keyboard, it says
 * so first: no key reaches the pane before.
 */
export function hintLine(L: Locale, s: HintState, width: number): Line {
  const parts: Key[] = []
  if (!s.isFocused) parts.push('hint.click')
  if (s.isDrilled) parts.push('hint.back')
  if (s.view === 'overview' && !s.isDrilled) parts.push('hint.gauge')
  if (s.view === 'turns') parts.push('hint.turn')
  if (s.view === 'band') parts.push('hint.tile')
  if (s.view === 'handover') parts.push('hint.write')
  if (s.canScroll) parts.push('hint.scroll')
  parts.push('hint.views')
  if (s.isFocused) parts.push('hint.esc')
  const said = parts.map(key => t(L, key))
  const kept: string[] = []
  for (const text of said) {
    const next = [...kept, text].join(' · ')
    if (displayWidth(next) <= width) kept.push(text)
    else if (kept.length === 0) {
      kept.push(fit(text, width))
      break
    }
  }
  const span: Span = { text: kept.join(' · '), tone: 'muted' }
  return [span]
}
