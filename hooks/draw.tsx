// Claude Code adapter, drawing half: turns quackpit's host-neutral faces and
// sections (src/) into elements of the surface's own table. Never touches
// `$`: register.tsx resolves the table and hands in the press handlers.
//
//   terminal, text    block-character gauges in theme colours + a Raster duck
//   terminal, pixels  Image (kitty graphics: kitty, Ghostty) + Text
//   desktop and the other remote surfaces: Svg + Text

import type { Elements, RenderElement, RenderNode } from 'claude-code'

import { dialCells, dialImage, dialPixels, dialSvg, type DialSpec } from '../src/dial'
import { blockDigits } from '../src/font'
import { duckCells, graphicImage, graphicLines, rampLines, type Graphic } from '../src/gauges'
import type { BandPlan } from '../src/layout'
import type { DetailId } from '../src/details'
import { INSTRUMENT_ROWS, type Instrument } from '../src/instruments'
import { GUTTER, partRows, type BodyPart, type Cell, type PaneModel, type Press } from '../src/panes'
import { bigPondCells, bigPondPixels, MIN_BIG_POND_COLUMNS, pixelsSvg, pondCells, pondPixels } from '../src/pond'
import { STEADY } from '../src/sprites'
import { barSvg, digitsSvg, duckSvg, graphicSvg } from '../src/svg'
import type { Face, Pond, TileId } from '../src/tiles'
import type { Summary, TopSection } from '../src/top'
import type { ViewBar, ViewId } from '../src/views'
import { endNarrow, plain, type Line, type Span, type Tone } from '../src/text'

type Remote = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Svg' | 'Markdown'>

export type Kit =
  /** `pixels`: the terminal shows pictures; `textOnly`: the person asked for designed text (graphics: text). */
  | { surface: 'terminal'; T: Elements['terminal']; pixels: boolean; textOnly?: boolean }
  | { surface: 'desktop' | 'vscode' | 'mobile'; T: Remote }

export type BandHandlers = {
  openPane: () => void
  /** A tile pressed: the pane opens with that tile's detail (the hero's: the timeline tab). */
  openTile: (id: TileId) => void
  acknowledge: () => void
}

/** Tones as the person's theme paints them, so light and dark themes both read. */
const COLOR: Partial<Record<Tone, string>> = { ok: 'success', warn: 'warning', bad: 'error', track: 'subtle', grey: 'inactive' }

function spanProps(span: Span): Record<string, unknown> {
  // A fixed colour is a key, the context bar's sources: it wins over a tone.
  const color = span.color ?? (span.tone ? COLOR[span.tone] : undefined)
  const bg = span.bgColor ?? (span.bg ? COLOR[span.bg] : undefined)
  return {
    ...(color ? { color } : {}),
    ...(bg ? { backgroundColor: bg } : {}),
    ...(span.tone === 'muted' ? { dimColor: true } : {}),
    ...(span.bold || span.tone === 'accent' ? { bold: true } : {}),
  }
}

/** A line of styled spans as one Text; tones become theme colours. */
export function lineText(kit: Kit, line: Line, wrap: 'truncate-end' | 'wrap' = 'truncate-end'): RenderElement {
  const { Text } = kit.T
  return <Text wrap={wrap}>{line.map(span => <Text {...spanProps(span)}>{span.text}</Text>)}</Text>
}

/** The same spans as Text children, for a Button (which holds strings and Text only). */
function buttonChildren(kit: Kit, line: Line): RenderElement[] {
  const { Text } = kit.T
  return line.map(span => <Text {...spanProps(span)}>{span.text}</Text>)
}

function altOf(g: Graphic): string {
  if (g.kind === 'duck') return g.pose === 'alert' ? 'duck: head up' : 'duck'
  if (g.kind === 'ring') return `${Math.round(g.pct ?? 0)}%`
  return g.isGrey || g.needle === undefined ? 'pace: warming up' : `pace ${Math.round(g.needle * 200)}% of usual`
}

