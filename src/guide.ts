// The guide: what each part of the band means, the duck's causes, the pane's
// presses and tabs, and the commands, in the person's language. Opened by
// `/quackpit help` as the pane's guide tab, beside the real gauges it
// explains, in place of a demo of made-up numbers. Pure.

import { t, type Key, type Locale } from './i18n'

const ROWS: readonly [string, Key][] = [
  ['progress', 'guide.progress'],
  ['pace', 'guide.pace'],
  ['context', 'guide.context'],
  ['limits', 'guide.limits'],
  ['checks', 'guide.checks'],
  ['cost', 'guide.cost'],
  ['health', 'guide.health'],
  ['agents · files · session', 'guide.optional'],
  ['duck', 'guide.duck'],
  ['AI ETA', 'guide.ai'],
  ['pane', 'guide.pane'],
  ['/quackpit', 'guide.commands'],
]

/** A part's name and what it shows; the pane sets the names in a column and wraps the words beside them. */
export type GuideRow = { name: string; text: string }

export function guideRows(L: Locale): GuideRow[] {
  return ROWS.map(([name, key]) => ({ name, text: t(L, key) }))
}
