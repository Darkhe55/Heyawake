/**
 * 数间 —— SVG 渲染与命中
 */

import type { BoardMetrics, GameState, Puzzle, ValidationResult } from '../core/types'
import {
  cellAtPoint,
  cellCenter,
  regionBoundarySegments,
  regionFill,
  squareMetrics,
} from '../core/board'
import {
  asHeyaPuzzle,
  asHeyaState,
  BLACK,
  EMPTY,
  WHITE,
  type HeyawakeResult,
} from './types'

export function metricsFor(puzzle: Puzzle): BoardMetrics {
  return squareMetrics(puzzle.width, puzzle.height, { cell: 46, pad: 30, targetKind: 'cell' })
}

export function renderBoard(
  puzzle: Puzzle,
  state: GameState,
  result: ValidationResult,
  _colorGrid?: unknown,
): string {
  const m = metricsFor(puzzle)
  const p = asHeyaPuzzle(puzzle)
  const s = asHeyaState(state)
  const r = result as HeyawakeResult
  const w = puzzle.width
  const h = puzzle.height
  const regions = p.regions ?? []
  const clues = p.clues ?? []
  const bad = new Set<number>(r.badCells ?? [])

  const cell = m.cell
  const originX = m.originX ?? m.pad
  const originY = m.originY ?? m.pad
  const gap = Math.max(1, cell * 0.03)
  const inner = cell - gap
  const radius = cell * 0.1
  const parts: string[] = []

  parts.push(
    `<rect class="hw-board-bg" x="${originX - 10}" y="${originY - 10}" width="${w * cell + 20}" height="${h * cell + 20}" rx="${(cell * 0.2).toFixed(2)}" />`,
  )

  for (let i = 0; i < w * h; i++) {
    const x = originX + (i % w) * cell + gap / 2
    const y = originY + Math.floor(i / w) * cell + gap / 2
    const v = s.cells[i] ?? EMPTY
    const region = regions[i] ?? -1

    let cls = 'hw-cell'
    if (v === BLACK) cls += ' black'
    else if (v === WHITE) cls += ' white'
    else cls += ' empty'
    if (bad.has(i)) cls += ' bad'

    const fill = v === BLACK ? undefined : regionFill(region)
    const fillAttr = fill ? ` fill="${fill}"` : ''
    let content = `<rect class="${cls}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${inner.toFixed(2)}" height="${inner.toFixed(2)}" rx="${radius.toFixed(2)}"${fillAttr} />`

    if (bad.has(i)) {
      content += `<rect class="hw-error" x="${(x + 1.1).toFixed(2)}" y="${(y + 1.1).toFixed(2)}" width="${(inner - 2.2).toFixed(2)}" height="${(inner - 2.2).toFixed(2)}" rx="${(radius * 0.8).toFixed(2)}" />`
    }
    parts.push(`<g data-index="${i}">${content}</g>`)
  }

  // 区域粗边界
  const segs = regionBoundarySegments(m, regions)
  parts.push(
    `<g class="hw-region-lines">${segs
      .map(
        (seg) =>
          `<line x1="${seg.x1.toFixed(2)}" y1="${seg.y1.toFixed(2)}" x2="${seg.x2.toFixed(2)}" y2="${seg.y2.toFixed(2)}" />`,
      )
      .join('')}</g>`,
  )

  // 区域数字：放在每个区域左上角
  const anchors = new Map<number, number>()
  for (let i = 0; i < w * h; i++) {
    const region = regions[i] ?? -1
    if (region < 0) continue
    const old = anchors.get(region)
    if (old === undefined || i < old) anchors.set(region, i)
  }
  const labels: string[] = []
  for (const [region, index] of anchors) {
    const clue = clues[region] ?? -1
    if (clue < 0) continue
    const c = cellCenter(m, index)
    labels.push(
      `<g class="hw-clue"><circle cx="${(c.x - cell * 0.22).toFixed(2)}" cy="${(c.y - cell * 0.22).toFixed(2)}" r="${(cell * 0.16).toFixed(2)}" /><text x="${(c.x - cell * 0.22).toFixed(2)}" y="${(c.y - cell * 0.22 + 0.5).toFixed(2)}" style="font-size:${(cell * 0.2).toFixed(2)}px">${clue}</text></g>`,
    )
  }
  parts.push(`<g class="hw-clues">${labels.join('')}</g>`)

  for (let i = 0; i < w * h; i++) {
    const x = originX + (i % w) * cell
    const y = originY + Math.floor(i / w) * cell
    parts.push(
      `<rect class="cell-hit" data-index="${i}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" />`,
    )
  }

  return `<svg class="board-svg hw-board" viewBox="0 0 ${m.svgWidth} ${m.svgHeight}" width="${m.svgWidth}" height="${m.svgHeight}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`
}

export function hitTest(
  m: BoardMetrics,
  _puzzle: Puzzle,
  x: number,
  y: number,
): { index: number } | null {
  const index = cellAtPoint(m, x, y)
  return index == null ? null : { index }
}
