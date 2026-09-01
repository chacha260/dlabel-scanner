import { describe, expect, it } from 'vitest'
import { computeCropSize, CROP_PIXEL_BUDGET_PX, resolveBarcodeCropPlan } from '../crop'

describe('computeCropSize', () => {
  it('予算以下の小さい枠は等倍のまま（scaleは1、幅高さも元のまま）', () => {
    const r = computeCropSize(500, 500, CROP_PIXEL_BUDGET_PX) // 250,000px < 2.5Mpx
    expect(r.scale).toBe(1)
    expect(r.width).toBe(500)
    expect(r.height).toBe(500)
  })

  it('予算をわずかでも超えたら、画素数がちょうど予算に収まるスケールまで縮小する', () => {
    const sourceW = 3000
    const sourceH = 2000 // 6,000,000px > 2.5Mpx
    const r = computeCropSize(sourceW, sourceH, CROP_PIXEL_BUDGET_PX)
    const expectedScale = Math.sqrt(CROP_PIXEL_BUDGET_PX / (sourceW * sourceH))
    expect(r.scale).toBeCloseTo(expectedScale, 6)
    // 丸め誤差はあるが、出力画素数はほぼ予算ちょうどになる
    expect(r.width * r.height).toBeLessThanOrEqual(CROP_PIXEL_BUDGET_PX * 1.01)
    expect(r.width * r.height).toBeGreaterThan(CROP_PIXEL_BUDGET_PX * 0.9)
  })

  it('アスペクト比が保たれる（縮小後も元の縦横比に近い）', () => {
    const sourceW = 3264
    const sourceH = 1836
    const r = computeCropSize(sourceW, sourceH, CROP_PIXEL_BUDGET_PX)
    expect(r.width / r.height).toBeCloseTo(sourceW / sourceH, 2)
  })

  it('境界値: 元の画素数がちょうど予算と同じ場合は縮小しない', () => {
    const r = computeCropSize(2500, 1000, 2_500_000)
    expect(r.scale).toBe(1)
  })

  it('0 や NaN、負の値を渡しても例外を投げず、有限の正の値を返す', () => {
    expect(() => computeCropSize(0, 0)).not.toThrow()
    const zero = computeCropSize(0, 0)
    expect(Number.isFinite(zero.width)).toBe(true)
    expect(Number.isFinite(zero.height)).toBe(true)
    expect(zero.width).toBeGreaterThan(0)
    expect(zero.height).toBeGreaterThan(0)

    const nan = computeCropSize(Number.NaN, Number.NaN)
    expect(Number.isFinite(nan.width)).toBe(true)
    expect(Number.isFinite(nan.height)).toBe(true)
    expect(nan.width).toBeGreaterThan(0)
    expect(nan.height).toBeGreaterThan(0)

    const negative = computeCropSize(-100, -50)
    expect(Number.isFinite(negative.width)).toBe(true)
    expect(Number.isFinite(negative.height)).toBe(true)
    expect(negative.width).toBeGreaterThan(0)
    expect(negative.height).toBeGreaterThan(0)

    expect(() => computeCropSize(1000, 1000, 0)).not.toThrow()
    expect(() => computeCropSize(1000, 1000, Number.NaN)).not.toThrow()
  })
})

describe('resolveBarcodeCropPlan', () => {
  const roi = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }

  it('枠内のみON かつ 枠がある: crop はその枠そのもの、applyRoiFilter は false', () => {
    const plan = resolveBarcodeCropPlan(true, roi)
    expect(plan.crop).toEqual(roi)
    expect(plan.applyRoiFilter).toBe(false)
  })

  it('枠内のみOFF: crop は null、applyRoiFilter も false（絞り込み自体をしない）', () => {
    const plan = resolveBarcodeCropPlan(false, roi)
    expect(plan.crop).toBeNull()
    expect(plan.applyRoiFilter).toBe(false)
  })

  it('枠内のみON だが 枠がまだ無い: crop は null、applyRoiFilter も false', () => {
    const plan = resolveBarcodeCropPlan(true, undefined)
    expect(plan.crop).toBeNull()
    expect(plan.applyRoiFilter).toBe(false)
  })

  it('ガード: どちらの分岐でも applyRoiFilter が true になることはない（クロップ座標に映像座標のROIフィルタを誤って適用しないため）', () => {
    for (const restrictToRoi of [true, false]) {
      for (const r of [roi, undefined]) {
        expect(resolveBarcodeCropPlan(restrictToRoi, r).applyRoiFilter).toBe(false)
      }
    }
  })
})