/** Pixels a remote surface gives a cell, for sizing Svg beside text. */
const CELL_W = 8
const CELL_H = 18

export function graphicElement(kit: Kit, g: Graphic, key: string): RenderElement {
  if (kit.surface === 'terminal') {
    const { Box, Image, Raster } = kit.T
    if (kit.pixels) return <Image key={key} source={graphicImage(g)} columns={g.cols} rows={g.rows} alt={altOf(g)} />
    const lines = graphicLines(g)
    if (lines) {
      return (
        <Box flexDirection="column" width={g.cols} flexShrink={0}>
          {lines.map(line => lineText(kit, line))}
        </Box>
      )
    }
    const cells = duckCells(g.kind === 'duck' ? STEADY[g.pose] : 'idle', g.rows === 1 ? 1 : 2)
    return <Raster key={key} columns={cells.columns} rows={cells.rows} cells={cells.cells} />
  }
  const { Svg } = kit.T
  return <Svg source={graphicSvg(g)} alt={altOf(g)} width={g.cols * CELL_W} height={g.rows * CELL_H} />
}

export function digitsElement(kit: Kit, digits: { text: string; tone?: Tone }): RenderElement {
  if (kit.surface !== 'terminal') {
    const { Svg } = kit.T
    const level = digits.tone === 'ok' ? 'ok' : digits.tone === 'warn' ? 'warn' : digits.tone === 'bad' ? 'bad' : 'none'
    return <Svg source={digitsSvg(digits.text, 2 * CELL_H, level)} alt={digits.text} height={2 * CELL_H} />
  }
  const { Box } = kit.T
  const [top, bottom] = blockDigits(digits.text)
  const line = (text: string): Line => [{ text, ...(digits.tone ? { tone: digits.tone } : {}), bold: true }]
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lineText(kit, line(top))}
      {lineText(kit, line(bottom))}
    </Box>
  )
}

/** The swimming duck's pond: Raster cells in a terminal, the same pixels as an SVG elsewhere. */
function pondElement(kit: Kit, columns: number, fraction: number, key: string, big?: { from: number }): RenderElement {
  const rows = big ? 2 : 1
  if (kit.surface === 'terminal') {
    const { Raster } = kit.T
    const cells = big ? bigPondCells(columns, fraction, big.from) : pondCells(columns, fraction)
    return <Raster key={key} columns={cells.columns} rows={cells.rows} cells={cells.cells} />
  }
  const { Svg } = kit.T
  const pixels = big ? bigPondPixels(columns, fraction, big.from) : pondPixels(columns, fraction)
  return <Svg key={key} source={pixelsSvg(pixels, columns * CELL_W, rows * CELL_H)} alt={`duck ${Math.round(fraction * 100)}% across`} width={columns * CELL_W} height={rows * CELL_H} />
}

/** A face's second line as the pond and the words after it. */
function pondLine(kit: Kit, pond: Pond, key: string): RenderElement {
  const { Box } = kit.T
  return (
    <Box flexDirection="row" flexShrink={0}>
      {pondElement(kit, pond.columns, pond.fraction, key)}
      {pond.tail.length > 0 ? lineText(kit, pond.tail) : null}
    </Box>
  )
}

function gutter(kit: Kit, rows: number): RenderElement {
  const { Box, Text } = kit.T
  return (
    <Box flexDirection="column" width={1} flexShrink={0}>
      {Array.from({ length: rows }, () => (
        <Text dimColor>│</Text>
      ))}
    </Box>
  )
}

