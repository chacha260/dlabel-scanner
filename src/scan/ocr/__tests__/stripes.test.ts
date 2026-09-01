// countTransitions / findDenseBand の純粋なロジックのみを検証する。
// これは「バーコードマスクが隣接する文字まで塗りつぶしてしまう」回帰の
// 直接の再現テストなので、findDenseBand が文字の行を含めないことを厳しめに確認する。

import { describe, expect, it } from 'vitest'
import { countTransitions, findDenseBand } from '../stripes'

// 0/255 の交互パターン（理想化したバーコードのバー）を作る
function alternating(length: number, period = 4): Uint8ClampedArray {
  const arr = new Uint8ClampedArray(length)
  for (let i = 0; i < length; i++) {
    arr[i] = Math.floor(i / period) % 2 === 0 ? 0 : 255
  }
  return arr
}

describe('countTransitions', () => {
  it('交互パターンでは高い反転回数を返す', () => {
    const line = alternating(40, 2) // 2画素ごとに反転 → 反転回数は概ね (40/2)-1 前後
    const count = countTransitions(line, 64, 192)
    expect(count).toBeGreaterThan(15)
  })

  it('フラットな線では反転0を返す', () => {
    const line = new Uint8ClampedArray(50).fill(128)
    expect(countTransitions(line, 64, 192)).toBe(0)
  })

  it('微小なノイズが乗ったフラットな線でも、ヒステリシスにより反転0を返す', () => {
    // 128 を中心に ±5 だけ細かく揺れるノイズ（しきい値 64/192 の不感帯に収まる）
    const line = new Uint8ClampedArray(50)
    for (let i = 0; i < line.length; i++) {
      line[i] = 128 + (i % 2 === 0 ? 5 : -5)
    }
    expect(countTransitions(line, 64, 192)).toBe(0)
  })

  it('空配列・要素数1でも例外を投げず0を返す', () => {
    expect(() => countTransitions(new Uint8ClampedArray(0), 64, 192)).not.toThrow()
    expect(countTransitions(new Uint8ClampedArray(0), 64, 192)).toBe(0)
    expect(countTransitions(new Uint8ClampedArray(1), 64, 192)).toBe(0)
  })

  it('しきい値の大小が逆でも例外を投げない', () => {
    const line = alternating(20, 2)
    expect(() => countTransitions(line, 192, 64)).not.toThrow()
  })
})

describe('findDenseBand', () => {
  it('バー帯（20〜60）と文字帯（61〜80）が並ぶ配列から、文字帯を除いたバー帯だけを返す', () => {
    // 0..19: クワイエットゾーン（ほぼ反転なし）
    // 20..60: バーコードのバー（反転が非常に多い）
    // 61..80: 文字（反転はあるが、バーよりずっと少ない）
    const counts: number[] = []
    for (let i = 0; i < 20; i++) counts.push(1) // クワイエットゾーン
    for (let i = 20; i <= 60; i++) counts.push(38) // バー
    for (let i = 61; i <= 80; i++) counts.push(6) // 文字（バーの40%未満）

    const band = findDenseBand(counts)
    expect(band).not.toBeNull()
    expect(band!.start).toBe(20)
    expect(band!.end).toBe(60)
    // 文字帯の行が含まれていないことを明示的に確認する（この変更の核心）
    expect(band!.end).toBeLessThan(61)
  })

  it('全行が一様に密（2次元シンボル相当）なら全域を返す', () => {
    const counts = new Array(50).fill(30)
    const band = findDenseBand(counts)
    expect(band).toEqual({ start: 0, end: 49 })
  })

  it('密な行が一つもなければ null を返す', () => {
    const counts = new Array(30).fill(0)
    expect(findDenseBand(counts)).toBeNull()
  })

  it('密な帯の中の1〜2行だけの落ち込みは分断しない', () => {
    const counts = [1, 1, 40, 40, 40, 2, 40, 40, 40, 1, 1]
    const band = findDenseBand(counts)
    expect(band).toEqual({ start: 2, end: 8 })
  })

  it('空配列・全0・要素数1でも例外を投げない', () => {
    expect(() => findDenseBand([])).not.toThrow()
    expect(findDenseBand([])).toBeNull()
    expect(() => findDenseBand([0, 0, 0])).not.toThrow()
    expect(findDenseBand([0, 0, 0])).toBeNull()
    expect(() => findDenseBand([5])).not.toThrow()
    expect(findDenseBand([5])).toEqual({ start: 0, end: 0 })
  })
})
