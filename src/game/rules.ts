/**
 * 数间 —— 规则引擎
 */

import { BLACK, EMPTY, WHITE } from './types.ts'

export type RuleKind = 'adj' | 'connect' | 'count' | 'line'

export type SetCallback = (index: number, value: number, rule: RuleKind) => void

const DX = [1, -1, 0, 0]
const DY = [0, 0, 1, -1]

export function neighborsOf(index: number, w: number, h: number): number[] {
  const x = index % w
  const y = (index / w) | 0
  const out: number[] = []
  if (x > 0) out.push(index - 1)
  if (x + 1 < w) out.push(index + 1)
  if (y > 0) out.push(index - w)
  if (y + 1 < h) out.push(index + w)
  return out
}

export function componentsOf(
  cells: ArrayLike<number>,
  w: number,
  h: number,
  color: number,
): number[][] {
  const n = w * h
  const seen = new Uint8Array(n)
  const out: number[][] = []
  for (let start = 0; start < n; start++) {
    if (cells[start] !== color || seen[start]) continue
    const comp: number[] = []
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      const x = i % w
      const y = (i / w) | 0
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d]!
        const ny = y + DY[d]!
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (!seen[j] && cells[j] === color) {
          seen[j] = 1
          stack.push(j)
        }
      }
    }
    out.push(comp)
  }
  return out
}

export function initialGrid(size: number): number[] {
  return new Array<number>(size).fill(EMPTY)
}

/** 检查直线白格是否跨越超过 1 条区域边界 */
function lineRule(
  cells: Int8Array | number[],
  regions: ArrayLike<number>,
  w: number,
  h: number,
  set?: (i: number, v: number, k: RuleKind) => boolean,
): boolean {
  const check = (indices: number[]): boolean => {
    let start = 0
    while (start < indices.length) {
      if (cells[indices[start]!] === BLACK) {
        start++
        continue
      }
      let end = start
      while (end < indices.length && cells[indices[end]!] !== BLACK) end++
      let transitions = 0
      const unknown: number[] = []
      for (let k = start; k < end; k++) {
        const cell = indices[k]!
        if (cells[cell] === EMPTY) unknown.push(cell)
        if (k > start && regions[cell] !== regions[indices[k - 1]!]) transitions++
      }
      if (transitions >= 2) {
        if (unknown.length === 0) return false
        if (unknown.length === 1) {
          const cell = unknown[0]!
          if (cells[cell] === BLACK) return false
          if (cells[cell] === EMPTY && set) {
            if (!set(cell, BLACK, 'line')) return false
          }
        }
      }
      start = end
    }
    return true
  }

  for (let y = 0; y < h; y++) {
    const row: number[] = []
    for (let x = 0; x < w; x++) row.push(y * w + x)
    if (!check(row)) return false
  }
  for (let x = 0; x < w; x++) {
    const col: number[] = []
    for (let y = 0; y < h; y++) col.push(y * w + x)
    if (!check(col)) return false
  }
  return true
}

export function propagate(
  cells: Int8Array | number[],
  regions: ArrayLike<number>,
  clues: ArrayLike<number>,
  w: number,
  h: number,
  onSet?: SetCallback,
): boolean {
  const size = w * h
  let regionCount = 0
  for (let i = 0; i < size; i++) {
    const r = regions[i] ?? -1
    if (r + 1 > regionCount) regionCount = r + 1
  }
  let changed = true

  const set = (i: number, value: number, kind: RuleKind): boolean => {
    if (cells[i] === value) return true
    if (cells[i] !== EMPTY) return false
    cells[i] = value
    onSet?.(i, value, kind)
    changed = true
    return true
  }

  while (changed) {
    changed = false

    // 黑格不相邻
    for (let i = 0; i < size; i++) {
      if (cells[i] !== BLACK) continue
      for (const j of neighborsOf(i, w, h)) {
        if (cells[j] === BLACK) return false
        if (cells[j] === EMPTY && !set(j, WHITE, 'adj')) return false
      }
    }

    // 白格连通
    let firstWhite = -1
    for (let i = 0; i < size; i++) {
      if (cells[i] === WHITE) {
        firstWhite = i
        break
      }
    }
    if (firstWhite >= 0) {
      const possible = new Uint8Array(size)
      const stack = [firstWhite]
      possible[firstWhite] = 1
      while (stack.length) {
        const i = stack.pop()!
        const x = i % w
        const y = (i / w) | 0
        if (x > 0 && cells[i - 1] !== BLACK && !possible[i - 1]) {
          possible[i - 1] = 1
          stack.push(i - 1)
        }
        if (x + 1 < w && cells[i + 1] !== BLACK && !possible[i + 1]) {
          possible[i + 1] = 1
          stack.push(i + 1)
        }
        if (y > 0 && cells[i - w] !== BLACK && !possible[i - w]) {
          possible[i - w] = 1
          stack.push(i - w)
        }
        if (y + 1 < h && cells[i + w] !== BLACK && !possible[i + w]) {
          possible[i + w] = 1
          stack.push(i + w)
        }
      }
      for (let i = 0; i < size; i++) {
        if (cells[i] === WHITE && !possible[i]) return false
        if (cells[i] === EMPTY && !possible[i]) {
          if (!set(i, BLACK, 'connect')) return false
        }
      }
    }

    // 区域数字
    for (let r = 0; r < regionCount; r++) {
      const target = clues[r] ?? -1
      if (target < 0) continue
      let black = 0
      const unknown: number[] = []
      for (let i = 0; i < size; i++) {
        if (regions[i] !== r) continue
        if (cells[i] === BLACK) black++
        else if (cells[i] === EMPTY) unknown.push(i)
      }
      if (black > target) return false
      if (black + unknown.length < target) return false
      if (black === target) {
        for (const i of unknown) if (!set(i, WHITE, 'count')) return false
      } else if (black + unknown.length === target) {
        for (const i of unknown) if (!set(i, BLACK, 'count')) return false
      }
    }

    // 白格直线不能跨越两个以上区域
    if (!lineRule(cells, regions, w, h, set)) return false
  }

  return true
}

