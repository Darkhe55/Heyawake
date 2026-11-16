/**
 * 数间（Heyawake）题图识别导入（全自动识图）
 *
 * 用法：
 *   node scripts/import-image.mjs <图片路径> [--width 35 --height 35 | --size 35]
 *        [--name 名称] [--series human] [--append] [--verify] [--map 0=4,3=9] [--dry]
 *        [--thick 5] [--debug 叠加图.png]
 *
 * 流程：
 *   1. Playwright + Edge 打开发图到 canvas，取像素；
 *   2. 投影暗像素找网格线（自动剔除杂线），得到 w×h 与每格中心；
 *   3. 在相邻格边界中点测暗线厚度，用 2-means 自动区分细网格线与粗区域边界；
 *   4. 按粗边界做四连通洪泛 → 区域矩阵；
 *   5. 每格抠墨迹连通块 → 1–2 个数字字形，聚类 + 多字体模板匹配定值（0–9），
 *      再按区域汇总出「每个区域的黑格数」（没有数字的区域记为 -1）；
 *   6. 校验「数字 ≤ 区域格数」，预览区域/线索；
 *   7. --append 写入 src/game/puzzles-data.ts（与现有题库条目同一格式）；
 *   8. --verify 调项目 solver 校验唯一解，算出参考解就一起写入，超时只警告。
 *
 * 已知限制：
 *   - 题板按完整矩形处理（数间的内置题/题图都是矩形）；
 *   - 区域数 > 36 时题面会自动使用 2 字符区域编码（旧格式仍可正常读取）；
 *   - `npm run gen` 会重写 puzzles-data.ts，识图导入的条目会被覆盖；
 *   - 超大棋盘唯一解校验通常超时，此时只写题面、不写参考解。
 */

import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { countSolutions } from '../src/game/solver.ts'
import { initialGrid, isValidSolution, propagate } from '../src/game/rules.ts'
import { encodeBoard, encodeCells } from '../src/game/types.ts'

const S = 20

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

function edgePath() {
  for (const p of EDGE_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  throw new Error('找不到 Edge，请用环境变量 EDGE_PATH 指定 msedge.exe')
}

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const arg = (flag, fallback = null) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback
}

const imageArg = argv.find((a) => !a.startsWith('--'))
if (!imageArg) {
  console.error(
    '用法：node scripts/import-image.mjs <图片路径> [--width N --height N] [--name 名称] [--append] [--verify] [--map 0=4] [--dry] [--thick N] [--debug 输出.png]',
  )
  process.exit(1)
}
const IMAGE = path.resolve(imageArg)
if (!fs.existsSync(IMAGE)) {
  console.error('找不到图片：', IMAGE)
  process.exit(1)
}

const widthOpt = Number(arg('--width', '0')) || 0
const heightOpt = Number(arg('--height', '0')) || 0
const sizeOpt = Number(arg('--size', '0')) || 0
const thickOpt = Number(arg('--thick', '0')) || 0
const append = has('--append')
const verify = has('--verify')
const dry = has('--dry')
const nameOpt = arg('--name')
const series = arg('--series', 'human')
const debugOut = arg('--debug')

const manualMap = {}
{
  const i = argv.findIndex((a) => a === '--map' || a.startsWith('--map='))
  if (i >= 0) {
    const raw = argv[i].startsWith('--map=') ? argv[i].slice(6) : (argv[i + 1] ?? '')
    for (const part of String(raw).split(',')) {
      const [k, v] = part.split('=')
      if (k && v) manualMap[Number(k)] = Number(v)
    }
  }
}

const FONTS = []
for (const weight of ['400', '700']) {
  for (const family of [
    'Arial',
    'Helvetica',
    'Tahoma',
    'Verdana',
    '"Segoe UI"',
    '"Times New Roman"',
    'Georgia',
    'Calibri',
    'Cambria',
    '"Lucida Sans Unicode"',
    '"Trebuchet MS"',
    'Consolas',
    '"DejaVu Sans"',
    '"Liberation Sans"',
  ]) {
    FONTS.push(`${weight} 48px ${family}`)
  }
}

