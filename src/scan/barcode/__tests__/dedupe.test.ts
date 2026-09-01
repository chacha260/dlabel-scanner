import { describe, expect, it } from 'vitest'
import { selectNewHits } from '../dedupe'
import type { BarcodeHit } from '../types'

function hit(value: string): BarcodeHit {
  return { value, format: 'code_128' }
}

// isDuplicate の代わりに Set を使い、「呼び出し側の結果一覧」を模す小さなヘルパー。
function listOf(...values: string[]): { has: (value: string) => boolean; set: Set<string> } {
  const set = new Set(values)
  return { has: (value: string) => set.has(value), set }
}

describe('selectNewHits', () => {
  it('一覧に既にある値は追加対象から除外する', () => {
    const list = listOf('abc')
    expect(selectNewHits([hit('abc')], list.has)).toEqual([])
  })

  it('一覧に無い値は追加対象になる', () => {
    const list = listOf()
    expect(selectNewHits([hit('abc')], list.has).map((h) => h.value)).toEqual(['abc'])
  })

  it('一覧から消えれば、再び追加対象になる（行削除・クリアを模す）', () => {
    const list = listOf('abc')
    expect(selectNewHits([hit('abc')], list.has)).toEqual([])
    list.set.delete('abc')
    expect(selectNewHits([hit('abc')], list.has).map((h) => h.value)).toEqual(['abc'])
  })

  it('回帰: 1フレームに複数ヒットがあり、一部だけ一覧に既にある場合、新規の分だけ返す', () => {
    // 縦に3本並んだバーコードのうち、真ん中(middle)だけが既に一覧にある状況を模す。
    // 以前の時間ベースの実装でも同種の回帰があった（先頭がデデュープ対象だと
    // 残り全部を捨てていた）が、一覧ベースになった今も同じ性質を保証する。
    const list = listOf('middle')
    const hits = [hit('top'), hit('middle'), hit('bottom')]
    expect(selectNewHits(hits, list.has).map((h) => h.value)).toEqual(['top', 'bottom'])
  })

  it('3件とも一覧に無ければ、検出順のまま3件とも返す', () => {
    const result = selectNewHits([hit('a'), hit('b'), hit('c')], () => false)
    expect(result.map((h) => h.value)).toEqual(['a', 'b', 'c'])
  })

  it('3件とも既に一覧にあれば、1件も返さない', () => {
    const result = selectNewHits([hit('a'), hit('b'), hit('c')], () => true)
    expect(result).toEqual([])
  })

  it('空配列を渡すと空配列を返す', () => {
    expect(selectNewHits([], () => false)).toEqual([])
  })

  it('同一フレーム内に同じ値が重複しても、1件目だけを新規として返す', () => {
    const result = selectNewHits([hit('a'), hit('a'), hit('b')], () => false)
    expect(result.map((h) => h.value)).toEqual(['a', 'b'])
  })

  it('isDuplicate は各値について1回ずつ純粋に呼ばれるだけ（副作用を起こさない）', () => {
    const calls: string[] = []
    selectNewHits([hit('a'), hit('b')], (v) => {
      calls.push(v)
      return false
    })
    expect(calls).toEqual(['a', 'b'])
  })
})