export function isValidSolution(
  cells: ArrayLike<number>,
  regions: ArrayLike<number>,
  clues: ArrayLike<number>,
  w: number,
  h: number,
): boolean {
  const size = w * h
  let regionCount = 0
  for (let i = 0; i < size; i++) {
    if (cells[i] !== BLACK && cells[i] !== WHITE) return false
    const r = regions[i] ?? -1
    if (r + 1 > regionCount) regionCount = r + 1
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (cells[i] !== BLACK) continue
      if (x + 1 < w && cells[i + 1] === BLACK) return false
      if (y + 1 < h && cells[i + w] === BLACK) return false
    }
  }

  if (componentsOf(cells, w, h, WHITE).length !== 1) return false

  for (let r = 0; r < regionCount; r++) {
    const target = clues[r] ?? -1
    if (target < 0) continue
    let black = 0
    for (let i = 0; i < size; i++) if (regions[i] === r && cells[i] === BLACK) black++
    if (black !== target) return false
  }

  // 白格直线规则
  let ok = true
  const check = (indices: number[]): void => {
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
      if (transitions >= 2) ok = false
      start = end
    }
  }
  for (let y = 0; y < h; y++) {
    const row: number[] = []
    for (let x = 0; x < w; x++) row.push(y * w + x)
    check(row)
  }
  for (let x = 0; x < w; x++) {
    const col: number[] = []
    for (let y = 0; y < h; y++) col.push(y * w + x)
    check(col)
  }
  return ok
}

export interface RuleSolveResult {
  ok: boolean
  solution: number[] | null
  contradiction: boolean
  saturated: boolean
  usedProbing: boolean
}

export function solveByRules(
  regions: ArrayLike<number>,
  clues: ArrayLike<number>,
  size: number,
  w: number,
  h: number,
  probing = true,
  maxRounds = 400,
): RuleSolveResult {
  const grid = initialGrid(size)
  let usedProbing = false

  for (let round = 0; round < maxRounds; round++) {
    if (!propagate(grid, regions, clues, w, h)) {
      return { ok: false, solution: null, contradiction: true, saturated: false, usedProbing }
    }
    let unknown = -1
    for (let i = 0; i < size; i++) {
      if (grid[i] === EMPTY) {
        unknown = i
        break
      }
    }
    if (unknown < 0) {
      const solution = Array.from(grid)
      const ok = isValidSolution(solution, regions, clues, w, h)
      return {
        ok,
        solution: ok ? solution : null,
        contradiction: false,
        saturated: ok,
        usedProbing,
      }
    }
    if (!probing) {
      return { ok: false, solution: null, contradiction: false, saturated: false, usedProbing }
    }

    usedProbing = true
    const forced: Array<{ index: number; value: number }> = []
    for (let i = 0; i < size; i++) {
      if (grid[i] !== EMPTY) continue
      let blackImpossible = false
      let whiteImpossible = false
      {
        const trial = Int8Array.from(grid)
        trial[i] = BLACK
        if (!propagate(trial, regions, clues, w, h)) blackImpossible = true
      }
      {
        const trial = Int8Array.from(grid)
        trial[i] = WHITE
        if (!propagate(trial, regions, clues, w, h)) whiteImpossible = true
      }
      if (blackImpossible && whiteImpossible) {
        return { ok: false, solution: null, contradiction: true, saturated: false, usedProbing }
      }
      if (blackImpossible !== whiteImpossible) {
        forced.push({ index: i, value: blackImpossible ? WHITE : BLACK })
      }
    }
    if (!forced.length) {
      return { ok: false, solution: null, contradiction: false, saturated: false, usedProbing }
    }
    for (const { index, value } of forced) {
      if (grid[index] === EMPTY) grid[index] = value
    }
  }
  return { ok: false, solution: null, contradiction: false, saturated: false, usedProbing }
}