// ───────────────────────── 浏览器侧 ─────────────────────────

const browser = await chromium.launch({ headless: true, executablePath: edgePath() })
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')
const dataUrl = 'data:image/png;base64,' + fs.readFileSync(IMAGE).toString('base64')

const analyzed = await page.evaluate(
  async ({ u, S, widthOpt, heightOpt, sizeOpt, thickOpt }) => {
    const img = new Image()
    img.src = u
    await img.decode()
    const W = img.naturalWidth
    const H = img.naturalHeight
    const cv = document.createElement('canvas')
    cv.width = W
    cv.height = H
    const g = cv.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0)
    const px = g.getImageData(0, 0, W, H).data
    const lum = (x, y) => {
      const i = (y * W + x) * 4
      return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
    }
    const dark = (x, y) => x >= 0 && y >= 0 && x < W && y < H && lum(x, y) < 140

    // —— 网格线 ——
    const colCount = new Int32Array(W)
    const rowCount = new Int32Array(H)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (dark(x, y)) {
          colCount[x]++
          rowCount[y]++
        }
    const clusters = (counts, threshold) => {
      const out = []
      let start = -1
      for (let i = 0; i < counts.length; i++) {
        const on = counts[i] >= threshold
        if (on && start < 0) start = i
        if (!on && start >= 0) {
          let peak = 0
          for (let k = start; k < i; k++) if (counts[k] > peak) peak = counts[k]
          out.push({ center: (start + i - 1) / 2, peak })
          start = -1
        }
      }
      if (start >= 0) {
        let peak = 0
        for (let k = start; k < counts.length; k++) if (counts[k] > peak) peak = counts[k]
        out.push({ center: (start + counts.length - 1) / 2, peak })
      }
      return out
    }
    const median = (list) => {
      const a = list.slice().sort((x, y) => x - y)
      return a.length ? a[Math.floor(a.length / 2)] : 0
    }
    const cleanLines = (raw) => {
      if (raw.length < 2) return raw
      const diffs = []
      for (let i = 1; i < raw.length; i++) diffs.push(raw[i].center - raw[i - 1].center)
      const pitch = median(diffs)
      const out = [raw[0]]
      for (let i = 1; i < raw.length; i++) {
        const prev = out[out.length - 1]
        if (raw[i].center - prev.center < pitch * 0.5) {
          if (raw[i].peak > prev.peak) out[out.length - 1] = raw[i]
          continue
        }
        out.push(raw[i])
      }
      return out
    }
    const xs = cleanLines(clusters(colCount, H * 0.35)).map((c) => c.center)
    const ys = cleanLines(clusters(rowCount, W * 0.35)).map((c) => c.center)
    if (xs.length < 3 || ys.length < 3) {
      throw new Error(`没有识别到完整网格（竖线 ${xs.length}、横线 ${ys.length}）。`)
    }
    const w = xs.length - 1
    const h = ys.length - 1
    const wantW = widthOpt || sizeOpt || 0
    const wantH = heightOpt || sizeOpt || 0
    if ((wantW && wantW !== w) || (wantH && wantH !== h)) {
      throw new Error(
        `网格尺寸不匹配：识别到 ${w}×${h}，指定 ${wantW || w}×${wantH || h}。可用 --width/--height 覆盖。`,
      )
    }
    const cellX = (xs[w] - xs[0]) / w
    const cellY = (ys[h] - ys[0]) / h

    // —— 边界线厚度：细网格线 vs 粗区域边界 ——
    const runX = (cx, cy, radius) => {
      let best = 0
      let run = 0
      for (let x = Math.round(cx - radius); x <= Math.round(cx + radius); x++) {
        if (dark(x, Math.round(cy))) {
          run++
          if (run > best) best = run
        } else run = 0
      }
      return best
    }
    const runY = (cx, cy, radius) => {
      let best = 0
      let run = 0
      for (let y = Math.round(cy - radius); y <= Math.round(cy + radius); y++) {
        if (dark(Math.round(cx), y)) {
          run++
          if (run > best) best = run
        } else run = 0
      }
      return best
    }
    const edgeTX = (ex, ey) => {
      if (ex < 0 || ey < 0 || ex > w || ey >= h) return 0
      const cx = xs[ex]
      const cy = (ys[ey] + ys[ey + 1]) / 2
      const r = cellX * 0.28
      return Math.max(
        runX(cx, cy - cellY * 0.22, r),
        runX(cx, cy, r),
        runX(cx, cy + cellY * 0.22, r),
      )
    }
    const edgeTY = (ex, ey) => {
      if (ey < 0 || ex < 0 || ey > h || ex >= w) return 0
      const cx = (xs[ex] + xs[ex + 1]) / 2
      const cy = ys[ey]
      const r = cellY * 0.28
      return Math.max(
        runY(cx - cellX * 0.22, cy, r),
        runY(cx, cy, r),
        runY(cx + cellX * 0.22, cy, r),
      )
    }
    const vRuns = []
    const hRuns = []
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) vRuns.push(edgeTX(x, y))
    for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) hRuns.push(edgeTY(x, y))
    const allRuns = [...vRuns, ...hRuns]
    const sorted = allRuns.slice().sort((a, b) => a - b)
    let c1 = sorted[0]
    let c2 = sorted[sorted.length - 1]
    for (let it = 0; it < 40; it++) {
      let s1 = 0
      let n1 = 0
      let s2 = 0
      let n2 = 0
      for (const v of allRuns) {
        if (Math.abs(v - c1) <= Math.abs(v - c2)) {
          s1 += v
          n1++
        } else {
          s2 += v
          n2++
        }
      }
      if (n1) c1 = s1 / n1
      if (n2) c2 = s2 / n2
    }
    const thick =
      thickOpt > 0
        ? thickOpt
        : Math.max(1.5, Math.min(cellX, cellY) * 0.03, (c1 + c2) / 2, sorted[sorted.length - 1] * 0.5)

    // —— 区域洪泛 ——
    const vWall = Array.from({ length: w }, () => new Uint8Array(h))
    const hWall = Array.from({ length: h }, () => new Uint8Array(w))
    for (let y = 0; y < h; y++)
      for (let x = 1; x < w; x++) if (edgeTX(x, y) >= thick) vWall[x][y] = 1
    for (let y = 1; y < h; y++)
      for (let x = 0; x < w; x++) if (edgeTY(x, y) >= thick) hWall[y][x] = 1
    const regions = new Array(w * h).fill(-1)
    let next = 0
    for (let start = 0; start < w * h; start++) {
      if (regions[start] !== -1) continue
      const id = next++
      regions[start] = id
      const stack = [start]
      while (stack.length) {
        const i = stack.pop()
        const x = i % w
        const y = (i / w) | 0
        const push = (j) => {
          if (j >= 0 && j < w * h && regions[j] === -1) {
            regions[j] = id
            stack.push(j)
          }
        }
        if (x > 0 && !vWall[x][y]) push(i - 1)
        if (x + 1 < w && !vWall[x + 1][y]) push(i + 1)
        if (y > 0 && !hWall[y][x]) push(i - w)
        if (y + 1 < h && !hWall[y + 1][x]) push(i + w)
      }
    }
    const sizes = new Array(next).fill(0)
    for (const r of regions) sizes[r]++

    // —— 每格墨迹连通块 → 数字字形 ——
    const small = document.createElement('canvas')
    small.width = S
    small.height = S
    const sg = small.getContext('2d', { willReadFrequently: true })
    sg.imageSmoothingEnabled = true
    const normGlyph = (bx, by, bw, bh) => {
      const sw = Math.max(1, Math.round((bw * S) / bh))
      sg.fillStyle = '#fff'
      sg.fillRect(0, 0, S, S)
      sg.drawImage(cv, bx, by, bw, bh, Math.floor((S - sw) / 2), 0, sw, S)
      const sd = sg.getImageData(0, 0, S, S).data
      const out = new Array(S * S)
      for (let i = 0; i < S * S; i++) out[i] = 255 - sd[i * 4]
      return out
    }
    const cells = []
    const dropped = []
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        const cw = xs[cx + 1] - xs[cx]
        const ch = ys[cy + 1] - ys[cy]
        const bx0 = Math.round(xs[cx] + cw * 0.14)
        const bx1 = Math.round(xs[cx + 1] - cw * 0.14)
        const by0 = Math.round(ys[cy] + ch * 0.12)
        const by1 = Math.round(ys[cy + 1] - ch * 0.12)
        const bw = bx1 - bx0 + 1
        const bh = by1 - by0 + 1
        if (bw < 4 || bh < 6) {
          cells.push([])
          continue
        }
        const seen = new Uint8Array(bw * bh)
        const comps = []
        for (let j = 0; j < bh; j++) {
          for (let i = 0; i < bw; i++) {
            if (seen[j * bw + i] || lum(bx0 + i, by0 + j) >= 170) continue
            const stack = [[i, j]]
            seen[j * bw + i] = 1
            let mnx = i
            let mxx = i
            let mny = j
            let mxy = j
            let area = 0
            while (stack.length) {
              const [ci, cj] = stack.pop()
              area++
              if (ci < mnx) mnx = ci
              if (ci > mxx) mxx = ci
              if (cj < mny) mny = cj
              if (cj > mxy) mxy = cj
              for (const [di, dj] of [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
              ]) {
                const ni = ci + di
                const nj = cj + dj
                if (ni < 0 || nj < 0 || ni >= bw || nj >= bh) continue
                if (seen[nj * bw + ni] || lum(bx0 + ni, by0 + nj) >= 170) continue
                seen[nj * bw + ni] = 1
                stack.push([ni, nj])
              }
            }
            comps.push({ x: bx0 + mnx, y: by0 + mny, w: mxx - mnx + 1, h: mxy - mny + 1, area })
          }
        }
        const digits = comps
          .filter((c) => c.h >= ch * 0.22 && c.w >= 2 && c.area >= 6)
          .sort((a, b) => a.x - b.x)
        if (digits.length > 2) dropped.push({ cx, cy, n: digits.length })
        cells.push(
          digits.slice(0, 2).map((d) => ({ m: normGlyph(d.x, d.y, d.w, d.h), aspect: d.w / d.h })),
        )
      }
    }
    return {
      W,
      H,
      w,
      h,
      xs,
      ys,
      regions,
      vWalls: vWall.map((col) => Array.from(col)),
      hWalls: hWall.map((row) => Array.from(row)),
      regionCount: next,
      minSize: Math.min(...sizes),
      maxSize: Math.max(...sizes),
      thick: Number(thick.toFixed(2)),
      cells,
      dropped,
    }
  },
  { u: dataUrl, S, widthOpt, heightOpt, sizeOpt, thickOpt },
)

