// lines.ts の純粋なロジック（罫線検出・線形インペイントによる除去・内側詰め）を検証する。
// stripes.test.ts と同様、canvas / ImageData には一切触れず、合成した数値配列だけで
// 判定ロジックを固定する。

import { describe, expect, it } from 'vitest'
import {
  computeInnerCrop,
  detectRuledCols,
  detectRuledLines,
  detectRuledRows,
  inpaintRuledLines,
  longestDarkRun,
  MAX_RULED_LINE_THICKNESS_PX,
} from '../lines'

// w×h のグレースケール配列を作る。fill を敷いた上で、指定した行・列を暗い値で上書きする。
function grid(w: number, h: number, fill: number): Uint8ClampedArray {
  return new Uint8ClampedArray(w * h).fill(fill)
}

function setRow(gray: Uint8ClampedArray, w: number, y: number, value: number): void {
  for (let x = 0; x < w; x++) gray[y * w + x] = value
}

function setCol(gray: Uint8ClampedArray, w: number, h: number, x: number, value: number): void {
  for (let y = 0; y < h; y++) gray[y * w + x] = value
}

describe('longestDarkRun', () => {
  it('連続する暗画素の最長ランを返す', () => {
    // 明るい(200)の中に、暗い(10)の連続が2箇所: 長さ3と長さ5
    const line = [200, 10, 10, 10, 200, 10, 10, 10, 10, 10, 200]
    const result = longestDarkRun(line, 96)
    expect(result).toEqual({ start: 5, length: 5 })
  })

  it('暗い画素が無ければ長さ0を返す', () => {
    expect(longestDarkRun([200, 210, 220], 96)).toEqual({ start: 0, length: 0 })
  })

  it('空配列・NaN混じりでも例外を投げない', () => {
    expect(() => longestDarkRun([], 96)).not.toThrow()
    expect(longestDarkRun([], 96)).toEqual({ start: 0, length: 0 })
    expect(() => longestDarkRun([Number.NaN, Number.NaN], 96)).not.toThrow()
    expect(longestDarkRun([Number.NaN, Number.NaN], 96)).toEqual({ start: 0, length: 0 })
  })
})

describe('detectRuledRows / detectRuledCols / detectRuledLines', () => {
  it('幅の6割以上を横切る暗い横罫線を検出し、短い文字幅の暗画素は検出しない', () => {
    const w = 20
    const h = 10
    const gray = grid(w, h, 220) // 明るい背景
    setRow(gray, w, 5, 10) // 罫線: 幅全体（20px）が暗い → 罫線行

    // 文字らしい短い暗画素の並び（幅7px、20pxの35% < 60%のしきい値）は罫線扱いされない
    for (let x = 2; x < 9; x++) gray[2 * w + x] = 10

    const rows = detectRuledRows(gray, w, h)
    expect(rows.map((r) => r.index)).toEqual([5])
    expect(rows[0].runLength).toBe(w)
  })

  it('高さの6割以上を縦断する暗い縦罫線を検出する', () => {
    const w = 10
    const h = 20
    const gray = grid(w, h, 220)
    setCol(gray, w, h, 3, 10)

    const cols = detectRuledCols(gray, w, h)
    expect(cols.map((c) => c.index)).toEqual([3])
    expect(cols[0].runLength).toBe(h)
  })

  it('表のマス目（横罫線と縦罫線の両方）を同時に検出できる', () => {
    const w = 20
    const h = 20
    const gray = grid(w, h, 220)
    setRow(gray, w, 0, 10)
    setRow(gray, w, 19, 10)
    setCol(gray, w, h, 0, 10)
    setCol(gray, w, h, 19, 10)

    const lines = detectRuledLines(gray, w, h)
    expect(lines.rows.map((r) => r.index)).toEqual([0, 19])
    expect(lines.cols.map((c) => c.index)).toEqual([0, 19])
  })

  it('罫線が全く無ければ空配列を返す', () => {
    const gray = grid(30, 30, 200)
    const lines = detectRuledLines(gray, 30, 30)
    expect(lines.rows).toEqual([])
    expect(lines.cols).toEqual([])
  })

  it('空配列・幅/高さ0・NaNでも例外を投げない', () => {
    expect(() => detectRuledRows(new Uint8ClampedArray(0), 0, 0)).not.toThrow()
    expect(detectRuledRows(new Uint8ClampedArray(0), 0, 0)).toEqual([])
    expect(() => detectRuledLines(grid(5, 5, 100), Number.NaN, Number.NaN)).not.toThrow()
    expect(detectRuledLines(grid(5, 5, 100), Number.NaN, Number.NaN)).toEqual({ rows: [], cols: [] })
  })

  it('全画素同色（退化した入力）でも罫線扱いにならない場合がある（背景と同じ明るさなら暗くないため）', () => {
    const gray = grid(10, 10, 200)
    expect(detectRuledLines(gray, 10, 10)).toEqual({ rows: [], cols: [] })
  })

  it('全画素が暗い同色の場合は、全行・全列が罫線判定される', () => {
    const gray = grid(10, 10, 0)
    const lines = detectRuledLines(gray, 10, 10)
    expect(lines.rows.length).toBe(10)
    expect(lines.cols.length).toBe(10)
  })
})

