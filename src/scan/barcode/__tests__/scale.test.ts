import { describe, expect, it } from 'vitest'
import { computeDownscaledSize } from '../scale'

describe('computeDownscaledSize', () => {
  it('上限以下ならダウンスケールしない（scale は1、幅高さも元のまま）', () => {
    const r = computeDownscaledSize(1280, 720, 1280)
    expect(r.scale).toBe(1)
    expect(r.width).toBe(1280)
    expect(r.height).toBe(720)
  })

  it('上限をわずかでも超えたら、長辺が上限ちょうどになるよう比率を保って縮小する', () => {
    const r = computeDownscaledSize(1920, 1080, 1280)
    expect(r.scale).toBeCloseTo(1280 / 1920, 6)
    expect(r.width).toBe(1280)
    expect(r.height).toBe(Math.round(1080 * (1280 / 1920)))
  })

  it('縦長映像でも長辺（この場合は高さ）を基準に縮小する', () => {
    const r = computeDownscaledSize(1080, 1920, 1280)
    expect(r.scale).toBeCloseTo(1280 / 1920, 6)
    expect(r.height).toBe(1280)
    expect(r.width).toBe(Math.round(1080 * (1280 / 1920)))
  })

  it('元映像がちょうど上限と同じ場合は縮小しない（境界値）', () => {
    const r = computeDownscaledSize(1280, 960, 1280)
    expect(r.scale).toBe(1)
  })

  it('小さい映像はそのまま（拡大はしない）', () => {
    const r = computeDownscaledSize(640, 480, 1280)
    expect(r.scale).toBe(1)
    expect(r.width).toBe(640)
    expect(r.height).toBe(480)
  })

  it('0 や NaN を渡しても例外を投げず、有限の正の値を返す', () => {
    expect(() => computeDownscaledSize(0, 0, 1280)).not.toThrow()
    const r = computeDownscaledSize(Number.NaN, Number.NaN, 1280)
    expect(Number.isFinite(r.width)).toBe(true)
    expect(Number.isFinite(r.height)).toBe(true)
    expect(r.width).toBeGreaterThan(0)
    expect(r.height).toBeGreaterThan(0)
  })
})
