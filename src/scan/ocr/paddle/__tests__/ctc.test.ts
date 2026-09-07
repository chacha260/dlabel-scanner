import { describe, expect, it } from 'vitest'
import { argmaxPerTimestep, classIndexToChar, CTC_BLANK_INDEX, ctcGreedyDecode } from '../ctc'

describe('argmaxPerTimestep', () => {
  it('各タイムステップの最大値のインデックスと値を返す', () => {
    // T=2, C=3
    const data = [0.1, 0.7, 0.2, 0.6, 0.3, 0.1]
    const { indices, probs } = argmaxPerTimestep(data, 2, 3)
    expect(Array.from(indices)).toEqual([1, 0])
    // probsはFloat32Arrayなので、doubleの0.7/0.6とは丸め誤差が生じる（toBeCloseToで比較する）
    expect(probs[0]).toBeCloseTo(0.7, 5)
    expect(probs[1]).toBeCloseTo(0.6, 5)
  })

  it('timeSteps・numClassesが0以下でも例外を投げず空を返す', () => {
    expect(() => argmaxPerTimestep([1, 2, 3], 0, 3)).not.toThrow()
    expect(argmaxPerTimestep([1, 2, 3], 0, 3).indices.length).toBe(0)
    expect(argmaxPerTimestep([1, 2, 3], 2, 0).indices.length).toBe(2)
  })

  it('データが足りない（範囲外アクセスになる）場合でも例外を投げない', () => {
    const data = [0.1, 0.2] // T=2,C=3には足りない
    expect(() => argmaxPerTimestep(data, 2, 3)).not.toThrow()
  })
})

describe('classIndexToChar', () => {
  const dict = ['A', 'B', 'C']

  it('index 0 はblankなのでnull', () => {
    expect(classIndexToChar(CTC_BLANK_INDEX, dict)).toBeNull()
  })

  it('index 1..dict.length は辞書の該当行', () => {
    expect(classIndexToChar(1, dict)).toBe('A')
    expect(classIndexToChar(2, dict)).toBe('B')
    expect(classIndexToChar(3, dict)).toBe('C')
  })

  it('index dict.length+1 は半角スペース', () => {
    expect(classIndexToChar(4, dict)).toBe(' ')
  })

  it('範囲外のindexはnull', () => {
    expect(classIndexToChar(5, dict)).toBeNull()
    expect(classIndexToChar(-1, dict)).toBeNull()
  })
})

describe('ctcGreedyDecode', () => {
  const dict = ['A', 'B', 'C']

  it('連続する同一インデックスを1つに畳み、blankを捨てて文字列にする', () => {
    // "AABBB0C0" 相当（0=blank）→ "ABC"
    const indices = [1, 1, 2, 2, 2, 0, 3, 0]
    const probs = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]
    const { text } = ctcGreedyDecode(indices, probs, dict)
    expect(text).toBe('ABC')
  })

  it('採用したタイムステップの確率の平均×100をconfidenceとして返す', () => {
    // 採用されるのはt=0(idx1,prob0.9)のみ（同じ値が続く場合は先頭だけ採用）
    const indices = [1, 1, 1]
    const probs = [0.9, 0.5, 0.5]
    const { confidence } = ctcGreedyDecode(indices, probs, dict)
    expect(confidence).toBeCloseTo(90, 5)
  })

  it('blankだけの入力は空文字・confidence 0', () => {
    const { text, confidence } = ctcGreedyDecode([0, 0, 0], [0.9, 0.9, 0.9], dict)
    expect(text).toBe('')
    expect(confidence).toBe(0)
  })

  it('半角スペースを含む文字列をデコードできる', () => {
    // A(1) blank(0) space(4) B(2)
    const indices = [1, 0, 4, 2]
    const probs = [0.9, 0.1, 0.8, 0.7]
    const { text } = ctcGreedyDecode(indices, probs, dict)
    expect(text).toBe('A B')
  })

  it('空配列でも例外を投げない', () => {
    expect(() => ctcGreedyDecode([], [], dict)).not.toThrow()
    expect(ctcGreedyDecode([], [], dict)).toEqual({ text: '', confidence: 0 })
  })

  it('indicesとprobsの長さが食い違っても例外を投げない', () => {
    expect(() => ctcGreedyDecode([1, 2, 3], [0.5], dict)).not.toThrow()
  })

  it('同じインデックスが一度blankを挟んで再度現れた場合は、それぞれ別の文字として採用する', () => {
    // A A blank A → "AA"（blankを挟むと"前の値と異なる"扱いになるため）
    const indices = [1, 1, 0, 1]
    const probs = [0.9, 0.9, 0.1, 0.8]
    const { text } = ctcGreedyDecode(indices, probs, dict)
    expect(text).toBe('AA')
  })
})