// —— 数字模板 0–9 ——
const templates = await page.evaluate(
  ({ fonts, S }) => {
    const c = document.createElement('canvas')
    c.width = 240
    c.height = 120
    const g = c.getContext('2d', { willReadFrequently: true })
    const make = (text, font) => {
      g.fillStyle = '#fff'
      g.fillRect(0, 0, 240, 120)
      g.fillStyle = '#000'
      g.font = font
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(text, 120, 60)
      const d = g.getImageData(0, 0, 240, 120).data
      let ax = 240
      let bx = -1
      let ay = 120
      let by = -1
      for (let y = 0; y < 120; y++)
        for (let x = 0; x < 240; x++)
          if (d[(y * 240 + x) * 4] < 128) {
            if (x < ax) ax = x
            if (x > bx) bx = x
            if (y < ay) ay = y
            if (y > by) by = y
          }
      if (bx < ax) return null
      const bw = bx - ax + 1
      const bh = by - ay + 1
      const t = document.createElement('canvas')
      t.width = S
      t.height = S
      const tg = t.getContext('2d', { willReadFrequently: true })
      tg.imageSmoothingEnabled = true
      tg.fillStyle = '#fff'
      tg.fillRect(0, 0, S, S)
      const sw = Math.max(1, Math.round((bw * S) / bh))
      tg.drawImage(c, ax, ay, bw, bh, Math.floor((S - sw) / 2), 0, sw, S)
      const td = tg.getImageData(0, 0, S, S).data
      const out = new Array(S * S)
      for (let i = 0; i < S * S; i++) out[i] = 255 - td[i * 4]
      return out
    }
    const out = {}
    for (let v = 0; v <= 9; v++) {
      out[v] = {}
      for (const font of fonts) out[v][font] = make(String(v), font)
    }
    return out
  },
  { fonts: FONTS, S },
)
// —— 可选：导出识别叠加图，便于核对区域/线索 ——
if (debugOut) {
  const debugPath = path.resolve(debugOut)
  const png = await page.evaluate(
    ({ u, w, h, xs, ys, regions, vWalls, hWalls }) => {
      const img = new Image()
      img.src = u
      return new Promise((resolve) => {
        img.onload = () => {
          const cv = document.createElement('canvas')
          cv.width = img.naturalWidth
          cv.height = img.naturalHeight
          const g = cv.getContext('2d')
          g.drawImage(img, 0, 0)
          const palette = [
            'rgba(255,0,0,0.18)',
            'rgba(0,120,255,0.18)',
            'rgba(0,180,0,0.18)',
            'rgba(255,140,0,0.18)',
            'rgba(160,0,200,0.18)',
            'rgba(0,180,180,0.18)',
            'rgba(200,180,0,0.18)',
            'rgba(120,80,0,0.18)',
          ]
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const r = regions[y * w + x]
              g.fillStyle = palette[r % palette.length]
              g.fillRect(xs[x], ys[y], xs[x + 1] - xs[x], ys[y + 1] - ys[y])
            }
          }
          g.strokeStyle = 'rgba(255,0,0,0.85)'
          g.lineWidth = 2
          for (let y = 0; y < h; y++) {
            for (let x = 0; x <= w; x++) {
              if (x > 0 && x < w && !vWalls[x][y]) continue
              const cx = xs[x]
              g.beginPath()
              g.moveTo(cx, ys[y])
              g.lineTo(cx, ys[y + 1])
              g.stroke()
            }
          }
          for (let y = 0; y <= h; y++) {
            for (let x = 0; x < w; x++) {
              if (y > 0 && y < h && !hWalls[y][x]) continue
              const cy = ys[y]
              g.beginPath()
              g.moveTo(xs[x], cy)
              g.lineTo(xs[x + 1], cy)
              g.stroke()
            }
          }
          resolve(cv.toDataURL('image/png'))
        }
      })
    },
    {
      u: dataUrl,
      w: analyzed.w,
      h: analyzed.h,
      xs: analyzed.xs,
      ys: analyzed.ys,
      regions: analyzed.regions,
      vWalls: analyzed.vWalls,
      hWalls: analyzed.hWalls,
    },
  )
  fs.writeFileSync(debugPath, Buffer.from(png.split(',')[1], 'base64'))
  console.log(`[import] 已导出区域/边界叠加图：${debugPath}`)
}

