import { describe, expect, it } from 'vitest'
import { truncateForDisplay } from '../truncate'

describe('truncateForDisplay', () => {
  it('maxChars 以下の値はそのまま返し、truncated は false', () => {
    const r = truncateForDisplay('ABC123', 10)
    expect(r).toEqual({ text: 'ABC123', truncated: false, omittedChars: 0 })
  })

  it('ちょうど maxChars と同じ長さなら切り詰めない（境界値）', () => {
    const r = truncateForDisplay('ABCDE', 5)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('ABCDE')
  })

  it('maxChars を超える値は先頭 maxChars 文字だけに切り詰め、omittedChars を返す', () => {
    const r = truncateForDisplay('ABCDEFGHIJ', 4)
    expect(r).toEqual({ text: 'ABCD', truncated: true, omittedChars: 6 })
  })

  it('空文字は常に切り詰めなしで返る', () => {
    const r = truncateForDisplay('', 10)
    expect(r).toEqual({ text: '', truncated: false, omittedChars: 0 })
  })

  it('サロゲートペア（絵文字など）の途中で切らない', () => {
    // 😀 (U+1F600) はUTF-16では2コードユニットだが1コードポイント
    const value = '😀😀😀'
    const r = truncateForDisplay(value, 2)
    expect(r.truncated).toBe(true)
    expect(r.text).toBe('😀😀')
    // 壊れたサロゲート単体が混ざっていないことを確認（文字列として正しい）
    expect(Array.from(r.text).length).toBe(2)
    expect(r.omittedChars).toBe(1)
  })

  it('maxChars が 0 以下・NaN・Infinity のときは切り詰めを行わず元の値を返す（安全側フォールバック）', () => {
    const value = 'X'.repeat(100)
    expect(truncateForDisplay(value, 0)).toEqual({ text: value, truncated: false, omittedChars: 0 })
    expect(truncateForDisplay(value, -5)).toEqual({ text: value, truncated: false, omittedChars: 0 })
    expect(truncateForDisplay(value, Number.NaN)).toEqual({ text: value, truncated: false, omittedChars: 0 })
    expect(truncateForDisplay(value, Number.POSITIVE_INFINITY)).toEqual({ text: value, truncated: false, omittedChars: 0 })
  })

  it('QR コードが持てる最大級のデータ量（4296文字程度）でも例外を投げず正しく切り詰める', () => {
    const value = 'A'.repeat(4296)
    const r = truncateForDisplay(value, 500)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBe(500)
    expect(r.omittedChars).toBe(4296 - 500)
  })
})
