// OCR結果の後処理フィルタ（純粋関数）の単体テスト。

import { describe, expect, it } from 'vitest'
import { applyOcrFilter, correctDigitConfusions, filterAlnumOnly, filterDigitsOnly } from '../postprocess'

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

  it('digitsFixed モードでは紛らわしい文字を数字に補正してから数字と-+以外を除去する', () => {
    // I -> 1, O -> 0, S -> 5, B -> 8 の補正がかかったうえで、区切りの
    // スペースや / のような数字でも -+ でもない文字は最終的に除去される。
    expect(applyOcrFilter('IO5-B/5', 'digitsFixed')).toBe('105-85')
  })
})

describe('correctDigitConfusions', () => {
  it('I l | ! i はすべて 1 に補正される（本不具合の中心である I と 1 の混同）', () => {
    expect(correctDigitConfusions('I l | ! i')).toBe('1 1 1 1 1')
  })

  it('O o D Q はすべて 0 に補正される', () => {
    expect(correctDigitConfusions('OoDQ')).toBe('0000')
  })

  it('S s は 5 に、B は 8 に、Z z は 2 に補正される', () => {
    expect(correctDigitConfusions('Ss-B-Zz')).toBe('55-8-22')
  })

  it('大文字 Q は 0 に、小文字 q は 9 に補正される（大文字・小文字で寄せる先が異なる）', () => {
    expect(correctDigitConfusions('Qq')).toBe('09')
  })

  it('大文字 B は 8 に、小文字 b は 6 に補正される（大文字・小文字で寄せる先が異なる）', () => {
    expect(correctDigitConfusions('Bb')).toBe('86')
  })

  it('大文字 G は 6 に、T は 7 に、A は 4 に、小文字 g は 9 に補正される', () => {
    expect(correctDigitConfusions('GTAg')).toBe('6749')
  })

  it('emダッシュ・enダッシュ・アンダースコアはハイフンに寄せられる', () => {
    expect(correctDigitConfusions('1—2–3_4')).toBe('1-2-3-4')
  })

  it('全角英数字・全角記号は半角化されたうえで補正される', () => {
    // Ｉ（全角I）は半角化されると I になり、さらに 1 へ補正される。
    // １２３（全角数字）と －（全角ハイフン）はそのまま半角の数字・ハイフンになる。
    expect(correctDigitConfusions('Ｉ１２３－４５６')).toBe('1123-456')
  })

  it('マッピング表にない文字は変更しない（過剰補正の防止）', () => {
    // C, E, F, H, J, K, M, N, P, R, U, V, W, X, Y はどれも数字への
    // 見た目の類似度が低いため補正対象に含めていない。ここが壊れていないかを
    // 確認することで、マップの取りこぼしや誤った全置換（例: 正規表現の書き間違いで
    // 無関係な文字まで巻き込む）を検知する。
    const untouched = 'CEFHJKMNPRUVWXY'
    expect(correctDigitConfusions(untouched)).toBe(untouched)
  })

  it('意味のある型番文字列でも、マップ対象外の文字はそのまま保持される', () => {
    // "-" と数字はそのまま、Pは対象外文字として保持される（過剰補正しない例）。
    expect(correctDigitConfusions('P-100')).toBe('P-100')
  })

  it('空文字を渡すと空文字を返す', () => {
    expect(correctDigitConfusions('')).toBe('')
  })
})