await browser.close()

// ───────────────────────── Node 侧 ─────────────────────────

const { w, h, regions, cells } = analyzed
const size = w * h
const regionCount = analyzed.regionCount
const sizes = new Array(regionCount).fill(0)
for (const r of regions) sizes[r]++

function dist(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / (a.length * 255)
}

const glyphs = []
for (let i = 0; i < size; i++) {
  const list = cells[i] ?? []
  list.forEach((gl, order) => glyphs.push({ cell: i, order, m: gl.m }))
}

function clusterGlyphs(list, threshold = 0.055) {
  const clusters = []
  for (const gl of list) {
    let best = -1
    let bd = Infinity
    for (let k = 0; k < clusters.length; k++) {
      const d = dist(clusters[k].sum, gl.m)
      if (d < bd) {
        bd = d
        best = k
      }
    }
    if (best >= 0 && bd <= threshold) {
      const c = clusters[best]
      c.items.push(gl)
      const n = c.items.length
      for (let i = 0; i < c.sum.length; i++) c.sum[i] = (c.sum[i] * (n - 1) + gl.m[i]) / n
    } else {
      clusters.push({ sum: Float32Array.from(gl.m), items: [gl] })
    }
  }
  for (let round = 0; round < 3; round++) {
    for (const c of clusters) c.items = []
    for (const gl of list) {
      let best = 0
      let bd = Infinity
      for (let k = 0; k < clusters.length; k++) {
        const d = dist(clusters[k].sum, gl.m)
        if (d < bd) {
          bd = d
          best = k
        }
      }
      clusters[best].items.push(gl)
    }
    for (const c of clusters) {
      if (!c.items.length) continue
      const sum = new Float32Array(S * S)
      for (const gl of c.items) for (let i = 0; i < sum.length; i++) sum[i] += gl.m[i]
      for (let i = 0; i < sum.length; i++) sum[i] /= c.items.length
      c.sum = sum
    }
  }
  return clusters.filter((c) => c.items.length > 0)
}

