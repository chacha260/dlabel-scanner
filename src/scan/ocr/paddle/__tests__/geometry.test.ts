import { describe, expect, it } from 'vitest'
import {
  computeDetResize,
  computeRecTargetWidth,
  DET_MAX_SIDE,
  DET_SIZE_MULTIPLE,
  REC_MAX_WIDTH,
  REC_TARGET_HEIGHT,
  REC_WIDTH_MULTIPLE,
  sortBoxesReadingOrder,
  unclipBox,
} from '../geometry'

describe('computeDetResize', () => {
  it('長辺がDET_MAX_SIDE以下ならほぼ等倍のまま、32の倍数に丸める', () => {
    const { width, height } = computeDetResize(500, 300)
    expect(width % DET_SIZE_MULTIPLE).toBe(0)
    expect(height % DET_SIZE_MULTIPLE).toBe(0)
    // 500→512（32の倍数への丸め）、300→288 or 320のいずれか（近い方）
    expect(width).toBeGreaterThanOrEqual(480)
    expect(width).toBeLessThanOrEqual(544)
  })

  it('長辺がDET_MAX_SIDEを超える場合は縮小し、長辺が概ねDET_MAX_SIDE付近になる', () => {
    const { width, height } = computeDetResize(4000, 2000)
    // 縦横比2:1が保たれ、長辺（幅）がDET_MAX_SIDE付近（32の倍数への丸め誤差はある）
    expect(width).toBeLessThanOrEqual(DET_MAX_SIDE + DET_SIZE_MULTIPLE)
    expect(width % DET_SIZE_MULTIPLE).toBe(0)
    expect(height % DET_SIZE_MULTIPLE).toBe(0)
    // アスペクト比がおおよそ保たれている（2:1）
    expect(width / height).toBeGreaterThan(1.7)
    expect(width / height).toBeLessThan(2.3)
  })

  it('返すscaleX/scaleYは「リサイズ後の座標×scale=元画像の座標」になる倍率', () => {
    const { width, height, scaleX, scaleY } = computeDetResize(4000, 2000)
    expect(width * scaleX).toBeCloseTo(4000, 0)
    expect(height * scaleY).toBeCloseTo(2000, 0)
  })

  it('0以下・NaNの入力でも例外を投げず、有限の正の値を返す', () => {
    expect(() => computeDetResize(0, 0)).not.toThrow()
    expect(() => computeDetResize(Number.NaN, Number.NaN)).not.toThrow()
    const { width, height } = computeDetResize(0, 0)
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
  })

  it('丸めた結果が0にならない（DET_SIZE_MULTIPLE未満のごく小さい入力でも最低multiple分は確保する）', () => {
    const { width, height } = computeDetResize(5, 5)
    expect(width).toBeGreaterThanOrEqual(DET_SIZE_MULTIPLE)
    expect(height).toBeGreaterThanOrEqual(DET_SIZE_MULTIPLE)
  })
})

describe('computeRecTargetWidth', () => {
  it('高さREC_TARGET_HEIGHTに合わせたアスペクト比保持後の幅を、REC_WIDTH_MULTIPLEの倍数で返す', () => {
    // アスペクト比2:1の箱 → 高さ48にすると幅96相当
    const width = computeRecTargetWidth(200, 100)
    expect(width % REC_WIDTH_MULTIPLE).toBe(0)
    expect(width).toBeGreaterThan(80)
    expect(width).toBeLessThan(112)
  })

  it('計算上の幅がREC_MAX_WIDTHを超える場合はREC_MAX_WIDTHで頭打ちにする', () => {
    const width = computeRecTargetWidth(10000, 48)
    expect(width).toBeLessThanOrEqual(REC_MAX_WIDTH)
    expect(width % REC_WIDTH_MULTIPLE).toBe(0)
  })

  it('最低でもREC_WIDTH_MULTIPLE分は確保する', () => {
    const width = computeRecTargetWidth(1, 1000)
    expect(width).toBeGreaterThanOrEqual(REC_WIDTH_MULTIPLE)
  })

  it('0以下・NaNの入力でも例外を投げない', () => {
    expect(() => computeRecTargetWidth(0, 0)).not.toThrow()
    expect(() => computeRecTargetWidth(Number.NaN, Number.NaN)).not.toThrow()
  })

  it('既定の高さはREC_TARGET_HEIGHT(48)である', () => {
    expect(REC_TARGET_HEIGHT).toBe(48)
  })
})

describe('unclipBox', () => {
  it('矩形を外側へ広げる（幅・高さが両方とも増える）', () => {
    const box = { x: 10, y: 10, w: 20, h: 10 }
    const expanded = unclipBox(box, 1.5)
    expect(expanded.w).toBeGreaterThan(box.w)
    expect(expanded.h).toBeGreaterThan(box.h)
    // 中心はほぼ変わらない（対称に広がる）
    const origCenterX = box.x + box.w / 2
    const origCenterY = box.y + box.h / 2
    const newCenterX = expanded.x + expanded.w / 2
    const newCenterY = expanded.y + expanded.h / 2
    expect(newCenterX).toBeCloseTo(origCenterX, 5)
    expect(newCenterY).toBeCloseTo(origCenterY, 5)
  })

  it('unclipRatioが大きいほど広がり幅が大きい', () => {
    const box = { x: 0, y: 0, w: 20, h: 10 }
    const small = unclipBox(box, 1.0)
    const large = unclipBox(box, 3.0)
    expect(large.w).toBeGreaterThan(small.w)
  })

  it('w・hが0以下の退化した矩形は例外を投げず、負にならない値を返す', () => {
    expect(() => unclipBox({ x: 0, y: 0, w: 0, h: 0 })).not.toThrow()
    const result = unclipBox({ x: 5, y: 5, w: -1, h: 10 })
    expect(result.w).toBeGreaterThanOrEqual(0)
  })
})

describe('sortBoxesReadingOrder', () => {
  it('上から下、同じ行なら左から右に並べ替える', () => {
    const boxes = [
      { x: 100, y: 0, w: 20, h: 20 }, // 1行目・右
      { x: 0, y: 0, w: 20, h: 20 }, // 1行目・左
      { x: 0, y: 100, w: 20, h: 20 }, // 2行目
    ]
    const sorted = sortBoxesReadingOrder(boxes)
    expect(sorted).toEqual([
      { x: 0, y: 0, w: 20, h: 20 },
      { x: 100, y: 0, w: 20, h: 20 },
      { x: 0, y: 100, w: 20, h: 20 },
    ])
  })

  it('多少の縦位置のズレ（同じ行内のベースラインの違い程度）は同じ行として横方向で比較する', () => {
    const boxes = [
      { x: 50, y: 2, w: 20, h: 20 }, // ほぼ同じ行、右
      { x: 0, y: 0, w: 20, h: 20 }, // ほぼ同じ行、左
    ]
    const sorted = sortBoxesReadingOrder(boxes)
    expect(sorted[0].x).toBe(0)
    expect(sorted[1].x).toBe(50)
  })

  it('元の配列を変更しない（非破壊）', () => {
    const boxes = [
      { x: 100, y: 0, w: 20, h: 20 },
      { x: 0, y: 0, w: 20, h: 20 },
    ]
    const original = [...boxes]
    sortBoxesReadingOrder(boxes)
    expect(boxes).toEqual(original)
  })

  it('空配列でも例外を投げない', () => {
    expect(() => sortBoxesReadingOrder([])).not.toThrow()
    expect(sortBoxesReadingOrder([])).toEqual([])
  })
})
