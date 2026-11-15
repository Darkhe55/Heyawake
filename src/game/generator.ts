/**
 * 数间题库生成器
 *
 * 1. 生成黑格互不相邻、白格连通的终盘；
 * 2. 从「整个棋盘一个区域」开始，逐步把某个格子拆成新区域；
 * 3. 每次拆分后重算区域数字，只保留仍满足白线规则的拆法；
 * 4. 解数随拆分单调下降，直到恰好一解。
 */

import type { Difficulty } from '../core/types'
import { BLACK, encodeBoard, encodeCells, WHITE } from './types.ts'
import { componentsOf, isValidSolution, solveByRules } from './rules.ts'
import { countSolutions } from './solver.ts'

export interface RawPuzzleOut {
  id: string
  name: string
  width: number
  height: number
  difficulty: Difficulty
  series: string
  board: string
  solution: string
}

interface GenSpec {
  w: number
  h: number
  strip: number
  blackRatio: number
  seed: number
  difficulty: Difficulty
  name: string
  series: string
  attempts: number
  maxNodes: number
}

function mulberry32(a: number): () => number {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(list: T[], rng: () => number): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = list[i]!
    list[i] = list[j]!
    list[j] = tmp
  }
  return list
}

function hasBlackNeighbor(cells: ArrayLike<number>, w: number, h: number, i: number): boolean {
  const x = i % w
  const y = (i / w) | 0
  return (
    (x > 0 && cells[i - 1] === BLACK) ||
    (x + 1 < w && cells[i + 1] === BLACK) ||
    (y > 0 && cells[i - w] === BLACK) ||
    (y + 1 < h && cells[i + w] === BLACK)
  )
}

function whiteConnected(cells: ArrayLike<number>, w: number, h: number): boolean {
  return componentsOf(cells, w, h, WHITE).length <= 1
}

function regionConnected(regions: ArrayLike<number>, w: number, h: number, region: number): boolean {
  let start = -1
  let total = 0
  for (let i = 0; i < w * h; i++) {
    if (regions[i] === region) {
      if (start < 0) start = i
      total++
    }
  }
  if (start < 0) return false
  const seen = new Uint8Array(w * h)
  const stack = [start]
  seen[start] = 1
  let count = 0
  while (stack.length) {
    const i = stack.pop()!
    count++
    const x = i % w
    const y = (i / w) | 0
    if (x > 0 && regions[i - 1] === region && !seen[i - 1]) {
      seen[i - 1] = 1
      stack.push(i - 1)
    }
    if (x + 1 < w && regions[i + 1] === region && !seen[i + 1]) {
      seen[i + 1] = 1
      stack.push(i + 1)
    }
    if (y > 0 && regions[i - w] === region && !seen[i - w]) {
      seen[i - w] = 1
      stack.push(i - w)
    }
    if (y + 1 < h && regions[i + w] === region && !seen[i + w]) {
      seen[i + w] = 1
      stack.push(i + w)
    }
  }
  return count === total
}