let live = clusterGlyphs(glyphs)

const sim = (a, b) => {
  let inter = 0
  let uni = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i] > 127 ? 1 : 0
    const bv = b[i] > 127 ? 1 : 0
    if (av && bv) inter++
    if (av || bv) uni++
  }
  return uni ? inter / uni : 0
}

const parent = live.map((_, i) => i)
const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
for (let i = 0; i < live.length; i++) {
  for (let j = i + 1; j < live.length; j++) {
    if (dist(live[i].sum, live[j].sum) < 0.035) {
      const a = find(i)
      const b = find(j)
      if (a !== b) parent[b] = a
    }
  }
}
const merged = new Map()
for (let i = 0; i < live.length; i++) {
  const r = find(i)
  if (!merged.has(r)) merged.set(r, [])
  merged.get(r).push(i)
}
const info = [...merged.values()].map((members) => {
  const sum = new Float32Array(S * S)
  let count = 0
  for (const i of members) {
    for (const gl of live[i].items) {
      for (let k = 0; k < sum.length; k++) sum[k] += gl.m[k]
      count++
    }
  }
  for (let k = 0; k < sum.length; k++) sum[k] /= Math.max(1, count)
  const ranked = []
  for (let v = 0; v <= 9; v++) {
    let best = 0
    for (const f of FONTS) {
      const t = templates[v][f]
      if (!t) continue
      const sc = sim(sum, t)
      if (sc > best) best = sc
    }
    ranked.push({ v, score: best })
  }
  ranked.sort((a, b) => b.score - a.score)
  return { members, size: count, ranked }
})
info.sort((a, b) => b.size - a.size)

