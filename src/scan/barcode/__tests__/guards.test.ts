import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BARCODE_GUARD_RULES,
  describeBarcodeGuardReason,
  evaluateBarcodeHit,
  isBoxTruncated,
  isGtinCheckApplicable,
  isTwoDimensionalFormat,
  verifyCode39CheckDigit,
  verifyGtinCheckDigit,
  type BarcodeGuardRules,
} from '../guards'
import type { BarcodeHit, NormalizedRect } from '../types'

// テストで使う実在のチェックディジット付き値。
//   - EAN-13: 4901777018686 は実在の JAN コード（チェックディジット6が実際に検算で通る）。
//   - ITF-14: 04901777018686 は、上の JAN の先頭12桁に物流用の指示子桁0を足した13桁
//     （0490177701868）に対して同じ mod-10 アルゴリズムで新たにチェックディジットを
//     計算した値（GTIN-14の作り方そのもの）。手計算の根拠は guards.ts 冒頭のコメントに
//     書いた mod-10 アルゴリズム（右から3,1,3,1…の重み）で、以下の通り：
//       payload = 0490177701868
//       重み付き合計 = 8*3+6*1+8*3+1*1+0*3+7*1+7*3+7*1+1*3+0*1+9*3+4*1+0*3 = 124
//       124 mod 10 = 4 → check = (10-4) mod 10 = 6 → 04901777018686
//   - UPC-A: 036000291452 はよく例に使われる実在のUPC-A（チェックディジット2が検算で通る）。
const REAL_EAN13 = '4901777018686'
const REAL_ITF14 = '04901777018686'
const REAL_UPCA = '036000291452'

function hit(overrides: Partial<BarcodeHit> & Pick<BarcodeHit, 'value' | 'format'>): BarcodeHit {
  return { ...overrides }
}

describe('isTwoDimensionalFormat', () => {
  it('QR/DataMatrix/PDF417は2次元シンボルと判定する', () => {
    expect(isTwoDimensionalFormat('qr_code')).toBe(true)
    expect(isTwoDimensionalFormat('data_matrix')).toBe(true)
    expect(isTwoDimensionalFormat('pdf417')).toBe(true)
  })

  it('1次元シンボロジーは2次元と判定しない', () => {
    expect(isTwoDimensionalFormat('code_128')).toBe(false)
    expect(isTwoDimensionalFormat('itf')).toBe(false)
    expect(isTwoDimensionalFormat('ean_13')).toBe(false)
  })
})

describe('verifyGtinCheckDigit', () => {
  it('実在するEAN-13（4901777018686）は検算が通る', () => {
    expect(verifyGtinCheckDigit(REAL_EAN13)).toBe(true)
  })

  it('末尾1桁だけ変えると検算が通らなくなる', () => {
    expect(verifyGtinCheckDigit('4901777018680')).toBe(false)
  })

  it('実在するUPC-A（036000291452）は検算が通る', () => {
    expect(verifyGtinCheckDigit(REAL_UPCA)).toBe(true)
  })

  it('実在するITF-14（04901777018686）は検算が通る', () => {
    expect(verifyGtinCheckDigit(REAL_ITF14)).toBe(true)
  })

  it('途中の桁を変えると検算が通らなくなる', () => {
    expect(verifyGtinCheckDigit('04901777118686')).toBe(false)
  })

  it('数字以外の文字を含む場合はfalse', () => {
    expect(verifyGtinCheckDigit('490177701868X')).toBe(false)
  })

  it('1桁以下ではfalse（チェックディジットと本体を分離できない）', () => {
    expect(verifyGtinCheckDigit('5')).toBe(false)
  })
})

describe('isGtinCheckApplicable', () => {
  it('ITFは14桁のときだけ適用可能（13桁・15桁は対象外）', () => {
    expect(isGtinCheckApplicable('itf', 14)).toBe(true)
    expect(isGtinCheckApplicable('itf', 13)).toBe(false)
    expect(isGtinCheckApplicable('itf', 15)).toBe(false)
    expect(isGtinCheckApplicable('itf', 6)).toBe(false)
    expect(isGtinCheckApplicable('itf', 16)).toBe(false)
  })

  it('EAN-13は13桁、EAN-8は8桁、UPC-Aは12桁のときだけ適用可能', () => {
    expect(isGtinCheckApplicable('ean_13', 13)).toBe(true)
    expect(isGtinCheckApplicable('ean_13', 12)).toBe(false)
    expect(isGtinCheckApplicable('ean_8', 8)).toBe(true)
    expect(isGtinCheckApplicable('upc_a', 12)).toBe(true)
  })

  it('UPC-Eは8桁（チェックディジット込み）のときだけ適用可能。6桁の圧縮形式は対象外', () => {
    expect(isGtinCheckApplicable('upc_e', 8)).toBe(true)
    expect(isGtinCheckApplicable('upc_e', 6)).toBe(false)
  })

  it('Code128等、GTINでないフォーマットは常に対象外', () => {
    expect(isGtinCheckApplicable('code_128', 13)).toBe(false)
    expect(isGtinCheckApplicable('qr_code', 14)).toBe(false)
  })
})

