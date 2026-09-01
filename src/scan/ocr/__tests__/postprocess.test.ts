// OCR結果の後処理フィルタ（純粋関数）の単体テスト。

import { describe, expect, it } from 'vitest'
import { applyOcrFilter, filterAlnumOnly, filterDigitsOnly } from '../postprocess'

describe('filterDigitsOnly', () => {
  it('数字以外の文字（英字・記号・空白）をすべて取り除く', () => {
    expect(filterDigitsOnly('P-12345 ABC/6')).toBe('123456')
  })

  it('数字だけの文字列はそのまま返す', () => {
    expect(filterDigitsOnly('0123456789')).toBe('0123456789')
  })

  it('数字が1つも含まれなければ空文字を返す', () => {
    expect(filterDigitsOnly('ABC-DEF')).toBe('')
  })

  it('空文字を渡すと空文字を返す', () => {
    expect(filterDigitsOnly('')).toBe('')
  })

  it('全角数字は半角数字ではないため除去される（OCRの誤認識対策の範囲外）', () => {
    expect(filterDigitsOnly('１２３abc456')).toBe('456')
  })
})

describe('filterAlnumOnly', () => {
  it('英数字と -./ 以外の文字（空白・記号など）を取り除く', () => {
    expect(filterAlnumOnly('P-12345 ABC/6.7!!')).toBe('P-12345ABC/6.7')
  })

  it('英数字のみの文字列はそのまま返す', () => {
    expect(filterAlnumOnly('ABCdef123')).toBe('ABCdef123')
  })

  it('区切り記号 -./ はすべて保持する', () => {
    expect(filterAlnumOnly('--..//')).toBe('--..//')
  })

  it('英数字も区切り記号も含まれなければ空文字を返す', () => {
    expect(filterAlnumOnly('！＠＃　')).toBe('')
  })

  it('空文字を渡すと空文字を返す', () => {
    expect(filterAlnumOnly('')).toBe('')
  })
})

describe('applyOcrFilter', () => {
  const sample = 'P-12345 ABC/6'

  it('raw モードでは元のテキストをそのまま返す', () => {
    expect(applyOcrFilter(sample, 'raw')).toBe(sample)
  })

  it('digits モードでは filterDigitsOnly と同じ結果になる', () => {
    expect(applyOcrFilter(sample, 'digits')).toBe(filterDigitsOnly(sample))
  })

  it('alnum モードでは filterAlnumOnly と同じ結果になる', () => {
    expect(applyOcrFilter(sample, 'alnum')).toBe(filterAlnumOnly(sample))
  })
})