const digits = new Array(info.length).fill(-1)
for (const [k, v] of Object.entries(manualMap)) {
  const ki = Number(k)
  if (!Number.isInteger(ki) || ki < 0 || ki >= info.length) {
    console.warn(`[import] --map 里的簇号 ${k} 不存在（有效范围 0–${info.length - 1}）。`)
    continue
  }
  digits[ki] = Number(v)
}
for (let k = 0; k < info.length; k++) if (digits[k] < 0) digits[k] = info[k].ranked[0].v

console.log(
  `[import] ${path.basename(IMAGE)}：${analyzed.W}×${analyzed.H}px，网格 ${w}×${h}，` +
    `区域 ${regionCount} 个（${analyzed.minSize}–${analyzed.maxSize} 格），粗线阈值 ${analyzed.thick}px，` +
    `字形 ${glyphs.length} 个 → ${info.length} 簇`,
)
for (let k = 0; k < info.length; k++) {
  const [first, second] = info[k].ranked
  console.log(
    `  簇${String(k).padStart(2)} → 数字 ${digits[k]}（${manualMap[k] !== undefined ? '人工' : '模板'}，` +
      `n=${String(info[k].size).padStart(4)}，得分 ${first.score.toFixed(2)}，次佳 ${second.v}=${second.score.toFixed(2)}）`,
  )
}