function faceElement(kit: Kit, f: Face, act: BandHandlers): RenderElement {
  const { Box, Text, Button } = kit.T
  const key = f.id === 'duck' ? 'duck' : `tile-${f.id}`
  const hasText = f.lines[0].length > 0 || f.lines[1].length > 0
  let head: RenderElement | null = null
  if (f.id === 'duck') {
    head = hasText ? (
      <Button key="duck-ack" plain onPress={() => act.acknowledge()}>
        {buttonChildren(kit, f.lines[0])}
      </Button>
    ) : null
  } else if (f.lines[0].length > 0) {
    const id = f.id
    head = (
      <Button key={key} plain onPress={() => (id === 'more' ? act.openPane() : act.openTile(id))}>
        {buttonChildren(kit, f.lines[0])}
      </Button>
    )
  }
  return (
    <Box flexDirection="row" width={f.width} flexShrink={0} gap={1}>
      {f.graphic ? graphicElement(kit, f.graphic, `${f.id}-g`) : null}
      {f.digits ? digitsElement(kit, f.digits) : null}
      {hasText ? (
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {head ?? <Text> </Text>}
          {f.pond ? pondLine(kit, f.pond, `${f.id}-pond`) : f.lines[1].length > 0 ? lineText(kit, f.lines[1]) : <Text> </Text>}
        </Box>
      ) : null}
    </Box>
  )
}

export type BandOptions = {
  /** Draw the 1x1 probe Image that tells whether this terminal shows pictures. */
  withProbe: boolean
  probeSource?: { rgba: string; width: number; height: number }
  /** Columns left over on the first line, for the overflow mark. */
  width: number
}

/**
 * Whether a tree draws nothing: the engine's own band (`{ type: 'engine' }`,
 * what `next(e)` answers where no hook beneath drew one and no survey holds
 * it), or boxes and texts with nothing in them. A box with a border or a
 * height of its own takes rows, so it draws.
 */
export function drawsNothing(node: RenderNode | null | undefined): boolean {
  if (node === null || node === undefined) return true
  if (typeof node === 'string') return node === ''
  if (node.type === 'engine') return true
  if (node.type !== 'Box' && node.type !== 'Text') return false
  const props = node.props ?? {}
  if (node.type === 'Box' && (props.borderStyle !== undefined || props.height !== undefined || props.minHeight !== undefined)) return false
  return (node.children ?? []).every(drawsNothing)
}

/** Whether a plan has anything to draw: a tile, the duck, or the dense row. */
export function planDraws(plan: BandPlan): boolean {
  if (plan.kind === 'dense') return plan.withDuck || plan.line.some(span => span.text.trim() !== '')
  return plan.lines.some(line => line.length > 0) || plan.strip !== undefined
}

export function drawBand(kit: Kit, plan: BandPlan, act: BandHandlers, o: BandOptions): RenderElement {
  const { Box, Text, Button } = kit.T
  const extras: RenderElement[] = []
  if (kit.surface === 'terminal' && o.withProbe && o.probeSource) {
    const { Image } = kit.T
    extras.push(<Image key="qp-probe" source={o.probeSource} columns={1} rows={1} alt=" " />)
  }
  if (plan.kind === 'dense') {
    let duck: RenderElement | null = null
    if (plan.withDuck) {
      if (kit.surface === 'terminal') {
        const { Raster } = kit.T
        const cells = duckCells('idle', 1)
        duck = <Raster key="duck-mini" columns={cells.columns} rows={cells.rows} cells={cells.cells} />
      } else {
        const { Svg } = kit.T
        duck = <Svg source={duckSvg('idle', 18)} alt="duck" width={18} height={18} />
      }
    }
    return (
      <Box flexDirection="row" gap={1}>
        {duck}
        <Button key="band-dense" plain onPress={() => act.openPane()}>
          {buttonChildren(kit, plan.line)}
        </Button>
        {extras}
      </Box>
    )
  }
  const rows: RenderElement[] = plan.lines.map((faces, i) => {
    const children: RenderElement[] = []
    faces.forEach((f, j) => {
      if (j > 0) children.push(gutter(kit, 2))
      children.push(faceElement(kit, f, act))
    })
    if (i === 0) children.push(...extras)
    if (i === plan.lines.length - 1 && plan.overflow.length > 0 && !plan.strip) {
      children.push(
        gutter(kit, 2),
        <Button key="band-more" plain dimColor onPress={() => act.openPane()}>
          {`+${plan.overflow.length}`}
        </Button>,
      )
    }
    return (
      <Box flexDirection="row" gap={0}>
        {children}
      </Box>
    )
  })
  return (
    <Box flexDirection="column">
      {rows}
      {plan.strip ? lineText(kit, plan.strip) : null}
    </Box>
  )
}

