import { describe, expect, it } from 'vitest'
import { normalizeDetPixels, normalizeRecPixels } from '../tensorize'

// 2x1のRGBA画素（幅2、高さ1）を作るヘルパー
function makePixels(pixels: [number, number, number, number][]): Uint8ClampedArray {
  const arr = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach(([r, g, b, a], i) => {
    arr[i * 4] = r
    arr[i * 4 + 1] = g
    arr[i * 4 + 2] = b
    arr[i * 4 + 3] = a
  })
  return arr
}

describe('normalizeDetPixels', () => {
  it('NCHW配置になっている（R平面・G平面・B平面の順に並ぶ）', () => {
    const pixels = makePixels([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ])
    const out = normalizeDetPixels(pixels, 2, 1)
    // サイズ = 2(幅)*1(高さ) = 2、出力長は3チャンネル分で6
    expect(out.length).toBe(6)
    // R平面: [pixel0のR, pixel1のR] = [255, 0]
    expect(out[0]).toBeCloseTo((255 / 255 - 0.485) / 0.229, 5)
    expect(out[1]).toBeCloseTo(-0.485 / 0.229, 5)
    // G平面: [pixel0のG, pixel1のG] = [0, 255]
    expect(out[2]).toBeCloseTo(-0.456 / 0.224, 5)
    expect(out[3]).toBeCloseTo((255 / 255 - 0.456) / 0.224, 5)
  })

  it('黒画素(0,0,0)は3チャンネルとも -mean/std になる', () => {
    const pixels = makePixels([[0, 0, 0, 255]])
    const out = normalizeDetPixels(pixels, 1, 1)
    expect(out[0]).toBeCloseTo(-0.485 / 0.229, 5)
    expect(out[1]).toBeCloseTo(-0.456 / 0.224, 5)
    expect(out[2]).toBeCloseTo(-0.406 / 0.225, 5)
  })

  it('画素配列がwidth*height*4に満たなくても例外を投げない', () => {
    const pixels = new Uint8ClampedArray(4) // 1画素分しかないのに2x2を要求する
    expect(() => normalizeDetPixels(pixels, 2, 2)).not.toThrow()
  })
})

describe('normalizeRecPixels', () => {
  it('(pixel/255 - 0.5) / 0.5 で -1..1 に正規化する', () => {
    const pixels = makePixels([[255, 0, 128, 255]])
    const out = normalizeRecPixels(pixels, 1, 1)
    expect(out[0]).toBeCloseTo(1, 5) // 255 → 1
    expect(out[1]).toBeCloseTo(-1, 5) // 0 → -1
    expect(out[2]).toBeCloseTo((128 / 255 - 0.5) / 0.5, 5)
  })

  it('白画素(255,255,255)は3チャンネルとも1になる', () => {
    const pixels = makePixels([[255, 255, 255, 255]])
    const out = normalizeRecPixels(pixels, 1, 1)
    expect(out[0]).toBeCloseTo(1, 5)
    expect(out[1]).toBeCloseTo(1, 5)
    expect(out[2]).toBeCloseTo(1, 5)
  })

  it('画素配列が不足していても例外を投げない', () => {
    const pixels = new Uint8ClampedArray(0)
    expect(() => normalizeRecPixels(pixels, 3, 1)).not.toThrow()
  })
})
