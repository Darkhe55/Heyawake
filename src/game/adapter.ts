/**
 * ════════════════════════════════════════════════════════════════════
 *  数间（Heyawake）—— 游戏适配器
 * ════════════════════════════════════════════════════════════════════
 *
 * 规则：
 *   1. 带数字的区域内黑格数等于该数字；
 *   2. 黑格不能相邻；
 *   3. 所有白格必须连通；
 *   4. 一条直线白格不能跨越两个以上区域。
 *
 * 状态用 0/1/2：0 = 未标记（白），1 = 黑，2 = 圈定白。
 */

import { playDrop, playPluck } from '../core/audio'
import type { CustomSupport, GameAdapter, Move, Puzzle, SolveResult } from '../core/types'
import { planLogicSolve } from './logic'
import { builtinPuzzles, getReferenceSolution } from './puzzles'
import { hitTest, metricsFor, renderBoard } from './render'
import { countSolutions, solvePuzzle } from './solver'
import {
  applyMove,
  cloneState,
  createEmptyState,
  cycleValue,
  deserializeState,
  firstHintMove,
  invertMove,
  rightClickValue,
  serializeState,
  valueAt,
} from './state'
import { statusBits, validate } from './validate'
import {
  BLACK,
  decodeBoard,
  encodeBoard,
  normalizeRegions,
  type HeyawakePuzzle,
} from './types'

const meta = {
  title: '数间',
  tagline: '黑格不相邻、白格连成一片，白线还不能穿过太多房间',
  footerNote:
    '规则：带数字的区域内黑格数等于该数字；黑格不能上下左右相邻；所有白格必须连通；一条直线相连的白格不能跨越两个以上区域。',
  storageKeyPrefix: 'heyawake',
  customIdPrefix: 'heyawake-custom-',
  customMinW: 5,
  customMinH: 5,
  customMaxW: 40,
  customMaxH: 40,
  targetKind: 'cell' as const,
}

function readClueList(id: string, count: number, fallback: number[]): number[] {
  const el = document.getElementById(id) as HTMLTextAreaElement | null
  const raw = el?.value.trim() ?? ''
  const vals = raw ? raw.split(/[\s,，]+/).filter(Boolean).map(Number) : []
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const n = Number.isFinite(vals[i]) ? vals[i]! : fallback[i] ?? -1
    out.push(Number.isInteger(n) && n >= -1 && n <= 99 ? n : -1)
  }
  return out
}

function regionCountOf(regions: number[]): number {
  let count = 0
  for (const r of regions) if (r + 1 > count) count = r + 1
  return count
}

const custom: CustomSupport = {
  mode: 'region',
  valueCycle: [null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  keyForDigit: (digit) => {
    if (digit === 0) return null
    if (digit >= 1 && digit <= 20) return digit
    return undefined
  },
  cellLabel: (v) => (v == null ? '' : String(v)),
  cellClass: (v) => (v == null ? '' : `r${v}`),
  hint: '先用区域号涂出各房间，再在下方按区域号顺序输入每区的黑格数（-1 或空 = 无数字）。',

  extras: {
    html: () => `
      <div class="custom-extras-grid">
        <label>每区黑格数（按区域号 1,2,3… 顺序，空格或逗号分隔；-1/空=无数字）
          <textarea id="custom-clues" rows="2" spellcheck="false"></textarea>
        </label>
        <div class="custom-hint">区域数由当前涂色自动统计；数字范围 0..区域内格数。</div>
      </div>`,
    mount: () => undefined,
    reset: () => {
      const el = document.getElementById('custom-clues') as HTMLTextAreaElement | null
      if (el) el.value = ''
    },
    load: (p) => {
      const hp = p as HeyawakePuzzle
      const el = document.getElementById('custom-clues') as HTMLTextAreaElement | null
      if (el) el.value = (hp.clues ?? []).join(' ')
    },
  },

  toGrid: (p) => {
    const hp = p as HeyawakePuzzle
    if (!Array.isArray(hp.regions) || hp.regions.length !== p.width * p.height) return null
    return {
      width: p.width,
      height: p.height,
      grid: hp.regions.map((r) => (typeof r === 'number' && r >= 0 ? r + 1 : null)),
    }
  },

  makePuzzle: (w, h, grid, existingId) => {
    const raw = grid.map((v) => (typeof v === 'number' && v >= 1 ? v : -1))
    const regions = normalizeRegions(raw)
    const regionCount = regionCountOf(regions)
    const fallback = new Array<number>(regionCount).fill(-1)
    const clues = readClueList('custom-clues', regionCount, fallback)
    return {
      id: existingId ?? `${meta.customIdPrefix}${w}x${h}-${Date.now()}`,
      name: `自定义 · ${w}×${h}`,
      width: w,
      height: h,
      difficulty: 'custom',
      regions,
      clues,
    } satisfies HeyawakePuzzle
  },

  encodePuzzle: (p) => {
    const hp = p as HeyawakePuzzle
    return { board: encodeBoard(hp.regions ?? [], hp.clues ?? []) }
  },

  decodePuzzle: (record) => {
    if (typeof record.id !== 'string') return null
    if (typeof record.width !== 'number' || typeof record.height !== 'number') return null
    const w = record.width
    const h = record.height
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null
    if (typeof record.board !== 'string') return null
    const decoded = decodeBoard(record.board, w * h)
    if (!decoded) return null
    return {
      id: record.id,
      name: typeof record.name === 'string' ? record.name : `自定义 · ${w}×${h}`,
      width: w,
      height: h,
      difficulty: 'custom',
      regions: decoded.regions,
      clues: decoded.clues,
    } satisfies HeyawakePuzzle
  },

  audit: (p) => {
    const hp = p as HeyawakePuzzle
    const w = hp.width
    const h = hp.height
    if (w * h > 400) return { ok: true, message: '大盘面跳过唯一解校验。' }
    const out = countSolutions(hp.regions ?? [], hp.clues ?? [], w * h, w, h, 2, 300_000)
    if (out.timedOut) return { ok: true, message: '唯一解校验超时，仍可保存。' }
    if (out.count === 0) return { ok: false, message: '当前房间/数字无解，请检查。' }
    if (out.count > 1) return { ok: true, message: '注意：当前题面存在多个解。' }
    return { ok: true, message: '唯一解 ✓。' }
  },
}


function playForMove(move: Move, streak: number): void {
  if (move.to === BLACK) playDrop(streak)
  else playPluck(streak)
}

export const adapter: GameAdapter = {
  meta,
  builtinPuzzles,
  getReferenceSolution,
  createEmptyState,
  cloneState,
  cycleValue,
  rightClickValue,
  applyMove,
  invertMove,
  valueAt,
  serializeState,
  deserializeState,
  validate,
  statusBits,
  metricsFor,
  renderBoard,
  hitTest,
  planLogicSolve,
  solvePuzzle: (puzzle: Puzzle, maxNodes?: number): SolveResult => solvePuzzle(puzzle, maxNodes),
  firstHintMove,
  custom,
  playForMove,
}
