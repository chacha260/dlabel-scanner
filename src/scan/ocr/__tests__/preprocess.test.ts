// computeOcrScale の純粋なロジックのみを検証する（canvas 依存部分は含まない）。

import { describe, expect, it } from 'vitest'
import { computeOcrScale, OCR_PIXEL_BUDGET } from '../preprocess'

describe('computeOcrScale', () => {
  it('1920x1080 のストリームから切り出した典型的な ROI では画素数予算以内に収まり、2倍よりかなり小さくなる', () => {
    const sw = 1536
    const sh = 194
    const scale = computeOcrScale(sw, sh)
    const outputPixels = sw * sh * scale * scale

    expect(outputPixels).toBeLessThanOrEqual(OCR_PIXEL_BUDGET + 1) // 浮動小数点誤差を許容
    expect(scale).toBeLessThan(1.5)
  })

  it('小さい ROI では予算に余裕があるため、既定の2倍拡大がそのまま使われる', () => {
    const scale = computeOcrScale(300, 40)
    expect(scale).toBe(2)
  })

  it('非常に大きい ROI では 0 に潰れず、下限の0.6にクランプされる', () => {
    const scale = computeOcrScale(2000, 2000)
    expect(scale).toBe(0.6)
  })

  it('0 を渡しても有限の正の値を返し、例外を投げない', () => {
    expect(() => computeOcrScale(0, 0)).not.toThrow()
    const scale = computeOcrScale(0, 0)
    expect(Number.isFinite(scale)).toBe(true)
    expect(scale).toBeGreaterThan(0)
  })

  it('負の値を渡しても有限の正の値を返し、例外を投げない', () => {
    const scale = computeOcrScale(-100, -50)
    expect(Number.isFinite(scale)).toBe(true)
    expect(scale).toBeGreaterThan(0)
  })

  it('NaN を渡しても有限の正の値を返し、例外を投げない', () => {
    const scale = computeOcrScale(Number.NaN, Number.NaN)
    expect(Number.isFinite(scale)).toBe(true)
    expect(scale).toBeGreaterThan(0)
  })

  it('スケールは常に [0.6, 2] の範囲に収まる', () => {
    const cases: [number, number][] = [
      [1, 1],
      [100, 100],
      [1536, 194],
      [5000, 5000],
      [1, 100000],
    ]
    for (const [w, h] of cases) {
      const scale = computeOcrScale(w, h)
      expect(scale).toBeGreaterThanOrEqual(0.6)
      expect(scale).toBeLessThanOrEqual(2)
    }
  })
})
