// The pane's pinned header, in the terminal: the view bar (and the summary)
// on top and the hint at the bottom stay where they are, and the body between
// them scrolls in a window of its own, a box that clips it moved by
// quackpit's own hooks. Claude Code 2.1.296 draws such a box (a fixed height
// with its overflow hidden, around a box moved up by a negative margin), and
// raises `ui.scroll` and `ui.focus` for it as follows, as a live probe showed:
//
//   - a tree that fits the pane's rows is never scrolled by the engine: page
//     keys still raise `ui.scroll`, by the pane's rows either way (End and
//     PageDown cannot be told apart), and the arrows move the focus;
//   - a tree one row taller than the rows makes the arrows raise `ui.scroll`
//     by one row; answered without passing it on, the engine's own window
//     stays put, the extra row out of sight;
//   - the wheel raises `ui.scroll` with the pointer's cell;
//   - Tab onto a press the box clips raises `ui.focus` with its key.
//
// So a body that overflows its window is drawn with one row more than the
// pane has, and each move goes to the body's own offset. Pure.

/** Where the body's window stands: its first row, as an offset into the body. */
export type PinState = { top: number }

/** The window's rows: the pane's rows less the header's and the footer's, one at least. */
export function windowRows(paneRows: number, headRows: number, footRows: number): number {
  return Math.max(1, paneRows - headRows - footRows)
}

/** The furthest the window can move: the body's rows past the window's. */
export function maxTop(bodyRows: number, rows: number): number {
  return Math.max(0, bodyRows - rows)
}

export function clampTop(top: number, bodyRows: number, rows: number): number {
  return Math.max(0, Math.min(maxTop(bodyRows, rows), Math.round(top)))
}

/**
 * The window after a move the engine raised: a page key's (`by` the pane's
 * own rows) moves a window's height less a row, so a line of the last page
 * stays in view; an arrow's or the wheel's moves its own rows.
 */
export function scrolled(top: number, by: number, paneRows: number, bodyRows: number, rows: number): number {
  const isPage = Math.abs(by) >= paneRows
  const step = isPage ? Math.sign(by) * Math.max(1, rows - 1) : by
  return clampTop(top + step, bodyRows, rows)
}

/**
 * The window after the focus moved onto a press at body row `at`, `height`
 * rows tall: moved the least that shows it whole, or not at all when it
 * already shows.
 */
export function followed(top: number, at: number, height: number, bodyRows: number, rows: number): number {
  if (at < top) return clampTop(at, bodyRows, rows)
  if (at + height > top + rows) return clampTop(at + height - rows, bodyRows, rows)
  return top
}

/** Whether the body overflows its window: then it is drawn a row taller than the pane, so the arrows scroll it. */
export function overflows(bodyRows: number, rows: number): boolean {
  return bodyRows > rows
}