function lineRuleOk(
  cells: ArrayLike<number>,
  regions: ArrayLike<number>,
  w: number,
  h: number,
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
      for (let k = start + 1; k < end; k++) {
        if (regions[indices[k]!] !== regions[indices[k - 1]!]) transitions++
      }
      if (transitions >= 2) return false
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

interface AttemptStats {
  patternFail: number
  lineFail: number
  splitFail: number
  notUnique: number
  timeout: number
}

function attemptPuzzle(
  spec: GenSpec,
  rng: () => number,
  stats: AttemptStats,
): { regions: number[]; clues: number[]; solution: number[] } | null {
  const { w, h } = spec
  const size = w * h

  // 黑格终盘：互不相邻、白格连通
  const cells = new Array<number>(size).fill(WHITE)
  const target = Math.round(size * spec.blackRatio)
  const order = shuffle(
    Array.from({ length: size }, (_, i) => i),
    rng,
  )
  let black = 0
  for (const i of order) {
    if (black >= target) break
    if (cells[i] !== WHITE) continue
    if (hasBlackNeighbor(cells, w, h, i)) continue
    cells[i] = BLACK
    if (!whiteConnected(cells, w, h)) {
      cells[i] = WHITE
      continue
    }
    black++
  }
  if (black < Math.max(1, Math.round(target * 0.4))) {
    stats.patternFail++
    return null
  }

  // 初始区域：竖直条带
  const regions = new Array<number>(size).fill(0)
  let regionCount = 0
  for (let x = 0; x < w; x += spec.strip) {
    for (let y = 0; y < h; y++) {
      for (let dx = 0; dx < spec.strip && x + dx < w; dx++) {
        regions[y * w + x + dx] = regionCount
      }
    }
    regionCount++
  }

  if (!lineRuleOk(cells, regions, w, h)) {
    stats.lineFail++
    return null
  }

  const recomputeClues = (): number[] => {
    let count = 0
    for (const r of regions) if (r + 1 > count) count = r + 1
    const clues = new Array<number>(count).fill(0)
    for (let i = 0; i < size; i++) {
      if (cells[i] === BLACK) clues[regions[i]!]!++
    }
    return clues
  }

  let clues = recomputeClues()

  const uniqueness = (): boolean | null => {
    // 先用规则 + 反证：能推满说明每一步都是必然结论，解唯一
    const rules = solveByRules(regions, clues, size, w, h, true, 240)
    if (rules.ok && rules.saturated) return true
    if (rules.contradiction) return false
    const counted = countSolutions(regions, clues, size, w, h, 2, spec.maxNodes)
    if (counted.timedOut) return null
    return counted.count === 1
  }

  for (let step = 0; step < size; step++) {
    const unique = uniqueness()
    if (unique === null) {
      stats.timeout++
      return null
    }
    if (unique) {
      return { regions, clues, solution: cells }
    }

    // 选择一个大区域，尝试把其中一个格子拆成新区域
    const sizes = new Array<number>(regionCount).fill(0)
    for (const r of regions) sizes[r]!++
    const candidates: number[] = []
    for (let r = 0; r < regionCount; r++) {
      if (sizes[r]! >= 2) candidates.push(r)
    }
    shuffle(candidates, rng)

    let split = false
    for (const r of candidates) {
      const inRegion: number[] = []
      for (let i = 0; i < size; i++) if (regions[i] === r) inRegion.push(i)
      shuffle(inRegion, rng)
      // 优先拆黑格：黑格拆成单格区域会直接给出「1」的线索，且不会制造白线越界
      inRegion.sort((a, b) => (cells[a] === BLACK ? 0 : 1) - (cells[b] === BLACK ? 0 : 1))

      for (const cell of inRegion) {
        const oldRegion = regions[cell]!
        regions[cell] = regionCount
        const oldConnected = regionConnected(regions, w, h, oldRegion)
        if (!oldConnected) {
          regions[cell] = oldRegion
          continue
        }
        const newClues = recomputeClues()
        if (isValidSolution(cells, regions, newClues, w, h)) {
          regionCount++
          clues = newClues
          split = true
          break
        }
        regions[cell] = oldRegion
      }
      if (split) break
    }

    if (!split) {
      stats.splitFail++
      return null
    }
  }

  stats.notUnique++
  return null
}

const SPECS: GenSpec[] = [
  {
    w: 6,
    h: 6,
    strip: 2,
    blackRatio: 0.32,
    seed: 0x48455701,
    difficulty: 'easy',
    name: '初识数间',
    series: '入门',
    attempts: 80,
    maxNodes: 80_000,
  },
  {
    w: 7,
    h: 7,
    strip: 3,
    blackRatio: 0.32,
    seed: 0x48455702,
    difficulty: 'easy',
    name: '七间回廊',
    series: '入门',
    attempts: 100,
    maxNodes: 100_000,
  },
  {
    w: 8,
    h: 8,
    strip: 3,
    blackRatio: 0.33,
    seed: 0x48455703,
    difficulty: 'medium',
    name: '白线穿房',
    series: '进阶',
    attempts: 120,
    maxNodes: 120_000,
  },
  {
    w: 8,
    h: 8,
    strip: 3,
    blackRatio: 0.34,
    seed: 0x48455704,
    difficulty: 'medium',
    name: '黑格迷间',
    series: '进阶',
    attempts: 140,
    maxNodes: 150_000,
  },
  {
    w: 8,
    h: 8,
    strip: 3,
    blackRatio: 0.36,
    seed: 0x48455705,
    difficulty: 'hard',
    name: '十间叠影',
    series: '挑战',
    attempts: 160,
    maxNodes: 180_000,
  },
  {
    w: 8,
    h: 8,
    strip: 3,
    blackRatio: 0.38,
    seed: 0x48455706,
    difficulty: 'hard',
    name: '数间终局',
    series: '挑战',
    attempts: 180,
    maxNodes: 200_000,
  },
]

export function generatePuzzles(): RawPuzzleOut[] {
  const out: RawPuzzleOut[] = []
  for (const spec of SPECS) {
    const rng = mulberry32(spec.seed)
    const stats: AttemptStats = {
      patternFail: 0,
      lineFail: 0,
      splitFail: 0,
      notUnique: 0,
      timeout: 0,
    }
    let made: { regions: number[]; clues: number[]; solution: number[] } | null = null
    const t0 = Date.now()
    for (let attempt = 0; attempt < spec.attempts; attempt++) {
      made = attemptPuzzle(spec, rng, stats)
      if (made) break
    }
    if (!made) {
      console.error(`[数间 gen] ${spec.name} 失败统计：`, stats)
      throw new Error(`[数间 gen] ${spec.name} 在 ${spec.attempts} 次尝试内没有生成合法题`)
    }
    const blackCount = made.solution.filter((v) => v === BLACK).length
    console.log(
      `[数间 gen] ${spec.name} ${spec.w}×${spec.h}：区域 ${made.clues.length}，黑格 ${blackCount}，${Date.now() - t0}ms`,
    )
    out.push({
      id: `heyawake-${spec.w}x${spec.h}-${spec.seed.toString(36)}`,
      name: spec.name,
      width: spec.w,
      height: spec.h,
      difficulty: spec.difficulty,
      series: spec.series,
      board: encodeBoard(made.regions, made.clues),
      solution: encodeCells(made.solution),
    })
  }
  return out
}
