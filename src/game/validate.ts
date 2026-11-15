/**
 * 数间 —— 实时校验
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types'
import {
  asHeyaPuzzle,
  asHeyaState,
  BLACK,
  EMPTY,
  type HeyawakeResult,
  type LineIssue,
  type RegionIssue,
} from './types'

function whiteComponents(cells: ArrayLike<number>, w: number, h: number): number[][] {
  const n = w * h
  const seen = new Uint8Array(n)
  const out: number[][] = []
  for (let start = 0; start < n; start++) {
    if (cells[start] === BLACK || seen[start]) continue
    const comp: number[] = []
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      const x = i % w
      const y = (i / w) | 0
      if (x > 0 && cells[i - 1] !== BLACK && !seen[i - 1]) {
        seen[i - 1] = 1
        stack.push(i - 1)
      }
      if (x + 1 < w && cells[i + 1] !== BLACK && !seen[i + 1]) {
        seen[i + 1] = 1
        stack.push(i + 1)
      }
      if (y > 0 && cells[i - w] !== BLACK && !seen[i - w]) {
        seen[i - w] = 1
        stack.push(i - w)
      }
      if (y + 1 < h && cells[i + w] !== BLACK && !seen[i + w]) {
        seen[i + w] = 1
        stack.push(i + w)
      }
    }
    out.push(comp)
  }
  return out
}

export function validate(state: GameState, puzzle: Puzzle): HeyawakeResult {
  const s = asHeyaState(state)
  const p = asHeyaPuzzle(puzzle)
  const w = s.width
  const h = s.height
  const size = w * h
  const cells = s.cells
  const regions = p.regions ?? []
  const clues = p.clues ?? []

  let empty = 0
  let blackCount = 0
  for (let i = 0; i < size; i++) {
    if (cells[i] === EMPTY) empty++
    else if (cells[i] === BLACK) blackCount++
  }

  const bad = new Set<number>()

  let adjacentBlackPairs = 0
  const blackNeighborCells = new Set<number>()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (cells[i] !== BLACK) continue
      if (x + 1 < w && cells[i + 1] === BLACK) {
        adjacentBlackPairs++
        blackNeighborCells.add(i)
        blackNeighborCells.add(i + 1)
      }
      if (y + 1 < h && cells[i + w] === BLACK) {
        adjacentBlackPairs++
        blackNeighborCells.add(i)
        blackNeighborCells.add(i + w)
      }
    }
  }
  for (const i of blackNeighborCells) bad.add(i)

  const comps = whiteComponents(cells, w, h)
  const trapped: number[] = []
  if (comps.length > 1) {
    let largest = 0
    for (let i = 1; i < comps.length; i++) {
      if (comps[i]!.length > comps[largest]!.length) largest = i
    }
    for (let i = 0; i < comps.length; i++) {
      if (i === largest) continue
      for (const idx of comps[i]!) {
        trapped.push(idx)
        bad.add(idx)
      }
    }
  }

  let regionCount = 0
  for (const r of regions) if (r + 1 > regionCount) regionCount = r + 1
  const regionIssues: RegionIssue[] = []
  for (let r = 0; r < regionCount; r++) {
    const target = clues[r] ?? -1
    if (target < 0) continue
    let black = 0
    for (let i = 0; i < size; i++) if (regions[i] === r && cells[i] === BLACK) black++
    if (black !== target) {
      regionIssues.push({ region: r, black, target })
      if (black > target) {
        for (let i = 0; i < size; i++) if (regions[i] === r && cells[i] === BLACK) bad.add(i)
      }
    }
  }

  const lineIssues: LineIssue[] = []
  const checkLine = (indices: number[], orientation: 'row' | 'col', index: number): void => {
    let start = 0
    while (start < indices.length) {
      if (cells[indices[start]!] === BLACK) {
        start++
        continue
      }
      let end = start
      while (end < indices.length && cells[indices[end]!] !== BLACK) end++
      let transitions = 0
      for (let k = start + 1; k < end; k++) {
        if (regions[indices[k]!] !== regions[indices[k - 1]!]) transitions++
      }
      if (transitions >= 2) {
        lineIssues.push({ orientation, index, regions: transitions + 1 })
        for (let k = start; k < end; k++) bad.add(indices[k]!)
      }
      start = end
    }
  }
  for (let y = 0; y < h; y++) {
    const row: number[] = []
    for (let x = 0; x < w; x++) row.push(y * w + x)
    checkLine(row, 'row', y)
  }
  for (let x = 0; x < w; x++) {
    const col: number[] = []
    for (let y = 0; y < h; y++) col.push(y * w + x)
    checkLine(col, 'col', x)
  }

  const solved =
    adjacentBlackPairs === 0 &&
    comps.length === 1 &&
    regionIssues.length === 0 &&
    lineIssues.length === 0

  return {
    solved,
    empty,
    complete: empty === 0,
    blackCount,
    adjacentBlackPairs,
    blackNeighborCells: Array.from(blackNeighborCells),
    whiteParts: comps.length,
    trapped: Array.from(new Set(trapped)),
    regionIssues,
    lineIssues,
    badCells: Array.from(bad),
  }
}

export function statusBits(result: ValidationResult): string[] {
  const r = result as HeyawakeResult
  if (r.solved) return ['完成']

  const bits: string[] = []
  if (r.adjacentBlackPairs > 0) bits.push(`${r.adjacentBlackPairs} 处黑格相邻`)
  if (r.whiteParts > 1) bits.push(`白格分成 ${r.whiteParts} 块未连通`)
  const over = r.regionIssues.filter((x) => x.black > x.target).length
  const under = r.regionIssues.length - over
  if (over > 0) bits.push(`${over} 个区域黑格超出数字`)
  if (under > 0) bits.push(`${under} 个区域黑格未达到数字`)
  if (r.lineIssues.length > 0) bits.push(`${r.lineIssues.length} 条白线跨越多个区域`)
  if (bits.length === 0) {
    if (r.blackCount === 0) bits.push('开始涂黑')
    else bits.push('继续推理')
  }
  return bits
}