// 每格识别出的数字
const cellDigits = Array.from({ length: size }, () => [])
const cellConfidence = new Float64Array(size).fill(1)
for (let k = 0; k < info.length; k++) {
  const margin = info[k].ranked[0].score - info[k].ranked[1].score
  for (const ci of info[k].members) {
    for (const it of live[ci].items) {
      cellDigits[it.cell][it.order] = digits[k]
      cellConfidence[it.cell] = Math.min(cellConfidence[it.cell], margin)
    }
  }
}
const cellValue = new Array(size).fill(-1) // -1 = 该格没有数字
for (let i = 0; i < size; i++) {
  const list = cellDigits[i]
  if (!list.length) continue
  let v = 0
  let ok = true
  for (const d of list) {
    if (d === undefined || d < 0) {
      ok = false
      break
    }
    v = v * 10 + d
  }
  if (ok) cellValue[i] = v
}

// 按区域汇总线索
const clues = new Array(regionCount).fill(-1)
const conflictRegions = []
for (let r = 0; r < regionCount; r++) {
  const candidates = []
  for (let i = 0; i < size; i++) {
    if (regions[i] !== r) continue
    if (cellValue[i] >= 0) candidates.push(i)
  }
  if (!candidates.length) continue
  if (candidates.length === 1) {
    clues[r] = cellValue[candidates[0]]
    continue
  }
  // 同一区域出现多个数字：值相同就取用，否则取置信度最高的
  const values = candidates.map((i) => cellValue[i])
  if (values.every((v) => v === values[0])) {
    clues[r] = values[0]
  } else {
    let best = candidates[0]
    for (const i of candidates) if (cellConfidence[i] > cellConfidence[best]) best = i
    clues[r] = cellValue[best]
    conflictRegions.push({ r, cells: candidates, values })
  }
}

// 线索合法性：数字不能超过区域格数
const badClues = []
for (let r = 0; r < regionCount; r++) {
  if (clues[r] > sizes[r]) {
    badClues.push({ r, clue: clues[r], size: sizes[r] })
    clues[r] = -1
  }
}

// —— 预览 ——
const clueCount = clues.reduce((a, v) => a + (v >= 0 ? 1 : 0), 0)
const pad2 = String(Math.max(9, analyzed.maxSize)).length + 1
console.log(`\n识别区域 ${regionCount} 个，线索 ${clueCount} 个`)
console.log('线索图（. = 该格没有数字，? = 有数字但识别失败）：')
for (let y = 0; y < h; y++) {
  const row = []
  for (let x = 0; x < w; x++) {
    const i = y * w + x
    const v = cellValue[i]
    row.push((v >= 0 ? String(v) : '.'.padStart(0)).padStart(pad2))
  }
  console.log(String(y + 1).padStart(2) + ' |' + row.join(''))
}
console.log('区域图（每格 2 字符区域号）：')
for (let y = 0; y < h; y++) {
  const row = []
  for (let x = 0; x < w; x++) row.push(String(regions[y * w + x]).padStart(2, '0'))
  console.log(String(y + 1).padStart(2) + ' |' + row.join(' '))
}

if (conflictRegions.length) {
  console.warn(
    `[import] ${conflictRegions.length} 个区域里有多个不同数字（识别可能有误），已取置信度最高的：` +
      conflictRegions
        .slice(0, 8)
        .map((c) => `区域${c.r}[${c.values.join('/')}]`)
        .join(' '),
  )
}
if (badClues.length) {
  console.warn(
    `[import] ${badClues.length} 个区域数字大于区域格数，已置为无数字：` +
      badClues
        .slice(0, 8)
        .map((b) => `区域${b.r} 数字${b.clue}>${b.size}格`)
        .join(' '),
  )
}
if (analyzed.minSize < 1) console.warn('[import] 存在 0 格区域，区域识别可能有问题。')
for (const d of analyzed.dropped ?? []) {
  console.warn(`[import] 格 (${d.cx + 1},${d.cy + 1}) 有 ${d.n} 个墨迹块，可能粘连，已按前 2 个处理。`)
}
const lowConfidence = info
  .map((it, k) => ({ k, margin: it.ranked[0].score - it.ranked[1].score, score: it.ranked[0].score }))
  .filter((x) => x.margin < 0.12 || x.score < 0.6)
