import { describe, expect, it } from 'vitest'
import { resolveZoomValue, type ZoomRange } from '../zoom'

const RANGE: ZoomRange = { min: 1, max: 5, step: 0.1 }

describe('resolveZoomValue', () => {
  it('range が無い（ズーム非対応端末）場合は null を返す', () => {
    expect(resolveZoomValue(3, null)).toBeNull()
  })

  it('range が壊れている（max < min）場合は null を返す', () => {
    expect(resolveZoomValue(3, { min: 5, max: 1, step: 0.1 })).toBeNull()
  })

  it('range の min/max が数値でない場合は null を返す', () => {
    expect(resolveZoomValue(3, { min: Number.NaN, max: 5, step: 0.1 })).toBeNull()
    expect(resolveZoomValue(3, { min: 1, max: Number.NaN, step: 0.1 })).toBeNull()
  })

  it('persisted が範囲内ならそのまま返す', () => {
    expect(resolveZoomValue(3, RANGE)).toBe(3)
  })

  it('persisted が範囲を超えている場合は max にクランプする', () => {
    expect(resolveZoomValue(10, RANGE)).toBe(5)
  })

  it('persisted が範囲未満の場合は min にクランプする', () => {
    expect(resolveZoomValue(0, RANGE)).toBe(1)
    expect(resolveZoomValue(-5, RANGE)).toBe(1)
  })

  it('persisted が null の場合は range の下限にフォールバックする', () => {
    expect(resolveZoomValue(null, RANGE)).toBe(1)
  })

  it('persisted が NaN の場合も range の下限にフォールバックする', () => {
    expect(resolveZoomValue(Number.NaN, RANGE)).toBe(1)
  })

  it('range の境界値ちょうどはクランプせずそのまま返す', () => {
    expect(resolveZoomValue(1, RANGE)).toBe(1)
    expect(resolveZoomValue(5, RANGE)).toBe(5)
  })
})