describe('inpaintRuledLines', () => {
  it('罫線行を直上・直下の非罫線行から線形補間して埋める', () => {
    const w = 4
    const h = 5
    const gray = new Uint8ClampedArray(w * h)
    setRow(gray, w, 0, 50)
    setRow(gray, w, 1, 100)
    setRow(gray, w, 2, 0) // 罫線（本来は補間で消えてほしい）
    setRow(gray, w, 3, 150)
    setRow(gray, w, 4, 200)

    const out = inpaintRuledLines(gray, w, h, [2], [])
    // 行1(100) と 行3(150) のちょうど中間 = 125 になるはず
    for (let x = 0; x < w; x++) {
      expect(out[2 * w + x]).toBe(125)
    }
    // 罫線でない行は変化しない
    for (let x = 0; x < w; x++) {
      expect(out[1 * w + x]).toBe(100)
      expect(out[3 * w + x]).toBe(150)
    }
    // 入力配列そのものは書き換えない（純粋関数）
    expect(gray[2 * w]).toBe(0)
  })

  it('罫線列を左右の非罫線列から線形補間して埋める', () => {
    const w = 5
    const h = 3
    const gray = new Uint8ClampedArray(w * h)
    for (let y = 0; y < h; y++) {
      gray[y * w + 0] = 50
      gray[y * w + 1] = 100
      gray[y * w + 2] = 0 // 罫線
      gray[y * w + 3] = 150
      gray[y * w + 4] = 200
    }

    const out = inpaintRuledLines(gray, w, h, [], [2])
    for (let y = 0; y < h; y++) {
      expect(out[y * w + 2]).toBe(125)
    }
  })

  it('安全弁: 太すぎる帯（MAX_RULED_LINE_THICKNESS_PX超過）は補間せず諦める', () => {
    const w = 4
    const h = 12
    const gray = new Uint8ClampedArray(w * h).fill(200)
    const thickRun: number[] = []
    for (let y = 2; y < 2 + MAX_RULED_LINE_THICKNESS_PX + 1; y++) {
      setRow(gray, w, y, 0)
      thickRun.push(y)
    }

    const out = inpaintRuledLines(gray, w, h, thickRun, [])
    // 太すぎるため何も変わらない（暗いまま）
    for (const y of thickRun) {
      expect(out[y * w]).toBe(0)
    }
  })

  it('安全弁: 画像端に接していて片側にしか補間元が無い場合は諦める', () => {
    const w = 4
    const h = 5
    const gray = new Uint8ClampedArray(w * h).fill(150)
    setRow(gray, w, 0, 0) // 上端に接する罫線 → 直上の非罫線行が存在しない

    const out = inpaintRuledLines(gray, w, h, [0], [])
    expect(out[0]).toBe(0) // 変化しない
  })

  it('空配列・幅/高さ0でも例外を投げない', () => {
    expect(() => inpaintRuledLines(new Uint8ClampedArray(0), 0, 0, [], [])).not.toThrow()
    expect(() => inpaintRuledLines(new Uint8ClampedArray(9), 3, 3, [Number.NaN], [])).not.toThrow()
  })
})

describe('computeInnerCrop', () => {
  it('外周の罫線（表の枠）に接する分だけ内側に詰める', () => {
    const rect = computeInnerCrop(10, 10, [0, 1], [0, 1])
    expect(rect).toEqual({ x: 2, y: 2, w: 8, h: 8 })
  })

  it('内部だけの罫線（外周に接しない）はトリム対象にしない', () => {
    // 行5だけが罫線扱いでも、上端(0)・下端(9)自体は罫線ではないためトリムされない
    const rect = computeInnerCrop(10, 10, [5], [])
    expect(rect).toEqual({ x: 0, y: 0, w: 10, h: 10 })
  })

  it('下限（MIN_INNER_CROP_RETAIN_RATIO）を超えて削り込まない', () => {
    // 上端から6行(0..5)が罫線判定という極端なケース。そのまま詰めると
    // 高さ10のうち6を失い、保持率0.7の下限（最大3までしか削れない）を超えるため、
    // 比例的に縮小されて3までしか詰めない
    const rect = computeInnerCrop(10, 10, [0, 1, 2, 3, 4, 5], [])
    expect(rect.y).toBe(3)
    expect(rect.h).toBe(7)
  })

  it('全行・全列が罫線判定される退化ケースでは、安全側に倒してトリムしない', () => {
    const allRows = Array.from({ length: 10 }, (_, i) => i)
    const rect = computeInnerCrop(10, 10, allRows, [])
    expect(rect).toEqual({ x: 0, y: 0, w: 10, h: 10 })
  })

  it('幅/高さ0・NaNでも例外を投げない', () => {
    expect(() => computeInnerCrop(0, 0, [], [])).not.toThrow()
    expect(computeInnerCrop(0, 0, [], [])).toEqual({ x: 0, y: 0, w: 0, h: 0 })
    expect(() => computeInnerCrop(Number.NaN, Number.NaN, [1, 2], [1, 2])).not.toThrow()
  })
})