describe('verifyCode39CheckDigit', () => {
  // Code39の文字集合 '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%' におけるインデックスの
  // 合計を43で割った余りがチェック文字のインデックスになる。
  // payload "123" → インデックス合計 1+2+3=6 → 43で割った余り6 → 文字集合の6番目 = '6'
  it('mod43の検算が通る値（"1236"）はtrue', () => {
    expect(verifyCode39CheckDigit('1236')).toBe(true)
  })

  it('チェック文字だけ変えると検算が通らなくなる（"1237"）', () => {
    expect(verifyCode39CheckDigit('1237')).toBe(false)
  })

  it('Code39の文字集合に無い文字を含む場合はfalse', () => {
    expect(verifyCode39CheckDigit('12あ')).toBe(false)
  })

  it('1文字以下ではfalse', () => {
    expect(verifyCode39CheckDigit('A')).toBe(false)
  })
})

describe('isBoxTruncated', () => {
  const margin = 0.01

  it('画像の縁から十分離れているboxは見切れていない', () => {
    const box: NormalizedRect = { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }
    expect(isBoxTruncated(box, margin)).toBe(false)
  })

  it('境界値: marginぴったりの位置は見切れている扱い（境界含む）', () => {
    expect(isBoxTruncated({ x: 0.01, y: 0.3, w: 0.2, h: 0.2 }, margin)).toBe(true) // 左端ちょうど
    expect(isBoxTruncated({ x: 0.3, y: 0.01, w: 0.2, h: 0.2 }, margin)).toBe(true) // 上端ちょうど
    expect(isBoxTruncated({ x: 0.3, y: 0.3, w: 0.69, h: 0.2 }, margin)).toBe(true) // 右端ちょうど(x+w=0.99=1-margin)
    expect(isBoxTruncated({ x: 0.3, y: 0.3, w: 0.2, h: 0.69 }, margin)).toBe(true) // 下端ちょうど
  })

  it('境界値: marginよりわずかに内側なら見切れていない', () => {
    expect(isBoxTruncated({ x: 0.02, y: 0.3, w: 0.2, h: 0.2 }, margin)).toBe(false)
    expect(isBoxTruncated({ x: 0.3, y: 0.3, w: 0.679, h: 0.2 }, margin)).toBe(false) // x+w=0.979 < 0.99
  })
})

