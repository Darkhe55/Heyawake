/* 自动生成，勿手改。运行 npm run gen 重新生成。 */
export interface RawPuzzle {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy' | 'medium' | 'hard' | 'custom'
  series: string
  /** 题面编码串（格式由 src/game/puzzles.ts 解析） */
  board: string
  /** 参考解编码串（没有则留空） */
  solution?: string
}

export const RAW_PUZZLES: RawPuzzle[] = [
  { id: "heyawake-6x6-k1w5xd", name: "初识数间", width: 6, height: 6, difficulty: 'easy', series: "入门", board: "50d9270011230011220a81220611220fcbe4|03010202020202010202010201010101", solution: "122122212221222212221222212222122121" },
  { id: "heyawake-7x7-k1w5xe", name: "七间回廊", width: 7, height: 7, difficulty: 'easy', series: "入门", board: "0hj4ln3000111580eo71600ma11b0di11c20k9111200p11fg|0202010202010102020202020202020201020101010101010101", solution: "2121221222221212121222221221212221222122222122212" },
  { id: "heyawake-8x8-k1w5xf", name: "白线穿房", width: 8, height: 8, difficulty: 'medium', series: "进阶", board: "00o1c1j40me11122070b1152000111g2ka0h11d280011622i001112390f11l2n|02030202020202020202020202020202010201010102010101", solution: "2122122122122222212122122222122121212212122221222221222112122122" },
  { id: "heyawake-8x8-k1w5xg", name: "黑格迷间", width: 8, height: 8, difficulty: 'medium', series: "进阶", board: "090111220001a122400c11e200g111220h01512b00061122800111220003f72d|030203020202020202020202020202010202", solution: "2122221222121222122122122212212221221221222122121212222222212121" },
  { id: "heyawake-8x8-k1w5xh", name: "十间叠影", width: 8, height: 8, difficulty: 'hard', series: "挑战", board: "00utsr220jq11a2f00d1112230015i2706011b2l0004112c0hp1182g00oemkn9|01010102020202020202020202020102010201020101020102010101020102", solution: "2212122221222121221222221222122121222122222122212122212222121221" },
  { id: "heyawake-8x8-k1w5xi", name: "数间终局", width: 8, height: 8, difficulty: 'hard', series: "挑战", board: "0l0119a4000111220g0kh162000811f2b0d11j22000151230701112ce00i1122|01030302020202020202010201020201020202010102", solution: "2122212122212222212212122221212212122212222212212122221212212222" },
]
