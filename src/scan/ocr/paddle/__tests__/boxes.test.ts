import { describe, expect, it } from 'vitest'
import { binarizeMask, labelConnectedComponents, postprocessDetection } from '../boxes'

describe('binarizeMask', () => {
  it('閾値以上を1、未満を0にする', () => {
    const out = binarizeMask([0.1, 0.3, 0.29, 0.9], 0.3)
    expect(Array.from(out)).toEqual([0, 1, 0, 1])
  })

  it('空配列でも例外を投げない', () => {
    expect(() => binarizeMask([], 0.3)).not.toThrow()
    expect(binarizeMask([]).length).toBe(0)
  })
})

// width x height の平面インデックス上に矩形を書き込むテスト用ヘルパー
function fillRect(binary: Uint8Array, width: number, x0: number, y0: number, x1: number, y1: number, value: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      binary[y * width + x] = value
    }
  }
}

describe('labelConnectedComponents', () => {
  it('離れた2つの矩形をそれぞれ別の成分として検出する', () => {
    const width = 10
    const height = 10
    const binary = new Uint8Array(width * height)
    fillRect(binary, width, 0, 0, 1, 1, 1) // 2x2
    fillRect(binary, width, 5, 5, 7, 8, 1) // 3x4
    const boxes = labelConnectedComponents(binary, width, height, 8)
    expect(boxes.length).toBe(2)
    const small = boxes.find((b) => b.minX === 0)
    const large = boxes.find((b) => b.minX === 5)
    expect(small).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1, pixelCount: 4 })
    expect(large).toEqual({ minX: 5, minY: 5, maxX: 7, maxY: 8, pixelCount: 12 })
  })

  it('8近傍では斜めにしか繋がっていない2画素も同じ成分とみなす', () => {
    const width = 4
    const height = 4
    const binary = new Uint8Array(width * height)
    binary[0] = 1 // (0,0)
    binary[1 * width + 1] = 1 // (1,1) 斜め隣接
    const boxes8 = labelConnectedComponents(binary, width, height, 8)
    expect(boxes8.length).toBe(1)

    const boxes4 = labelConnectedComponents(binary, width, height, 4)
    expect(boxes4.length).toBe(2)
  })

  it('全て0の入力は空配列を返す', () => {
    const binary = new Uint8Array(16)
    expect(labelConnectedComponents(binary, 4, 4)).toEqual([])
  })

  it('width/heightが0以下、データが不足している等の退化した入力でも例外を投げない', () => {
    expect(() => labelConnectedComponents(new Uint8Array(4), 0, 4)).not.toThrow()
    expect(labelConnectedComponents(new Uint8Array(4), 0, 4)).toEqual([])
    expect(() => labelConnectedComponents(new Uint8Array(2), 4, 4)).not.toThrow()
    expect(labelConnectedComponents(new Uint8Array(2), 4, 4)).toEqual([])
  })
})

describe('postprocessDetection', () => {
  it('小さすぎる成分をminSidePxで除外し、閾値を超えた成分だけをスケール変換して返す', () => {
    // 10x10のマップ空間。左上に2x2の小さい塊（除外対象）、
    // (4,4)-(7,7)の4x4の塊（採用対象）を置く。
    const width = 10
    const height = 10
    const probMap = new Float32Array(width * height)
    for (let y = 0; y <= 1; y++) for (let x = 0; x <= 1; x++) probMap[y * width + x] = 0.9
    for (let y = 4; y <= 7; y++) for (let x = 4; x <= 7; x++) probMap[y * width + x] = 1.0

    const boxes = postprocessDetection(probMap, width, height, { scaleX: 2, scaleY: 3 }, { boxThreshold: 0.2 })

    // 手計算: 4x4塊(x4..7,y4..7) → unclip(ratio1.5, area16,perimeter16,distance1.5)
    // → 拡張後 x=2.5,y=2.5,w=7,h=7 → クランプ後 x0=2,y0=2,x1=10,y1=10（幅8,高さ8）
    // → スコア = 16*1.0 / (8*8=64) = 0.25 → boxThreshold(0.2)を超えるので採用
    // → 元画像座標 x=2*2=4, y=2*3=6, w=8*2=16, h=8*3=24
    expect(boxes.length).toBe(1)
    expect(boxes[0].x).toBeCloseTo(4, 5)
    expect(boxes[0].y).toBeCloseTo(6, 5)
    expect(boxes[0].w).toBeCloseTo(16, 5)
    expect(boxes[0].h).toBeCloseTo(24, 5)
    expect(boxes[0].score).toBeCloseTo(0.25, 5)
  })

  it('スコアが閾値未満の成分は除外する', () => {
    const width = 10
    const height = 10
    const probMap = new Float32Array(width * height)
    for (let y = 4; y <= 7; y++) for (let x = 4; x <= 7; x++) probMap[y * width + x] = 1.0
    // 既定のboxThreshold(0.6)では、手計算のスコア0.25は閾値未満なので除外されるはず
    const boxes = postprocessDetection(probMap, width, height, { scaleX: 1, scaleY: 1 })
    expect(boxes).toEqual([])
  })

  it('検出枠を読み順（上から下、同じ行は左から右）に並べ替えて返す', () => {
    const width = 20
    const height = 20
    const probMap = new Float32Array(width * height)
    // 上段・右寄り
    for (let y = 1; y <= 4; y++) for (let x = 10; x <= 13; x++) probMap[y * width + x] = 1.0
    // 上段・左寄り
    for (let y = 1; y <= 4; y++) for (let x = 1; x <= 4; x++) probMap[y * width + x] = 1.0
    // 下段
    for (let y = 15; y <= 18; y++) for (let x = 1; x <= 4; x++) probMap[y * width + x] = 1.0

    const boxes = postprocessDetection(probMap, width, height, { scaleX: 1, scaleY: 1 }, { boxThreshold: 0.2 })
    expect(boxes.length).toBe(3)
    // 上段2つが先、下段が最後
    expect(boxes[0].y).toBeLessThan(boxes[2].y)
    expect(boxes[1].y).toBeLessThan(boxes[2].y)
    // 上段の中では左（x小）が先
    expect(boxes[0].x).toBeLessThan(boxes[1].x)
  })

  it('probMapが不正（サイズ不足）な場合は空配列を返す', () => {
    expect(postprocessDetection(new Float32Array(2), 10, 10, { scaleX: 1, scaleY: 1 })).toEqual([])
  })

  it('probMapが空でも例外を投げない', () => {
    expect(() => postprocessDetection(new Float32Array(0), 0, 0, { scaleX: 1, scaleY: 1 })).not.toThrow()
  })
})
