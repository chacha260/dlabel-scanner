import { describe, expect, it } from 'vitest'
import {
  compareOcrPasses,
  judgeByConfidence,
  LOW_CONFIDENCE_THRESHOLD,
  mergeVerdicts,
  type CharVerdict,
} from '../agreement'

function texts(verdicts: CharVerdict[]): string {
  return verdicts.map((v) => v.text).join('')
}

/** 怪しいと判定された位置だけを '^'、そうでない位置を '.' にした可視化文字列 */
function marks(verdicts: CharVerdict[]): string {
  return verdicts.map((v) => (v.uncertain ? '^' : '.')).join('')
}

describe('judgeByConfidence', () => {
  it('しきい値を下回る文字だけを怪しいと判定する', () => {
    const result = judgeByConfidence([
      { text: '1', confidence: 95 },
      { text: 'I', confidence: 40 },
      { text: '3', confidence: 99 },
    ])
    expect(texts(result)).toBe('1I3')
    expect(marks(result)).toBe('.^.')
  })

  it('しきい値ちょうどは怪しくない扱いにする（下回った場合のみ怪しい）', () => {
    const result = judgeByConfidence([{ text: '5', confidence: LOW_CONFIDENCE_THRESHOLD }])
    expect(marks(result)).toBe('.')
  })

  it('しきい値を引数で上書きできる', () => {
    const symbols = [{ text: '7', confidence: 85 }]
    expect(marks(judgeByConfidence(symbols, 90))).toBe('^')
    expect(marks(judgeByConfidence(symbols, 80))).toBe('.')
  })

  it('symbols が空なら空配列を返す（情報が無いことを「全部怪しい」にしない）', () => {
    expect(judgeByConfidence([])).toEqual([])
  })

  it('confidence が数値でない壊れた入力でも例外を投げず、怪しくない扱いにする', () => {
    const result = judgeByConfidence([{ text: '1', confidence: Number.NaN }])
    expect(marks(result)).toBe('.')
  })
})

describe('compareOcrPasses', () => {
  it('2パスが完全に一致すれば、どの文字も怪しくない', () => {
    const result = compareOcrPasses('12345', '12345')
    expect(texts(result)).toBe('12345')
    expect(marks(result)).toBe('.....')
  })

  it('1文字だけ食い違えば、その位置だけが怪しい', () => {
    const result = compareOcrPasses('12I45', '12145')
    expect(texts(result)).toBe('12I45')
    expect(marks(result)).toBe('..^..')
  })

  it('片方が1文字多く読んでも、以降の文字が全部ずれて怪しくならない（LCSで対応付ける）', () => {
    // secondary 側が余計な '.' を1文字読んでしまったケース。
    // 単純な位置比較だと3文字目以降が全部不一致になってしまう。
    const result = compareOcrPasses('12345', '12.345')
    expect(texts(result)).toBe('12345')
    expect(marks(result)).toBe('.....')
  })

  it('片方が1文字落としても、落ちた箇所だけが怪しくなる', () => {
    // primary は '123456'、secondary は '4' を落として '12356'
    const result = compareOcrPasses('123456', '12356')
    expect(texts(result)).toBe('123456')
    expect(marks(result)).toBe('...^..')
  })

  it('まったく一致しなければ全文字が怪しい', () => {
    const result = compareOcrPasses('123', 'ABC')
    expect(texts(result)).toBe('123')
    expect(marks(result)).toBe('^^^')
  })

  it('secondary が空なら、裏が取れないので怪しくない扱いにする', () => {
    const result = compareOcrPasses('123', '')
    expect(texts(result)).toBe('123')
    expect(marks(result)).toBe('...')
  })

  it('primary が空なら空配列を返す', () => {
    expect(compareOcrPasses('', '123')).toEqual([])
  })

  it('primary のほうが長い場合、余った末尾は裏が取れず怪しい', () => {
    const result = compareOcrPasses('12345', '123')
    expect(texts(result)).toBe('12345')
    expect(marks(result)).toBe('...^^')
  })

  it('サロゲートペアを含んでも文字が壊れない（コードポイント単位で扱う）', () => {
    const result = compareOcrPasses('1🙂2', '1🙂2')
    expect(texts(result)).toBe('1🙂2')
    expect(marks(result)).toBe('...')
  })
})

describe('mergeVerdicts', () => {
  it('どちらか一方でも怪しいと言えば怪しい扱いにする', () => {
    const byPasses: CharVerdict[] = [
      { text: '1', uncertain: true },
      { text: '2', uncertain: false },
      { text: '3', uncertain: false },
    ]
    const byConfidence: CharVerdict[] = [
      { text: '1', uncertain: false },
      { text: '2', uncertain: true },
      { text: '3', uncertain: false },
    ]
    expect(marks(mergeVerdicts(byPasses, byConfidence))).toBe('^^.')
  })

  it('信頼度側が空なら2パス側をそのまま返す', () => {
    const byPasses: CharVerdict[] = [{ text: '1', uncertain: true }]
    expect(mergeVerdicts(byPasses, [])).toEqual(byPasses)
  })

  it('2パス側が空なら信頼度側をそのまま返す', () => {
    const byConfidence: CharVerdict[] = [{ text: '1', uncertain: true }]
    expect(mergeVerdicts([], byConfidence)).toEqual(byConfidence)
  })

  it('長さが食い違う場合は無理に重ねず、基準の2パス側をそのまま返す', () => {
    const byPasses: CharVerdict[] = [
      { text: '1', uncertain: false },
      { text: '2', uncertain: false },
    ]
    const byConfidence: CharVerdict[] = [{ text: '1', uncertain: true }]
    expect(mergeVerdicts(byPasses, byConfidence)).toEqual(byPasses)
  })

  it('テキストは常に2パス側のものを使う（表示するのは primary の結果）', () => {
    const byPasses: CharVerdict[] = [{ text: 'I', uncertain: false }]
    const byConfidence: CharVerdict[] = [{ text: '1', uncertain: true }]
    const merged = mergeVerdicts(byPasses, byConfidence)
    expect(texts(merged)).toBe('I')
    expect(marks(merged)).toBe('^')
  })
})