// ------------------------------------------------------------------- pane

/**
 * A dial in the surface's own medium: quadrant cells in a terminal's Raster,
 * a picture where the terminal shows them, SVG elsewhere, and the band's
 * tachometer in text where the person chose designed text.
 */
function dialElement(kit: Kit, key: string, spec: DialSpec, columns: number, rows: number, alt: string): RenderElement {
  if (kit.surface === 'terminal') {
    const { Box, Image, Raster } = kit.T
    if (kit.pixels) return <Image key={key} source={dialImage(spec, columns, rows)} columns={columns} rows={rows} alt={alt} />
    if (kit.textOnly) {
      const ramp = rampLines({ kind: 'dial', cols: columns, rows, isGrey: spec.isGrey, warnFrom: spec.warnFrom, badFrom: spec.badFrom, ...(spec.needle !== undefined ? { needle: spec.needle } : {}), ...(spec.sweep !== undefined ? { sweep: spec.sweep } : {}), ...(spec.bug !== undefined ? { bug: spec.bug } : {}), ...(spec.needleLevel ? { needleLevel: spec.needleLevel } : {}), ...(spec.noZones ? { noZones: true } : {}) })
      return (
        <Box flexDirection="column" width={columns} flexShrink={0}>
          {ramp.map(line => lineText(kit, line))}
        </Box>
      )
    }
    const cells = dialCells(dialPixels(spec, columns, rows))
    return <Raster key={key} columns={cells.columns} rows={cells.rows} cells={cells.cells} />
  }
  const { Svg } = kit.T
  return <Svg key={key} source={dialSvg(spec, columns * CELL_W, rows * CELL_H)} alt={alt} width={columns * CELL_W} height={rows * CELL_H} />
}

/**
 * A press that opens its instrument's detail: `▸ CONTEXT`, and while open
 * `▾ CONTEXT` in full strength, the mark in the accent colour. One press, a
 * Button of text alone (a picture cannot be one).
 */
function titleButton(kit: Kit, key: string, title: Line, isOpen: boolean, onPress: () => void): RenderElement {
  const { Button, Text } = kit.T
  const mark: Span = isOpen ? { text: '▾ ', tone: 'accent' } : { text: '▸ ', tone: 'muted' }
  const words: Line = title.map((span, i) => (i === 0 ? { ...span, bold: true, ...(isOpen ? { tone: 'accent' as const } : { tone: 'muted' as const }) } : span))
  // The focus ring ends on a narrow character, so Warp lights a title in a wide script whole.
  const spans = [mark, ...words].map((span, i, all) => (i === all.length - 1 ? { ...span, text: endNarrow(span.text) } : span))
  return (
    <Button key={key} plain onPress={() => onPress()}>
      {spans.map(span => (
        <Text {...spanProps(span)}>{span.text}</Text>
      ))}
    </Button>
  )
}

/** A box of exactly `rows` rows: what the pinned window counts on. */
function rowsBox(kit: Kit, rows: number, children: RenderElement | (RenderElement | null)[], props: Record<string, unknown> = {}): RenderElement {
  const { Box } = kit.T
  return (
    <Box flexDirection="column" height={rows} flexShrink={0} overflow="hidden" {...props}>
      {children}
    </Box>
  )
}

const blank = (kit: Kit): RenderElement => {
  const { Text } = kit.T
  return <Text> </Text>
}

