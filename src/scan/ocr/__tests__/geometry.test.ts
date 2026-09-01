import { describe, expect, it } from 'vitest'
import { mapCoverRectToVideo } from '../geometry'

const ROI = { x: 0.1, y: 0.26, w: 0.8, h: 0.18 }

describe('mapCoverRectToVideo', () => {
  it('表示枠と映像の縦横比が同じなら値が変わらない', () => {
    const r = mapCoverRectToVideo(ROI, 800, 450, 1920, 1080)
    expect(r.x).toBeCloseTo(0.1, 6)
    expect(r.y).toBeCloseTo(0.26, 6)
    expect(r.w).toBeCloseTo(0.8, 6)
    expect(r.h).toBeCloseTo(0.18, 6)
  })

  it('横長の映像を縦長の枠に収めると、横方向が内側に補正される', () => {
    // 1920x1080 を 400x340 に cover 表示 → 倍率 340/1080、描画幅 605px、左右 102.5px ずつが切れる
    const r = mapCoverRectToVideo(ROI, 400, 340, 1920, 1080)
    expect(r.x).toBeCloseTo((0.1 * 400 + 102.5) / 604.44, 3)
    expect(r.x).toBeGreaterThan(ROI.x) // 補正前より内側
    expect(r.w).toBeLessThan(ROI.w) // 幅も詰まる
    // 縦方向は切れていないのでそのまま
    expect(r.y).toBeCloseTo(0.26, 6)
    expect(r.h).toBeCloseTo(0.18, 6)
  })

  it('縦長の映像を横長の枠に収めると、縦方向が内側に補正される', () => {
    const r = mapCoverRectToVideo(ROI, 800, 300, 1080, 1920)
    expect(r.y).toBeGreaterThan(ROI.y)
    expect(r.h).toBeLessThan(ROI.h)
    expect(r.x).toBeCloseTo(0.1, 6)
    expect(r.w).toBeCloseTo(0.8, 6)
  })

  it('変換後も 0..1 の範囲に収まり、右端・下端が映像をはみ出さない', () => {
    const full = { x: 0, y: 0, w: 1, h: 1 }
    for (const [dw, dh, vw, vh] of [
      [400, 340, 1920, 1080],
      [800, 300, 1080, 1920],
      [360, 800, 640, 480],
    ]) {
      const r = mapCoverRectToVideo(full, dw, dh, vw, vh)
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(1.000001)
      expect(r.y + r.h).toBeLessThanOrEqual(1.000001)
    }
  })

  it('寸法が未確定（0 や NaN）の場合は元の矩形をそのまま返す', () => {
    expect(mapCoverRectToVideo(ROI, 0, 340, 1920, 1080)).toEqual(ROI)
    expect(mapCoverRectToVideo(ROI, 400, 340, 0, 0)).toEqual(ROI)
    expect(mapCoverRectToVideo(ROI, Number.NaN, 340, 1920, 1080)).toEqual(ROI)
  })
})
