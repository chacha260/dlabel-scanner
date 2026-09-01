// バーコード値の整形（トリミング）ルールの単体テスト。

import { describe, expect, it } from 'vitest'
import {
  applyTrimRules,
  DEFAULT_TRIM_RULES,
  escapeRuleText,
  GS_CUT_FROM,
  type TrimRules,
  unescapeRuleText,
} from '../trim'

function rules(overrides: Partial<TrimRules>): TrimRules {
  return { ...DEFAULT_TRIM_RULES, enabled: true, ...overrides }
}

describe('applyTrimRules - 前方一致/後方一致', () => {
  it('前方一致する接頭辞を取り除く', () => {
    expect(applyTrimRules('ABC123', rules({ stripPrefixes: ['ABC'] }))).toBe('123')
  })

  it('後方一致する接尾辞を取り除く', () => {
    expect(applyTrimRules('123DEF', rules({ stripSuffixes: ['DEF'] }))).toBe('123')
  })

  it('複数の接頭辞候補があるときは長いものから順に判定する（ABC が A に勝つ）', () => {
    expect(applyTrimRules('ABC123', rules({ stripPrefixes: ['A', 'ABC'] }))).toBe('123')
  })

  it('複数の接尾辞候補があるときも長いものから順に判定する', () => {
    expect(applyTrimRules('123DEF', rules({ stripSuffixes: ['F', 'DEF'] }))).toBe('123')
  })

  it('接頭辞リストは1回だけ適用され、繰り返し剥がさない（["A"] を "AAB" に適用すると "AB"）', () => {
    expect(applyTrimRules('AAB', rules({ stripPrefixes: ['A'] }))).toBe('AB')
  })

  it('接尾辞リストも1回だけ適用され、繰り返し剥がさない', () => {
    expect(applyTrimRules('BAA', rules({ stripSuffixes: ['A'] }))).toBe('BA')
  })

  it('一致しない接頭辞/接尾辞は無視される', () => {
    expect(applyTrimRules('ABC123', rules({ stripPrefixes: ['XYZ'], stripSuffixes: ['XYZ'] }))).toBe('ABC123')
  })
})

describe('applyTrimRules - cutFrom / cutUpTo', () => {
  it('cutFrom にスペースを指定すると、それ以降を捨てる', () => {
    expect(applyTrimRules('ABC123 DEF', rules({ cutFrom: ' ' }))).toBe('ABC123')
  })

  it('cutFrom に \\x1D(GS) を指定すると、GS1のような実データでもそれ以降を捨てる', () => {
    const gs1ish = `0100012345678905${GS_CUT_FROM}17250101${GS_CUT_FROM}10ABC123DEF1`
    expect(applyTrimRules(gs1ish, rules({ cutFrom: GS_CUT_FROM }))).toBe('0100012345678905')
  })

  it('cutUpTo を指定すると、それより後ろを残す（マーカー自体は残らない）', () => {
    expect(applyTrimRules('STORE01-ABC123', rules({ cutUpTo: '-' }))).toBe('ABC123')
  })

  it('マーカーが見つからない cutFrom/cutUpTo は無視される', () => {
    expect(applyTrimRules('ABC123', rules({ cutFrom: 'ZZZ', cutUpTo: 'ZZZ' }))).toBe('ABC123')
  })

  it('空文字の cutFrom/cutUpTo は無効（何もしない）', () => {
    expect(applyTrimRules('ABC123', rules({ cutFrom: '', cutUpTo: '' }))).toBe('ABC123')
  })
})