/**
 * A row of words, or the bar it draws: in a terminal the bar is its text (an
 * eighth block a boundary, in the sources' own colours, in any terminal,
 * pictures or not); elsewhere an SVG of the same parts.
 */
function wordsRow(kit: Kit, cell: Instrument, line: Line, i: number, width: number): RenderElement {
  if (cell.bar && cell.bar.row === i && kit.surface !== 'terminal') {
    const { Svg } = kit.T
    return <Svg key={`bar-${cell.id}`} source={barSvg(cell.bar.parts, width * CELL_W, CELL_H)} alt={plain(cell.words[2] ?? []) || 'context'} width={width * CELL_W} height={CELL_H} />
  }
  return line.length > 0 ? lineText(kit, line) : blank(kit)
}

/** An instrument: its title (its press), then its graphic with its words beside, or its words alone. */
function instrumentElement(kit: Kit, cell: Instrument, width: number, rows: number, act: PaneHandlers): RenderElement {
  const { Box } = kit.T
  const g = cell.graphic
  const alt = plain(cell.words[0] ?? [])
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {titleButton(kit, `cell-${cell.detail}`, cell.title, false, () => act.drill(cell.detail))}
      <Box flexDirection="row" gap={1} height={rows}>
        {g ? (
          <Box flexDirection="column" width={g.columns} flexShrink={0}>
            {g.kind === 'dial' ? dialElement(kit, `dial-${cell.id}`, g.spec, g.columns, g.rows, alt) : g.lines.map(line => lineText(kit, line))}
          </Box>
        ) : null}
        <Box flexDirection="column" flexShrink={1}>
          {cell.words.map((line, i) => wordsRow(kit, cell, line, i, width))}
        </Box>
      </Box>
    </Box>
  )
}

/** The gutter between two cells: a space, a thin rule, a space, `rows` tall. */
function gutterColumn(kit: Kit, rows: number): RenderElement {
  const { Box, Text } = kit.T
  return (
    <Box flexDirection="column" width={GUTTER} flexShrink={0}>
      {Array.from({ length: rows }, () => (
        <Text dimColor> │ </Text>
      ))}
    </Box>
  )
}

/** The rule between two rows of cells, crossing the gutter; where the row below has one cell, it closes on it. */
function rowRule(kit: Kit, width: number, cellWidth: number, across: 1 | 2, below: number): RenderElement {
  const { Text } = kit.T
  if (across === 1) return <Text dimColor>{'─'.repeat(width)}</Text>
  const left = '─'.repeat(cellWidth + 1)
  const right = '─'.repeat(Math.max(0, width - cellWidth - 2))
  return <Text dimColor>{`${left}${below > 1 ? '┼' : '┴'}${right}`}</Text>
}

/** The instruments, `across` to a row, a thin rule between cells and between rows, no boxes. */
function instrumentsElement(kit: Kit, part: Extract<BodyPart, { kind: 'instruments' }>, width: number, act: PaneHandlers): RenderElement {
  const { Box } = kit.T
  const rows = INSTRUMENT_ROWS[part.size]
  const children: RenderElement[] = []
  part.rows.forEach((row, i) => {
    if (i > 0) children.push(rowRule(kit, width, part.cellWidth, part.across, row.length))
    const cells: RenderElement[] = []
    row.forEach((cell, j) => {
      if (j > 0) cells.push(gutterColumn(kit, rows + 1))
      cells.push(instrumentElement(kit, cell, part.across === 1 ? width : j === 0 ? part.cellWidth : width - part.cellWidth - GUTTER, rows, act))
    })
    children.push(rowsBox(kit, rows + 1, <Box flexDirection="row">{cells}</Box>))
  })
  return <Box flexDirection="column">{children}</Box>
}

