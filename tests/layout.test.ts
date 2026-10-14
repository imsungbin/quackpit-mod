import { describe, expect, test } from 'claude-code/testing'

import { planBand, planRows } from '../src/layout'
import { newCockpit, onPrompt } from '../src/model'
import { missionLines } from '../src/panes'
import { addTile, effectiveLayout, moveTile, readSettings, removeTile, setRows } from '../src/prefs'
import { displayWidth, lineWidth, plain, wrap, wrapLine } from '../src/text'
import { DEFAULT_TILES, parseTiles, readingsOf } from '../src/tiles'
import { at, band, command, EN, start, world } from './kit'

const T0 = at(2026, 10, 11, 10)

const VIEW = { now: T0, locale: 'en' as const, days: [], today: '2026-10-11' }

describe('layout', () => {
  test('wide characters take two columns: a Korean goal wraps without losing a word, emoji do not overflow', () => {
    expect(displayWidth('✅ done')).toBe(7)
    expect(displayWidth('🚀')).toBe(2)
    expect(displayWidth('⭐⚡❌')).toBe(6)
    // quackpit's own glyphs stay one column.
    expect(displayWidth('✓ ✗ ● ◔ ▰ ↻ ⟲')).toBe(13)
    const goal = '설정 화면에 다크 모드 토글을 추가하고 기존 테스트를 모두 통과시키기'
    const lines = wrap(goal, 20, 6)
    expect(lines.join(' ')).toBe(goal)
    expect(lines.every(line => displayWidth(line) <= 20)).toBe(true)
    // In the pane the mission wraps to a second line within the column, Hangul counted two columns a character; past that it is cut.
    const c = onPrompt(newCockpit(T0, 's'), { at: T0, text: goal, isPersonal: true })
    const mission = missionLines(readingsOf(c, VIEW), 24)
    expect(mission.map(plain)).toEqual(['MISSION  설정 화면에', '         다크 모드…'])
    for (const line of mission) expect(lineWidth(line)).toBeLessThanOrEqual(24)
  })

  test('Japanese and Chinese break between characters, a closing mark kept with what it closes; Korean and English at spaces', () => {
    // Found live: a Japanese paragraph broke only at its one space, leaving a short first line.
    const ja = '計測値ではなく判断です: 100から各項目の減点を引いた値。減点は、各項目の計測値を規則で割合に直し、重みを掛けたものです。'
    expect(wrap(ja, 30, 9)).toEqual(['計測値ではなく判断です: 100か', 'ら各項目の減点を引いた値。減点', 'は、各項目の計測値を規則で割合', 'に直し、重みを掛けたものです。'])
    const zh = '检查失败、5小时窗口达到 80%、上下文接近自动压缩，或某轮费用达到平时的 3× 时，它会醒来说“Quack:”。'
    const lines = wrap(zh, 30, 9)
    expect(lines.join('')).toBe(zh.replace(/ (?=上下文|“)/g, ''))
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(30)
      expect(line).not.toMatch(/^[、。，：；？！）」”]/)
    }
    // The wrapper of styled lines breaks the same way, and a word in Latin letters is never cut where it fits.
    expect(wrapLine([{ text: 'Claude Code 2.1.296はタスクツールをClaude 4モデルに提供します。' }], 30, 3).map(plain)).toEqual(['Claude Code 2.1.296はタスク', 'ツールをClaude 4モデルに提供し', 'ます。'])
    expect(wrap('아직 판단할 것 없음: 지켜본 지 10분 미만', 30, 3)).toEqual(['아직 판단할 것 없음: 지켜본 지', '10분 미만'])
    expect(wrap('nothing to judge yet: watched under 10 minutes', 30, 3)).toEqual(['nothing to judge yet: watched', 'under 10 minutes'])
  })

  test('the dense band never draws wider than the band; a very narrow one gives up the duck first', () => {
    const r = readingsOf(newCockpit(T0, 's'), VIEW)
    for (const width of [8, 12, 19, 20, 40, 79]) {
      const plan = planBand({ readings: r, tiles: DEFAULT_TILES, width, rows: 2, maxRows: 6, withDuck: true })
      if (plan.kind !== 'dense') throw new Error(`a ${width}-column band is the dense row`)
      expect(lineWidth(plan.line) + (plan.withDuck ? 5 : 0) <= width).toBe(true)
      expect(plan.withDuck).toBe(width >= 20)
    }
  })

  test('/quackpit add, remove and move change the band and are kept in the store', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await command($, 'add agents')
    expect(w.toasts.at(-1)).toBe('Added agents to the band.')
    await command($, 'remove cost')
    await command($, 'move checks 2')
    const record = w.store.get('layout') as { tiles: string[]; base: { tiles: string } }
    expect(record.tiles).toEqual(['progress', 'checks', 'pace', 'context', 'limits', 'agents'])
    expect(record.base.tiles).toBe(DEFAULT_TILES.join(','))
    // An unknown tile is refused with the list; one already there says so.
    await command($, 'add weather')
    expect(w.toasts.at(-1)).toStartWith('No tile called "weather".')
    await command($, 'add agents')
    expect(w.toasts.at(-1)).toBe('agents is already in the band.')
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Button', key: 'tile-agents' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tile-cost' })).toBeUndefined()
    await ui.unmount()
  })

  test('the layout survives a new session: the next session reads it back', EN, async ($, on) => {
    const kept = {
      layout: { v: 1, tiles: ['progress', 'files', 'context'], rows: 4, base: { tiles: DEFAULT_TILES.join(','), rows: 2, duck: true }, source: 'command' },
      hud: { checkedAt: 1 },
    }
    const w = world(on, { now: T0, store: kept })
    await start($, w)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Button', key: 'tile-files' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tile-pace' })).toBeUndefined()
    await ui.unmount()
  })

  test('/quackpit reset and a changed userConfig both win over an old override', () => {
    const s = readSettings({ tiles: 'progress,pace,context' })
    const added = addTile(s, undefined, 'files')
    expect(added.outcome).toBe('done')
    expect(effectiveLayout(s, added.record).tiles).toEqual(['progress', 'pace', 'context', 'files'])
    // The person edits userConfig: the override was made against other values and stands down.
    const changed = readSettings({ tiles: 'progress,cost' })
    expect(effectiveLayout(changed, added.record).tiles).toEqual(['progress', 'cost'])
    expect(removeTile(s, added.record, 'agents').outcome).toBe('missing')
    expect(moveTile(s, added.record, 'files', 1).record?.tiles).toEqual(['files', 'progress', 'pace', 'context'])
    expect(setRows(s, undefined, 5).outcome).toBe('bad')
    expect(setRows(s, undefined, 4).record?.rows).toBe(4)
    expect(parseTiles('pace, pace,unknown progress')).toEqual(['pace', 'progress'])
  })

  test('/quackpit rows 4 wraps the tiles onto a second line; rows out of range are refused', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    await command($, 'add agents')
    await command($, 'add files')
    await command($, 'rows 9')
    expect(w.toasts.at(-1)).toBe('Rows go from 1 to 4.')
    const one = planBand({ readings: readingsOf(newCockpit(T0), { now: T0, locale: 'en', days: [], today: '2026-10-11' }), tiles: [...DEFAULT_TILES, 'agents', 'files'], width: 120, rows: 2, maxRows: 8, withDuck: true })
    const two = planBand({ readings: readingsOf(newCockpit(T0), { now: T0, locale: 'en', days: [], today: '2026-10-11' }), tiles: [...DEFAULT_TILES, 'agents', 'files'], width: 120, rows: 4, maxRows: 8, withDuck: true })
    expect(one.kind === 'grid' && one.overflow.length).toBeGreaterThan(0)
    expect(planRows(two)).toBe(4)
    expect(two.kind === 'grid' && two.overflow).toEqual([])
    await command($, 'rows 4')
    expect(w.toasts.at(-1)).toBe('The band now takes up to 4 rows.')
    await command($, 'rows 1')
    expect(w.toasts.at(-1)).toBe('The band now takes one row.')
  })

  test('after /clear, when Claude Code starts the session state afresh, the saved layout is read back from the store', EN, async ($, on) => {
    // A state of its own for the ui value once the session's state is new: empty at version 0, then what is written.
    let fresh = false
    let held: { value: unknown; version: number } = { value: undefined, version: 0 }
    on('state.get', ($2, e, next) => {
      if (fresh && e.plugin === 'quackpit' && e.key === 'ui') return { value: { value: held.value as never, version: held.version } }
      return next(e)
    })
    // Typed loosely: the state events' declared shapes are too deep for the checker here.
    const onLoose = on as unknown as (event: 'state.set', hook: ($2: unknown, e: { plugin: string; key: string; value: unknown }, next: (e: unknown) => unknown) => unknown) => void
    onLoose('state.set', ($2, e, next) => {
      if (!fresh || e.plugin !== 'quackpit' || e.key !== 'ui') return next(e)
      held = { value: e.value, version: held.version + 1 }
      return { value: { isSet: true, version: held.version } }
    })
    const w = world(on, { now: T0 })
    await start($, w)
    await command($, 'remove limits')
    // As /clear leaves it: this session's state is new, and no session.start comes.
    fresh = true
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await ui.find({ type: 'Button', key: 'tile-limits' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'tile-pace' })).toBeDefined()
    await ui.unmount()
    // The next change starts from that layout, not from the settings alone.
    await command($, 'remove pace')
    const after = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    expect(await after.find({ type: 'Button', key: 'tile-limits' })).toBeUndefined()
    expect(await after.find({ type: 'Button', key: 'tile-pace' })).toBeUndefined()
    expect(await after.find({ type: 'Button', key: 'tile-context' })).toBeDefined()
    await after.unmount()
  })

  test('under 80 columns, or at rows 1, the band falls back to one dense row', EN, async ($, on) => {
    const w = world(on, { now: T0, usage: { fiveHour: 42, ctxPct: 30 } })
    await start($, w)
    for (const props of [band(70), band(150)]) {
      if (props.props.bodyColumns === 150) await command($, 'rows 1')
      const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...props })
      const dense = await ui.find({ type: 'Button', key: 'band-dense' })
      expect(dense?.text).toContain('5h 42%')
      expect(dense?.text).toContain('◔ 30%')
      expect(await ui.find({ type: 'Raster', key: 'duck-mini' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'tile-pace' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('clicking a tile opens the pane; /quackpit toggles it; /quack is the same command', EN, async ($, on) => {
    const w = world(on, { now: T0 })
    await start($, w)
    const ui = await $.ui.mount({ plugin: 'quackpit', surface: 'terminal', ...band() })
    await ui.press({ key: 'tile-context' })
    expect(w.opened.map(p => p.id)).toEqual(['quackpit'])
    await ui.unmount()
    await command($, '', 'quack')
    expect(w.closed).toEqual(['quackpit'])
    await command($, '')
    expect(w.opened).toHaveLength(2)
  })
})