if (lowConfidence.length) {
  console.warn(
    `[import] 这些字形簇置信度偏低，识别有误可用 --map 修正：` +
      lowConfidence.map((x) => `簇${x.k}(${x.score.toFixed(2)}/${x.margin.toFixed(2)})`).join(' '),
  )
}
if (!clueCount) {
  console.error('[import] 没有识别到任何区域数字，无法作为数间题目。')
  process.exit(1)
}

if (dry) {
  console.log('\n[import] --dry：只识别预览，不校验唯一解、不写入。')
  process.exit(0)
}

// —— 可选：唯一解 / 参考解 ——
function searchSolution(maxNodes) {
  const grid = initialGrid(size)
  let nodes = 0
  let timedOut = false
  const dfs = () => {
    if (timedOut) return null
    nodes++
    if (nodes > maxNodes) {
      timedOut = true
      return null
    }
    if (!propagate(grid, regions, clues, w, h)) return null
    let choice = -1
    let bestScore = -1
    for (let i = 0; i < size; i++) {
      if (grid[i] !== 0) continue
      const x = i % w
      const y = (i / w) | 0
      let score = 0
      if (x > 0 && grid[i - 1] !== 0) score++
      if (x + 1 < w && grid[i + 1] !== 0) score++
      if (y > 0 && grid[i - w] !== 0) score++
      if (y + 1 < h && grid[i + w] !== 0) score++
      if (score > bestScore) {
        bestScore = score
        choice = i
      }
    }
    if (choice < 0) {
      if (isValidSolution(grid, regions, clues, w, h)) return Array.from(grid)
      return null
    }
    const backup = Array.from(grid)
    for (const value of [1, 2]) {
      grid[choice] = value
      const found = dfs()
      if (found) return found
      for (let i = 0; i < size; i++) grid[i] = backup[i]
      if (timedOut) return null
    }
    return null
  }
  const solution = dfs()
  return { solution, nodes, timedOut }
}

let solution = ''
if (verify) {
  const t0 = Date.now()
  const budget = size > 400 ? 120_000 : 400_000
  const counted = countSolutions(regions, clues, size, w, h, 2, budget)
  if (counted.timedOut) {
    console.warn(
      `[import] 唯一解校验超时（${counted.nodes} 节点，${Date.now() - t0}ms），只作警告，不写参考解。`,
    )
  } else if (counted.count === 0) {
    console.warn('[import] 当前区域/数字无解，识别可能有误（可用 --map 修正）。')
  } else if (counted.count > 1) {
    console.warn(`[import] 解不唯一（${counted.count} 个），识别可能有误或题面本身不唯一。`)
  } else {
    const found = searchSolution(budget)
    if (found.solution) {
      solution = encodeCells(found.solution)
      console.log(
        `[import] 唯一解校验通过（${counted.nodes} 节点，${Date.now() - t0}ms），已生成参考解。`,
      )
    } else {
      console.warn('[import] 唯一解存在但求参考解超时，未写入参考解。')
    }
  }
}

if (!append) {
  console.log('\n[import] 预览模式（未写入）。加 --append 写入 src/game/puzzles-data.ts。')
  process.exit(0)
}

// —— 写入题库 ——
const id = arg('--id', `heyawake-img-${w}x${h}-${Date.now().toString(36)}`)
const name = nameOpt || `识图 · ${w}×${h}`
const board = encodeBoard(regions, clues)
const entry =
  `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, width: ${w}, height: ${h}, ` +
  `difficulty: 'hard', series: ${JSON.stringify(series)}, board: ${JSON.stringify(board)}, ` +
  `solution: ${JSON.stringify(solution)} },\n`
const dataFile = path.resolve('src/game/puzzles-data.ts')
let text = fs.readFileSync(dataFile, 'utf8').replace(/\r\n/g, '\n')
const marker = text.lastIndexOf('\n]')
if (marker < 0) throw new Error('puzzles-data.ts 格式异常：找不到结尾 ]')
text = text.slice(0, marker + 1) + '\n' + entry + text.slice(marker + 1)
fs.writeFileSync(dataFile, text)
console.log(`[import] 已写入 src/game/puzzles-data.ts：${id} ${name}`)