/** A compact cell: its title (its press), its gauge beside two lines. */
function cellElement(kit: Kit, cell: Cell, width: number, act: PaneHandlers): RenderElement {
  const { Box } = kit.T
  const detail = cell.id === 'five' ? 'limits' : cell.id
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {titleButton(kit, `cell-${detail}`, [{ text: cell.title }], false, () => act.drill(detail))}
      <Box flexDirection="row" gap={1}>
        {cell.graphic ? graphicElement(kit, cell.graphic, `cell-${cell.id}-g`) : null}
        <Box flexDirection="column" flexShrink={1}>
          {lineText(kit, cell.lines[0])}
          {lineText(kit, cell.lines[1])}
        </Box>
      </Box>
    </Box>
  )
}

function cellsElement(kit: Kit, part: Extract<BodyPart, { kind: 'cells' }>, width: number, act: PaneHandlers): RenderElement {
  const { Box } = kit.T
  const children: RenderElement[] = []
  part.rows.forEach((row, i) => {
    if (i > 0) children.push(rowRule(kit, width, part.cellWidth, part.across, row.length))
    const cells: RenderElement[] = []
    row.forEach((cell, j) => {
      if (j > 0) cells.push(gutterColumn(kit, 3))
      cells.push(cellElement(kit, cell, part.across === 1 ? width : j === 0 ? part.cellWidth : width - part.cellWidth - GUTTER, act))
    })
    children.push(rowsBox(kit, 3, <Box flexDirection="row">{cells}</Box>))
  })
  return <Box flexDirection="column">{children}</Box>
}

/** The instruments a line each: the name (its press) in a column, the reading after it. */
function readingsElement(kit: Kit, part: Extract<BodyPart, { kind: 'readings' }>, width: number, act: PaneHandlers): RenderElement {
  const { Box } = kit.T
  const rows: RenderElement[] = []
  for (let i = 0; i < part.items.length; i += part.across) {
    const items = part.items.slice(i, i + part.across)
    const cells: RenderElement[] = []
    items.forEach((item, j) => {
      if (j > 0) cells.push(<Box width={GUTTER} flexShrink={0}>{lineText(kit, [{ text: ' │ ', tone: 'muted' }])}</Box>)
      const w = j === 0 && part.across === 2 ? part.cellWidth : part.across === 2 ? width - part.cellWidth - GUTTER : width
      const isOpen = part.open === item.detail
      cells.push(
        <Box flexDirection="row" width={w} flexShrink={0}>
          <Box width={part.nameWidth + 2} flexShrink={0}>
            {titleButton(kit, `cell-${item.detail}`, [{ text: item.name }], isOpen, () => act.drill(item.detail))}
          </Box>
          <Box flexShrink={1}>{lineText(kit, item.reading)}</Box>
        </Box>,
      )
    })
    rows.push(rowsBox(kit, 1, <Box flexDirection="row">{cells}</Box>))
  }
  return <Box flexDirection="column">{rows}</Box>
}

/** The progress in one line: its head, the band's one-row pond, the rest. */
function summaryElement(kit: Kit, s: Summary): RenderElement {
  const { Box } = kit.T
  return (
    <Box flexDirection="row" height={1}>
      {s.head.length > 0 ? lineText(kit, s.head) : null}
      {s.pond ? pondElement(kit, s.pond.columns, s.pond.fraction, 'summary-pond') : null}
      {s.tail.length > 0 ? <Box flexShrink={1}>{lineText(kit, s.tail)}</Box> : null}
    </Box>
  )
}

/** The press that leaves a detail, `b: ‹ back`, its key a letter; the detail's name and headline after it. */
function backElement(kit: Kit, part: Extract<BodyPart, { kind: 'back' }>, act: PaneHandlers): RenderElement {
  const { Box, Button } = kit.T
  return (
    <Box flexDirection="row" gap={2} height={1}>
      <Button key="pane-back" plain dimColor hotkey="b" onPress={() => act.back()}>
        {`‹ ${part.label} `}
      </Button>
      {part.name !== '' ? <Box flexShrink={1}>{lineText(kit, [{ text: '▾ ', tone: 'accent' }, { text: part.name, bold: true, tone: 'accent' }, { text: '  ' }, ...part.title])}</Box> : null}
    </Box>
  )
}

