// バーコードマスキングの純粋な座標計算（重なり判定・マージン拡張・ピクセル変換）の単体テスト。
// ここで扱う矩形はすべて映像座標（0..1）であり、表示座標は一切登場しない。

import { describe, expect, it } from 'vitest'
import { boxesToMask, DEFAULT_MASK_MARGIN, expandRect, normalizedRectToPixels, rectsOverlap } from '../mask'

describe('rectsOverlap', () => {
  it('完全に内側にある矩形は重なっていると判定する', () => {
    const outer = { x: 0, y: 0, w: 1, h: 1 }
    const inner = { x: 0.4, y: 0.4, w: 0.1, h: 0.1 }
    expect(rectsOverlap(outer, inner)).toBe(true)
    expect(rectsOverlap(inner, outer)).toBe(true)
  })

  it('一部だけ重なる矩形も重なっていると判定する', () => {
    const a = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }
    const b = { x: 0.3, y: 0.3, w: 0.3, h: 0.3 }
    expect(rectsOverlap(a, b)).toBe(true)
  })

  it('離れている矩形は重ならないと判定する', () => {
    const a = { x: 0, y: 0, w: 0.2, h: 0.2 }
    const b = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }
    expect(rectsOverlap(a, b)).toBe(false)
  })

  it('辺が接しているだけ（面積0の重なり）は重なっていないと判定する', () => {
    const a = { x: 0, y: 0, w: 0.5, h: 0.5 }
    const b = { x: 0.5, y: 0, w: 0.5, h: 0.5 } // a の右辺と b の左辺がちょうど接する
    expect(rectsOverlap(a, b)).toBe(false)
  })

  it('幅または高さが0の矩形は重ならない扱いにする', () => {
    const a = { x: 0.2, y: 0.2, w: 0, h: 0.3 }
    const b = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
    expect(rectsOverlap(a, b)).toBe(false)
  })
})

describe('expandRect', () => {
  it('上下左右にマージン分だけ広がる', () => {
    const r = expandRect({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }, 0.05)
    expect(r.x).toBeCloseTo(0.35, 6)
    expect(r.y).toBeCloseTo(0.35, 6)
    expect(r.w).toBeCloseTo(0.2, 6)
    expect(r.h).toBeCloseTo(0.2, 6)
  })

  it('フレーム端に近い矩形は 0..1 の範囲にクランプされる（frame の外にははみ出さない）', () => {
    const r = expandRect({ x: 0, y: 0.95, w: 0.02, h: 0.05 }, 0.05)
    expect(r.x).toBe(0)
    expect(r.y).toBeCloseTo(0.9, 6)
    expect(r.y + r.h).toBeLessThanOrEqual(1)
    expect(r.x + r.w).toBeLessThanOrEqual(1)
  })

  it('マージンが0や負の場合は元の矩形のまま', () => {
    const rect = { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }
    for (const r of [expandRect(rect, 0), expandRect(rect, -1)]) {
      expect(r.x).toBeCloseTo(rect.x, 9)
      expect(r.y).toBeCloseTo(rect.y, 9)
      expect(r.w).toBeCloseTo(rect.w, 9)
      expect(r.h).toBeCloseTo(rect.h, 9)
    }
  })
})

describe('normalizedRectToPixels', () => {
  it('フレームサイズに応じた整数ピクセル矩形に変換する', () => {
    const r = normalizedRectToPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 800, 400)
    expect(r).toEqual({ x: 200, y: 200, w: 400, h: 100 })
  })

  it('丸め誤差が蓄積しても右端・下端がフレーム幅を超えない', () => {
    // 0.1 を3で割ったような値は誤差が出やすい。幅700pxで境界を確認する。
    const r = normalizedRectToPixels({ x: 1 / 3, y: 0, w: 1 / 3, h: 1 }, 700, 100)
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.x + r.w).toBeLessThanOrEqual(700)
    expect(r.y + r.h).toBeLessThanOrEqual(100)
  })

  it('frame からはみ出す矩形はフレーム境界でクランプされる', () => {
    const r = normalizedRectToPixels({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 100, 100)
    expect(r.x).toBe(90)
    expect(r.y).toBe(90)
    expect(r.x + r.w).toBeLessThanOrEqual(100)
    expect(r.y + r.h).toBeLessThanOrEqual(100)
  })

  it('frame の寸法が0や不正な場合でも例外を投げず、空の矩形を返す', () => {
    expect(() => normalizedRectToPixels({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, 0, 0)).not.toThrow()
    const r = normalizedRectToPixels({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, Number.NaN, 100)
    expect(r.w).toBe(0)
  })
})

describe('boxesToMask', () => {
  const roi = { x: 0.1, y: 0.26, w: 0.8, h: 0.18 }

  it('ROI と重なる枠だけをマージン込みで返す', () => {
    const boxes = [
      { x: 0.2, y: 0.3, w: 0.1, h: 0.05 }, // ROI と重なる
      { x: 0.9, y: 0.9, w: 0.05, h: 0.05 }, // ROI と重ならない
    ]
    const masked = boxesToMask(boxes, roi, 0.02)
    expect(masked).toHaveLength(1)
    expect(masked[0].x).toBeCloseTo(0.2 - 0.02, 6)
    expect(masked[0].w).toBeCloseTo(0.1 + 0.04, 6)
  })

  it('検出結果が空なら空配列を返す', () => {
    expect(boxesToMask([], roi)).toEqual([])
  })

  it('既定のマージンが DEFAULT_MASK_MARGIN と一致する', () => {
    const box = { x: 0.2, y: 0.3, w: 0.1, h: 0.05 }
    const masked = boxesToMask([box], roi)
    expect(masked[0].x).toBeCloseTo(box.x - DEFAULT_MASK_MARGIN, 6)
  })
})
