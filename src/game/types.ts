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
const BASE = BASE36.length

/** 区域号 / 区数字的可用编码宽度（每格 1 / 2 / 3 个 base36 字符） */
const REGION_MAX_1 = BASE // 36
const REGION_MAX_2 = BASE * BASE // 1296
const REGION_MAX_3 = BASE * BASE * BASE // 46656
/** 单条「每区黑格数」的最大可编码值（值 +1 后编码，2 字符足够 0..1295） */
const CLUE_MAX_2 = BASE * BASE

function intToBase36(v: number, width: number): string {
  let out = ''
  for (let k = width - 1; k >= 0; k--) {
    out += BASE36[Math.floor(v / BASE ** k) % BASE]!
  }
  return out
}

function base36ToInt(text: string, width: number): number {
  let v = 0
  for (let k = 0; k < width; k++) {
    const d = BASE36.indexOf(text[k]!.toLowerCase())
    if (d < 0) return -1
    v = v * BASE + d
  }
  return v
}

/**
 * 编码题面：区域串 + '|' + 每区黑格数。
 *
 * 区域号编码宽度按区域总数自动选择（每格 1 / 2 / 3 个 base36 字符，最多 46656 个区域）：
 *   - 区域数 ≤ 36：每格 1 个字符（旧格式，现有题库都是这种）；
 *   - 区域数 ≤ 1296：每格 2 个字符（识图导入的大题）；
 *   - 区域数 > 1296：每格 3 个字符（超大自定义题板）。
 * 解码按「区域串长度 / 格数」自动判断宽度，旧数据完全不受影响。
 *
 * 每区黑格数默认 2 个字符（值 +1，可表示 -1 无数字与 0..1294）；
 * 只有出现 >1294 的数字时才切 3 个字符，同样按长度识别。
 */
export function encodeBoard(regions: number[], clues: number[]): string {
  let regionCount = 0
  for (const r of regions) if (r + 1 > regionCount) regionCount = r + 1
  const regionWidth = regionCount <= REGION_MAX_1 ? 1 : regionCount <= REGION_MAX_2 ? 2 : 3
  let out = ''
  for (const r of regions) {
    const v = r >= 0 && r < REGION_MAX_3 ? r : 0
    out += intToBase36(v, regionWidth)
  }
  const clueWidth = clues.some((c) => c + 1 >= CLUE_MAX_2) ? 3 : 2
  out += '|'
  for (const c of clues) {
    const v = c < 0 ? 0 : Math.min(c + 1, (clueWidth === 2 ? CLUE_MAX_2 : REGION_MAX_3) - 1)
    out += intToBase36(v, clueWidth)
  }
  return out
}

export function decodeBoard(
  text: string,
  expected: number,
): { regions: number[]; clues: number[] } | null {
  if (typeof text !== 'string' || expected <= 0) return null
  const parts = text.split('|')
  if (parts.length !== 2) return null
  const regionText = parts[0]!
  let regionWidth: number
  if (regionText.length === expected * 3) regionWidth = 3
  else if (regionText.length === expected * 2) regionWidth = 2
  else if (regionText.length === expected) regionWidth = 1
  else return null
  const regions = new Array<number>(expected).fill(-1)
  for (let i = 0; i < expected; i++) {
    const v = base36ToInt(regionText.slice(i * regionWidth, (i + 1) * regionWidth), regionWidth)
    if (v < 0) return null
    regions[i] = v
  }
  let regionCount = 0
  for (const r of regions) if (r + 1 > regionCount) regionCount = r + 1

  const clueText = parts[1]!
  let clueWidth: number
  if (regionCount === 0) clueWidth = 0
  else if (clueText.length === regionCount * 3) clueWidth = 3
  else if (clueText.length === regionCount * 2) clueWidth = 2
  else return null
  if (clueWidth === 0) return { regions, clues: [] }
  const clues = new Array<number>(regionCount).fill(-1)
  for (let i = 0; i < regionCount; i++) {
    const v = base36ToInt(clueText.slice(i * clueWidth, (i + 1) * clueWidth), clueWidth)
    if (v < 0) return null
    clues[i] = v - 1
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