describe('applyTrimRules - 適用順序', () => {
  it('cutUpTo → cutFrom → 接頭辞 → 接尾辞 → 空白除去 の順で適用される', () => {
    // "ABCxDEFGHIyJKL" に対して:
    //  1. cutUpTo="x"    : "ABCx" を捨てる         → "DEFGHIyJKL"
    //  2. cutFrom="y"    : "y" 以降を捨てる         → "DEFGHI"
    //  3. prefix="DEF"   : 先頭の "DEF" を取り除く  → "GHI"
    //  4. suffix="HI"    : 末尾の "HI" を取り除く   → "G"
    //  5. trimWhitespace : 空白なし・変化なし        → "G"
    // 順序が違えば同じ結果にはならない組み合わせになっている。
    const result = applyTrimRules(
      'ABCxDEFGHIyJKL',
      rules({ cutUpTo: 'x', cutFrom: 'y', stripPrefixes: ['DEF'], stripSuffixes: ['HI'], trimWhitespace: true }),
    )
    expect(result).toBe('G')
  })

  it('trimWhitespace は最後に適用される（接頭辞/接尾辞除去後にできた空白も除去できる）', () => {
    const result = applyTrimRules('  ABC123  ', rules({ trimWhitespace: true }))
    expect(result).toBe('ABC123')
  })
})

describe('applyTrimRules - 無効化・フォールバック', () => {
  it('enabled: false のときは入力をそのまま返す', () => {
    const value = 'ABC123'
    const disabled: TrimRules = { ...DEFAULT_TRIM_RULES, enabled: false, stripPrefixes: ['ABC'] }
    expect(applyTrimRules(value, disabled)).toBe(value)
  })

  it('ルール適用で結果が空文字になる場合は元の値をそのまま返す', () => {
    expect(applyTrimRules('ABC', rules({ stripPrefixes: ['ABC'] }))).toBe('ABC')
  })

  it('cutFrom がマーカー自体を含めて先頭から全て捨ててしまう場合も元の値を返す', () => {
    expect(applyTrimRules('ABC', rules({ cutUpTo: 'ABC' }))).toBe('ABC')
  })
})

describe('applyTrimRules - 例外を投げない', () => {
  it('空文字を渡しても例外を投げず空文字を返す', () => {
    expect(() => applyTrimRules('', rules({ cutFrom: 'x' }))).not.toThrow()
    expect(applyTrimRules('', rules({ cutFrom: 'x' }))).toBe('')
  })

  it('ルールが壊れていても（配列でない等）例外を投げず元の値を返す', () => {
    const broken = { ...DEFAULT_TRIM_RULES, enabled: true, stripPrefixes: null } as unknown as TrimRules
    expect(() => applyTrimRules('ABC123', broken)).not.toThrow()
    expect(applyTrimRules('ABC123', broken)).toBe('ABC123')
  })

  it('rules 自体が null/undefined でも例外を投げず入力をそのまま返す', () => {
    expect(applyTrimRules('ABC123', null as unknown as TrimRules)).toBe('ABC123')
    expect(applyTrimRules('ABC123', undefined as unknown as TrimRules)).toBe('ABC123')
  })
})

describe('escapeRuleText / unescapeRuleText', () => {
  it('\\t \\n \\x1D および素のバックスラッシュを実文字に変換する', () => {
    expect(unescapeRuleText('\\t')).toBe('\t')
    expect(unescapeRuleText('\\n')).toBe('\n')
    expect(unescapeRuleText('\\x1D')).toBe('\x1D')
    expect(unescapeRuleText('\\\\')).toBe('\\')
  })

  it('\\GS は \\x1D のエイリアスとして GS(0x1D) に変換する', () => {
    expect(unescapeRuleText('\\GS')).toBe('\x1D')
    expect(unescapeRuleText('\\gs')).toBe('\x1D')
  })

  it('タブ・改行・GS・バックスラッシュを含む実文字列は escape→unescape で往復一致する', () => {
    const original = `AB\tCD\nEF${GS_CUT_FROM}GH\\IJ`
    expect(unescapeRuleText(escapeRuleText(original))).toBe(original)
  })

  it('該当しないバックスラッシュ表記はそのまま残す', () => {
    expect(unescapeRuleText('\\a')).toBe('\\a')
  })

  it('空文字を渡しても例外を投げない', () => {
    expect(() => escapeRuleText('')).not.toThrow()
    expect(() => unescapeRuleText('')).not.toThrow()
    expect(escapeRuleText('')).toBe('')
    expect(unescapeRuleText('')).toBe('')
  })
})
