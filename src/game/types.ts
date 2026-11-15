/**
 * 数间（Heyawake）—— 游戏专用类型
 *
 * 规则：
 *   1. 带数字的区域内黑格数等于该数字；
 *   2. 黑格不能上下左右相邻；
 *   3. 所有白格必须连通；
 *   4. 一条直线相连的白格不能跨越两个以上区域（最多穿过 1 条区域边界）。
 *
 * 状态约定：
 *   0 = 未标记（视为白格）
 *   1 = 黑格
 *   2 = 圈定白格（仍视为白格）
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types'

export const EMPTY = 0
export const BLACK = 1
export const WHITE = 2

export type CellValue = 0 | 1 | 2

export interface HeyawakePuzzle extends Puzzle {
  /** 每格区域号 */
  regions: number[]
  /** 每个区域的黑格数；-1 表示无数字 */
  clues: number[]
  /** 参考解：1 黑 / 2 白 */
  solution?: number[]
}

export interface HeyawakeState extends GameState {
  cells: number[]
  givens: number[]
}

export interface RegionIssue {
  region: number
  black: number
  target: number
}

export interface LineIssue {
  orientation: 'row' | 'col'
  index: number
  regions: number
}

export interface HeyawakeResult extends ValidationResult {
  empty: number
  complete: boolean
  blackCount: number
  adjacentBlackPairs: number
  blackNeighborCells: number[]
  whiteParts: number
  trapped: number[]
  regionIssues: RegionIssue[]
  lineIssues: LineIssue[]
  badCells: number[]
}

export function asHeyaPuzzle(p: Puzzle): HeyawakePuzzle {
  return p as HeyawakePuzzle
}

export function asHeyaState(s: GameState): HeyawakeState {
  return s as HeyawakeState
}

/* ────────────────────────── 编码 ────────────────────────── */

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

export function encodeBoard(regions: number[], clues: number[]): string {
  let out = ''
  for (const r of regions) out += r >= 0 && r < BASE36.length ? BASE36[r]! : '0'
  out += '|'
  for (const c of clues) {
    const v = c < 0 ? 0 : c + 1
    out += BASE36[Math.floor(v / 36)]! + BASE36[v % 36]!
  }
  return out
}

export function decodeBoard(
  text: string,
  expected: number,
): { regions: number[]; clues: number[] } | null {
  if (typeof text !== 'string') return null
  const parts = text.split('|')
  if (parts.length !== 2) return null
  const regionText = parts[0]!
  if (regionText.length !== expected) return null
  const regions = new Array<number>(expected).fill(-1)
  for (let i = 0; i < expected; i++) {
    const v = BASE36.indexOf(regionText[i]!.toLowerCase())
    if (v < 0) return null
    regions[i] = v
  }
  let regionCount = 0
  for (const r of regions) if (r + 1 > regionCount) regionCount = r + 1
  const clueText = parts[1]!
  if (clueText.length !== regionCount * 2) return null
  const clues = new Array<number>(regionCount).fill(-1)
  for (let i = 0; i < regionCount; i++) {
    const hi = BASE36.indexOf(clueText[i * 2]!.toLowerCase())
    const lo = BASE36.indexOf(clueText[i * 2 + 1]!.toLowerCase())
    if (hi < 0 || lo < 0) return null
    clues[i] = hi * 36 + lo - 1
  }
  return { regions, clues }
}

export function encodeCells(cells: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < cells.length; i++) out += String(cells[i]! | 0)
  return out
}

export function decodeCells(text: string, expected: number): number[] | null {
  if (typeof text !== 'string' || text.length !== expected) return null
  const out = new Array<number>(expected)
  for (let i = 0; i < expected; i++) {
    const ch = text[i]!
    if (ch === '0' || ch === '.') out[i] = EMPTY
    else if (ch === '1' || ch === 'B' || ch === 'b' || ch === '#') out[i] = BLACK
    else if (ch === '2' || ch === 'W' || ch === 'w' || ch === 'o' || ch === 'O') out[i] = WHITE
    else return null
  }
  return out
}

export function normalizeRegions(regions: number[]): number[] {
  const map = new Map<number, number>()
  let next = 0
  return regions.map((r) => {
    if (r < 0) return -1
    if (!map.has(r)) map.set(r, next++)
    return map.get(r)!
  })
}