describe('evaluateBarcodeHit', () => {
  const rules: BarcodeGuardRules = DEFAULT_BARCODE_GUARD_RULES

  it('許可リストに無いフォーマットはformatDisabledで棄却する', () => {
    const restricted: BarcodeGuardRules = { ...rules, enabledFormats: ['qr_code'] }
    const result = evaluateBarcodeHit(hit({ value: '123', format: 'code_128' }), restricted)
    expect(result).toEqual({ ok: false, reason: { type: 'formatDisabled', format: 'code_128' } })
  })

  it('2次元シンボルはチェックディジット不正・見切れ・桁数超過があっても常に即採用する', () => {
    const strict: BarcodeGuardRules = { ...rules, minLength: 100, maxLength: 5 }
    const truncatedBox: NormalizedRect = { x: 0, y: 0, w: 0.5, h: 0.5 } // 縁に接している
    const result = evaluateBarcodeHit(hit({ value: 'short', format: 'qr_code', box: truncatedBox }), strict)
    expect(result).toEqual({ ok: true })
  })

  it('EAN-13で実在するチェックディジット付きの値は採用する', () => {
    const result = evaluateBarcodeHit(hit({ value: REAL_EAN13, format: 'ean_13' }), rules)
    expect(result).toEqual({ ok: true })
  })

  it('EAN-13でチェックディジットが合わない値は棄却する', () => {
    const result = evaluateBarcodeHit(hit({ value: '4901777018680', format: 'ean_13' }), rules)
    expect(result).toEqual({ ok: false, reason: { type: 'checkDigitMismatch', check: 'gtin', format: 'ean_13' } })
  })

  it('ITFは14桁の実在するチェックディジット付きの値なら採用する', () => {
    const result = evaluateBarcodeHit(hit({ value: REAL_ITF14, format: 'itf' }), rules)
    expect(result).toEqual({ ok: true })
  })

  it('ITFは14桁でチェックディジットが合わない値を棄却する', () => {
    const result = evaluateBarcodeHit(hit({ value: '04901777018680', format: 'itf' }), rules)
    expect(result).toEqual({ ok: false, reason: { type: 'checkDigitMismatch', check: 'gtin', format: 'itf' } })
  })

  it('ITFは13桁のときは検証をスキップする（14桁のときだけ検証する限定を守る）', () => {
    // 04901777018686 の末尾1桁を落とした13桁。チェックディジットが無いだけの
    // 正当なITF運用かもしれないので、たとえ mod-10 が偶然合わなくても採用する。
    const thirteenDigits = REAL_ITF14.slice(0, 13)
    const result = evaluateBarcodeHit(hit({ value: thirteenDigits, format: 'itf' }), rules)
    expect(result).toEqual({ ok: true })
  })

  it('ITFは15桁のときも検証をスキップする', () => {
    const fifteenDigits = `${REAL_ITF14}9`
    const result = evaluateBarcodeHit(hit({ value: fifteenDigits, format: 'itf' }), rules)
    expect(result).toEqual({ ok: true })
  })

  it('Code39のチェックディジット検証は既定でOFF（不正な値でも採用される）', () => {
    // "1237" は verifyCode39CheckDigit のテストで false になる値だが、既定ルールでは
    // verifyCode39Checksum が false なのでそもそも検証されない。
    const result = evaluateBarcodeHit(hit({ value: '1237', format: 'code_39' }), rules)
    expect(result).toEqual({ ok: true })
  })

  it('Code39のチェックディジット検証をONにすると不正な値を棄却する', () => {
    const withCode39Check: BarcodeGuardRules = { ...rules, verifyCode39Checksum: true }
    const result = evaluateBarcodeHit(hit({ value: '1237', format: 'code_39' }), withCode39Check)
    expect(result).toEqual({ ok: false, reason: { type: 'checkDigitMismatch', check: 'code39', format: 'code_39' } })
  })

  it('Code39のチェックディジット検証をONにしても正しい値は採用する', () => {
    const withCode39Check: BarcodeGuardRules = { ...rules, verifyCode39Checksum: true }
    const result = evaluateBarcodeHit(hit({ value: '1236', format: 'code_39' }), withCode39Check)
    expect(result).toEqual({ ok: true })
  })

  it('boxが画像の縁に接しているヒットは見切れとして棄却する', () => {
    const truncatedBox: NormalizedRect = { x: 0, y: 0.3, w: 0.2, h: 0.2 }
    const result = evaluateBarcodeHit(hit({ value: 'ABC', format: 'code_128', box: truncatedBox }), rules)
    expect(result).toEqual({ ok: false, reason: { type: 'truncated' } })
  })

  it('boxを持たないヒットは見切れ判定の対象外として採用する', () => {
    const result = evaluateBarcodeHit(hit({ value: 'ABC', format: 'code_128' }), rules)
    expect(result).toEqual({ ok: true })
  })

  it('見切れ検出をOFFにすると縁に接していても採用する', () => {
    const withoutTruncationGuard: BarcodeGuardRules = { ...rules, rejectTruncatedBox: false }
    const truncatedBox: NormalizedRect = { x: 0, y: 0.3, w: 0.2, h: 0.2 }
    const result = evaluateBarcodeHit(hit({ value: 'ABC', format: 'code_128', box: truncatedBox }), withoutTruncationGuard)
    expect(result).toEqual({ ok: true })
  })

  it('既定は桁数無制限（minLength/maxLengthが0）なのでどんな長さでも採用する', () => {
    expect(evaluateBarcodeHit(hit({ value: 'A', format: 'code_128' }), rules)).toEqual({ ok: true })
    expect(evaluateBarcodeHit(hit({ value: 'A'.repeat(50), format: 'code_128' }), rules)).toEqual({ ok: true })
  })

  it('minLengthを設定すると短すぎる値を棄却する', () => {
    const withMin: BarcodeGuardRules = { ...rules, minLength: 5 }
    const result = evaluateBarcodeHit(hit({ value: 'ABC', format: 'code_128' }), withMin)
    expect(result).toEqual({ ok: false, reason: { type: 'tooShort', minLength: 5, actualLength: 3 } })
  })

  it('maxLengthを設定すると長すぎる値を棄却する', () => {
    const withMax: BarcodeGuardRules = { ...rules, maxLength: 3 }
    const result = evaluateBarcodeHit(hit({ value: 'ABCDE', format: 'code_128' }), withMax)
    expect(result).toEqual({ ok: false, reason: { type: 'tooLong', maxLength: 3, actualLength: 5 } })
  })
})

describe('describeBarcodeGuardReason', () => {
  it('ITFのチェックディジット不一致は14桁である旨を含む文言になる', () => {
    const message = describeBarcodeGuardReason({ type: 'checkDigitMismatch', check: 'gtin', format: 'itf' })
    expect(message).toContain('ITF')
    expect(message).toContain('14桁')
  })

  it('見切れは「枠に入るように」という次のアクションを含む文言になる', () => {
    const message = describeBarcodeGuardReason({ type: 'truncated' })
    expect(message).toContain('見切れ')
  })

  it('formatDisabledはフォーマットの表示名を含む', () => {
    const message = describeBarcodeGuardReason({ type: 'formatDisabled', format: 'code_39' })
    expect(message).toContain('Code39')
  })
})