function pressElement(kit: Kit, press: Press, act: PaneHandlers): RenderElement {
  const { Button, Text } = kit.T
  switch (press.kind) {
    case 'remove': {
      const tile = press.tile as TileId
      const [n, ...rest] = press.label.split('.')
      return (
        <Button key={press.key} plain onPress={() => act.removeTile(tile)}>
          <Text dimColor>{`${n}.`}</Text>
          {rest.join('.').replace(/ ×$/, '')}
          <Text dimColor> ×</Text>
        </Button>
      )
    }
    case 'add': {
      const tile = press.tile as TileId
      return (
        <Button key={press.key} plain dimColor onPress={() => act.addTile(tile)}>
          {press.label}
        </Button>
      )
    }
    case 'reset':
      return <Button key={press.key} label={press.label} onPress={() => act.resetLayout()} />
    case 'write':
      return <Button key={press.key} variant="primary" label={press.label} onPress={() => act.writeHandover()} />
    case 'copy':
      return <Button key={press.key} label={press.label} onPress={e => act.copyHandover(e.surface)} />
  }
}

/** One part of a body as elements, exactly its rows tall. */
function partElement(kit: Kit, part: BodyPart, width: number, act: PaneHandlers): RenderElement {
  const { Box, Button } = kit.T
  switch (part.kind) {
    case 'top':
      return rowsBox(kit, partRows(part), topElement(kit, part.top))
    case 'summary':
      return summaryElement(kit, part.summary)
    case 'blank':
      return blank(kit)
    case 'instruments':
      return instrumentsElement(kit, part, width, act)
    case 'cells':
      return cellsElement(kit, part, width, act)
    case 'readings':
      return readingsElement(kit, part, width, act)
    case 'cautions':
      return (
        <Box height={1}>
          <Button key="pane-ack" plain onPress={() => act.acknowledge()}>
            {buttonChildren(kit, part.line)}
          </Button>
        </Box>
      )
    case 'lines':
      return <Box flexDirection="column" flexShrink={0}>{part.lines.map(line => (line.length > 0 ? lineText(kit, line) : blank(kit)))}</Box>
    case 'back':
      return backElement(kit, part, act)
    case 'beside': {
      const rows = partRows(part)
      const rightW = width - part.leftWidth - GUTTER
      return rowsBox(
        kit,
        rows,
        <Box flexDirection="row">
          <Box flexDirection="column" width={part.leftWidth} flexShrink={0}>
            {part.left.map(p => partElement(kit, p, part.leftWidth, act))}
          </Box>
          {gutterColumn(kit, rows)}
          <Box flexDirection="column" width={rightW} flexShrink={0}>
            {part.right.map(p => partElement(kit, p, rightW, act))}
          </Box>
        </Box>,
      )
    }
    case 'turns':
      return (
        <Box flexDirection="column" flexShrink={0}>
          {part.rows.map(row => {
            const target = row.target
            return target ? (
              <Button key={`pane-turn-${row.n}`} plain onPress={() => act.scrollTo(target)}>
                {buttonChildren(kit, row.line)}
              </Button>
            ) : (
              lineText(kit, row.line)
            )
          })}
        </Box>
      )
    case 'presses':
      return (
        <Box flexDirection="column" flexShrink={0}>
          {part.rows.map(row => (
            <Box flexDirection="row" columnGap={1} height={1}>
              {row.map(press => pressElement(kit, press, act))}
            </Box>
          ))}
        </Box>
      )
  }
}

/**
 * The top section: its head line; while work runs, the list's big digits,
 * the duck's pond across the pane and the time left beside it; then what the
 * estimate rests on.
 */
