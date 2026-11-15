/**
 * 数间 —— 题库加载
 */

import { RAW_PUZZLES } from './puzzles-data'
import {
  asHeyaPuzzle,
  decodeBoard,
  decodeCells,
  EMPTY,
  type HeyawakePuzzle,
  type HeyawakeState,
} from './types'

export const builtinPuzzles: HeyawakePuzzle[] = []
const solutions = new Map<string, number[]>()

for (const raw of RAW_PUZZLES) {
  const size = raw.width * raw.height
  const decoded = decodeBoard(raw.board, size)
  if (!decoded) {
    console.warn(`[数间] 题面解码失败：${raw.id}`)
    continue
  }
  const puzzle: HeyawakePuzzle = {
    id: raw.id,
    name: raw.name,
    width: raw.width,
    height: raw.height,
    difficulty: raw.difficulty,
    regions: decoded.regions,
    clues: decoded.clues,
  }
  builtinPuzzles.push(puzzle)
  if (raw.solution) {
    const solution = decodeCells(raw.solution, size)
    if (solution) {
      puzzle.solution = solution
      solutions.set(raw.id, solution)
    }
  }
}

export function getReferenceSolution(id: string): HeyawakeState | null {
  const cells = solutions.get(id)
  if (!cells) return null
  const puzzle = builtinPuzzles.find((p) => p.id === id)
  if (!puzzle) return null
  return {
    puzzleId: puzzle.id,
    width: puzzle.width,
    height: puzzle.height,
    cells: cells.slice(),
    givens: new Array<number>(puzzle.width * puzzle.height).fill(EMPTY),
  }
}

export function puzzleById(id: string): HeyawakePuzzle | undefined {
  return builtinPuzzles.find((p) => p.id === id)
}

export function referenceFor(puzzle: HeyawakePuzzle): number[] | null {
  return asHeyaPuzzle(puzzle).solution ?? solutions.get(puzzle.id) ?? null
}