export function topElement(kit: Kit, top: TopSection): RenderElement {
  const { Box, Text } = kit.T
  const pond = top.pond
  return (
    <Box flexDirection="column">
      {top.head.length > 0 ? lineText(kit, top.head) : null}
      {pond ? (
        <Box flexDirection="row" gap={1} height={2}>
          {pond.digits ? digitsElement(kit, pond.digits) : null}
          {pond.columns >= MIN_BIG_POND_COLUMNS ? pondElement(kit, pond.columns, pond.fraction, 'top-pond', { from: 0 }) : null}
          {pond.words[0].length > 0 || pond.words[1].length > 0 ? (
            <Box flexDirection="column" flexShrink={1}>
              {pond.words.map(line => (line.length > 0 ? lineText(kit, line) : <Text> </Text>))}
            </Box>
          ) : null}
        </Box>
      ) : null}
      {top.under.map(line => lineText(kit, line))}
    </Box>
  )
}

/**
 * The view bar: a press a view, its digit its key once the pane has the
 * keyboard, the open one bold and where the focus ring starts.
 */
function viewBarElement(kit: Kit, bar: ViewBar, open: ViewId, act: PaneHandlers): RenderElement {
  const { Box, Button, Text } = kit.T
  return (
    <Box flexDirection="row" gap={bar.gap} height={1}>
      {bar.tabs.map(tab =>
        tab.id === open ? (
          <Button key={`pane-view-${tab.id}`} plain hotkey={tab.hotkey} autoFocus onPress={() => act.selectView(tab.id)}>
            <Text bold>{tab.label}</Text>
          </Button>
        ) : (
          <Button key={`pane-view-${tab.id}`} plain dimColor hotkey={tab.hotkey} onPress={() => act.selectView(tab.id)}>
            {tab.label}
          </Button>
        ),
      )}
    </Box>
  )
}

export type PaneHandlers = {
  writeHandover: () => void
  copyHandover: (surface: string) => void
  removeTile: (id: TileId) => void
  addTile: (id: TileId) => void
  /** Puts the band back as the settings have it (by default the six tiles, 2 rows, the duck on). */
  resetLayout: () => void
  /** Brings a turn's first tool row into view in the transcript. */
  scrollTo: (target: string) => void
  /** Brings a view to the front. */
  selectView: (view: ViewId) => void
  /** Drills into an instrument's detail, or switches to another's. */
  drill: (id: DetailId) => void
  /** Leaves the detail for the instruments. */
  back: () => void
  /** Acknowledges the cautions, as the duck's press in the band does. */
  acknowledge: () => void
}

/** Where the body's window stands in the terminal: its rows, its offset, and whether the tree runs a row past the pane, so the arrows scroll it. */
export type PanePin = { rows: number; top: number; extra: boolean }

/**
 * The pane: its header (the view bar, its rule, the summary), its body and
 * the hint at its foot. With `pin` (the terminal), the body scrolls in a
 * window of its own between the header and the foot, which stay in view;
 * elsewhere the engine scrolls the whole.
 */
export function drawPane(kit: Kit, m: PaneModel, act: PaneHandlers, pin?: PanePin): RenderElement {
  const { Box, Text } = kit.T
  const head = (
    <Box flexDirection="column" flexShrink={0}>
      {viewBarElement(kit, m.bar, m.view.view, act)}
      {m.rule ? lineText(kit, m.bar.rule) : null}
      {m.summary ? summaryElement(kit, m.summary) : null}
    </Box>
  )
  const body = m.body.map(part => partElement(kit, part, m.width, act))
  const foot = <Box height={1}>{lineText(kit, m.hint)}</Box>
  if (!pin) {
    return (
      <Box flexDirection="column">
        {head}
        {body}
        {foot}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {head}
      <Box key="pane-window" flexDirection="column" height={pin.rows} overflow="hidden" flexShrink={0}>
        <Box flexDirection="column" flexShrink={0} marginTop={-pin.top}>
          {body}
        </Box>
      </Box>
      {foot}
      {pin.extra ? <Text> </Text> : null}
    </Box>
  )
}
