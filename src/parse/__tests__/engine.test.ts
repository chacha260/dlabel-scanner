import { describe, expect, it } from 'vitest'
import { applyProfile, parseProfileJson, serializeProfile } from '../engine'
import { applyTransforms } from '../transforms'
import { matchField, splitByDelimiters } from '../matchers'
import { PRESET_PROFILES } from '../presets'
import type { FieldRule, Profile, RawScan } from '../types'

function scan(value: string, source: RawScan['source'] = 'barcode', at = 1): RawScan {
  return { value, source, at }
}

describe('applyProfile - 接頭辞方式プリセット', () => {
  const profile = PRESET_PROFILES[0]

  it('P / Q / 1T の接頭辞からそれぞれの値を抽出する', () => {
    const record = applyProfile(
      [scan('P1234-5678'), scan('Q100'), scan('1TLOT-A01')],
      profile,
    )

    expect(record.values.part_no.value).toBe('1234-5678')
    expect(record.values.quantity.value).toBe('100')
    expect(record.values.lot_no.value).toBe('LOT-A01')
  })
})

describe('applyProfile - 接頭辞の優先順位', () => {
  const conflictingProfile: Profile = {
    id: 'test-prefix-conflict',
    name: 'テスト用（1 vs 1T）',
    splitMode: 'perBarcode',
    delimiters: [],
    collapseSpaces: false,
    completeWhen: 'allRequired',
    fields: [
      {
        id: 'f-one',
        label: 'ワン',
        key: 'one',
        source: 'both',
        match: { kind: 'prefix', value: '1', strip: true, caseSensitive: false },
        transforms: [],
        required: false,
      },
      {
        id: 'f-oneT',
        label: 'ワンティー',
        key: 'oneT',
        source: 'both',
        match: { kind: 'prefix', value: '1T', strip: true, caseSensitive: false },
        transforms: [],
        required: false,
      },
    ],
  }

  it('より長い接頭辞 1T が短い接頭辞 1 より優先される', () => {
    const record = applyProfile([scan('1TLOT-A01')], conflictingProfile)

    expect(record.values.oneT).toBeDefined()
    expect(record.values.oneT.value).toBe('LOT-A01')
    expect(record.values.one).toBeUndefined()
  })

  const tripleProfile: Profile = {
    id: 'test-prefix-triple',
    name: 'テスト用（30P vs P vs 3）',
    splitMode: 'perBarcode',
    delimiters: [],
    collapseSpaces: false,
    completeWhen: 'allRequired',
    fields: [
      {
        id: 'f-p',
        label: 'P',
        key: 'p',
        source: 'both',
        match: { kind: 'prefix', value: 'P', strip: true, caseSensitive: false },
        transforms: [],
        required: false,
      },
      {
        id: 'f-three',
        label: '3',
        key: 'three',
        source: 'both',
        match: { kind: 'prefix', value: '3', strip: true, caseSensitive: false },
        transforms: [],
        required: false,
      },
      {
        id: 'f-30p',
        label: '30P',
        key: 'thirtyP',
        source: 'both',
        match: { kind: 'prefix', value: '30P', strip: true, caseSensitive: false },
        transforms: [],
        required: false,
      },
    ],
  }

  it('30P が P と 3 のどちらよりも優先される', () => {
    const record = applyProfile([scan('30P998')], tripleProfile)

    expect(record.values.thirtyP).toBeDefined()
    expect(record.values.thirtyP.value).toBe('998')
    expect(record.values.p).toBeUndefined()
    expect(record.values.three).toBeUndefined()
  })
})

describe('applyProfile - スペース区切りプリセット', () => {
  const profile = PRESET_PROFILES[1]

  it('1 件のバーコードを区切って 3 フィールドに割り当てる（連続スペースは 1 つに）', () => {
    const record = applyProfile([scan('ABC-123   50  LOT9')], profile)

    expect(Object.keys(record.values)).toHaveLength(3)
    expect(record.values.part_no.value).toBe('ABC-123')
    expect(record.values.quantity.value).toBe('50')
    expect(record.values.lot_no.value).toBe('LOT9')
  })
})

describe('matchers', () => {
  it('splitByDelimiters は複数の区切り文字と連続スペースを扱える', () => {
    expect(splitByDelimiters('ABC-123 50 LOT9', [' ', '\t'], true)).toEqual([
      'ABC-123',
      '50',
      'LOT9',
    ])
    expect(splitByDelimiters('a,b,,c', [','], false)).toEqual(['a', 'b', 'c'])
  })

  it('fixed マッチャーは指定位置の部分文字列を抽出する', () => {
    const rule: FieldRule = {
      id: 'fixed-rule',
      label: '固定位置',
      key: 'fixed_field',
      source: 'both',
      match: { kind: 'fixed', start: 2, length: 4 },
      transforms: [],
      required: false,
    }

    expect(matchField('XX1234YY', rule)).toBe('1234')
  })

  it('regex マッチャーはキャプチャグループを抽出し、不正なパターンは例外を投げずに null を返す', () => {
    const okRule: FieldRule = {
      id: 'regex-rule-ok',
      label: '正規表現',
      key: 'regex_field',
      source: 'both',
      match: { kind: 'regex', pattern: '(\\d{3})-(\\d{2})', group: 1 },
      transforms: [],
      required: false,
    }
    expect(matchField('AB123-45CD', okRule)).toBe('123')

    const badRule: FieldRule = {
      id: 'regex-rule-bad',
      label: '不正な正規表現',
      key: 'bad_regex_field',
      source: 'both',
      match: { kind: 'regex', pattern: '(', group: 0 },
      transforms: [],
      required: false,
    }
    expect(() => matchField('AB123-45CD', badRule)).not.toThrow()
    expect(matchField('AB123-45CD', badRule)).toBeNull()
  })
})

describe('transforms', () => {
  it('stripLeadingZeros は先頭の 0 を除去する', () => {
    expect(applyTransforms('00045', [{ kind: 'stripLeadingZeros' }])).toBe('45')
    expect(applyTransforms('000', [{ kind: 'stripLeadingZeros' }])).toBe('0')
  })

  it('toNumber は数値として正規化し、数値化できない場合はそのまま返す', () => {
    expect(applyTransforms('0100', [{ kind: 'toNumber' }])).toBe('100')
    expect(applyTransforms('ABC', [{ kind: 'toNumber' }])).toBe('ABC')
  })

  it('upper は大文字化する', () => {
    expect(applyTransforms('abc', [{ kind: 'upper' }])).toBe('ABC')
  })

  it('slice は指定範囲を切り出す', () => {
    expect(applyTransforms('HelloWorld', [{ kind: 'slice', start: 0, end: 5 }])).toBe('Hello')
  })
})

describe('applyProfile - バリデーション', () => {
  const profile: Profile = {
    id: 'test-validate',
    name: 'テスト用バリデーション',
    splitMode: 'perBarcode',
    delimiters: [],
    collapseSpaces: false,
    completeWhen: 'allRequired',
    fields: [
      {
        id: 'f-part',
        label: '品番',
        key: 'part_no',
        source: 'both',
        match: { kind: 'prefix', value: 'P', strip: true, caseSensitive: false },
        transforms: [],
        required: true,
        validate: { pattern: '\\d{4}' },
      },
    ],
  }

  it('バリデーション NG の場合は error を持ち、missingRequired に残る', () => {
    const record = applyProfile([scan('PAB')], profile)

    expect(record.values.part_no.error).toBeDefined()
    expect(record.missingRequired).toContain('part_no')
    expect(record.complete).toBe(false)
  })

  it('バリデーション OK の場合は error が付かず missingRequired から外れる', () => {
    const record = applyProfile([scan('P1234')], profile)

    expect(record.values.part_no.error).toBeUndefined()
    expect(record.missingRequired).not.toContain('part_no')
    expect(record.complete).toBe(true)
  })
})

describe('applyProfile - completeWhen の意味論', () => {
  const baseFields: FieldRule[] = [
    {
      id: 'f-required',
      label: '必須項目',
      key: 'required_field',
      source: 'both',
      match: { kind: 'prefix', value: 'P', strip: true, caseSensitive: false },
      transforms: [],
      required: true,
    },
  ]

  it('allRequired: 必須項目が未入力なら complete は false', () => {
    const profile: Profile = {
      id: 'test-complete-all',
      name: 'allRequired',
      splitMode: 'perBarcode',
      delimiters: [],
      collapseSpaces: false,
      completeWhen: 'allRequired',
      fields: baseFields,
    }
    const record = applyProfile([], profile)
    expect(record.missingRequired).toContain('required_field')
    expect(record.complete).toBe(false)
  })

  it('manual: 必須項目が未入力でも complete は true', () => {
    const profile: Profile = {
      id: 'test-complete-manual',
      name: 'manual',
      splitMode: 'perBarcode',
      delimiters: [],
      collapseSpaces: false,
      completeWhen: 'manual',
      fields: baseFields,
    }
    const record = applyProfile([], profile)
    expect(record.missingRequired).toContain('required_field')
    expect(record.complete).toBe(true)
  })
})

describe('applyProfile - source の制約と上書き', () => {
  const profile: Profile = {
    id: 'test-source',
    name: 'テスト用ソース制約',
    splitMode: 'perBarcode',
    delimiters: [],
    collapseSpaces: false,
    completeWhen: 'allRequired',
    fields: [
      {
        id: 'f-barcode-only',
        label: 'バーコード専用',
        key: 'barcode_only',
        source: 'barcode',
        match: { kind: 'prefix', value: 'P', strip: true, caseSensitive: false },
        transforms: [],
        required: true,
      },
    ],
  }

  it('OCR スキャンは barcode 専用ルールに値を入れない', () => {
    const record = applyProfile([scan('P1234', 'ocr')], profile)

    expect(record.values.barcode_only).toBeUndefined()
    expect(record.unmatched).toHaveLength(1)
    expect(record.missingRequired).toContain('barcode_only')
  })

  it('barcode ソースなら正しく値が入る', () => {
    const record = applyProfile([scan('P1234', 'barcode')], profile)
    expect(record.values.barcode_only.value).toBe('1234')
  })

  it('同じフィールドへの再スキャンは後勝ちで上書きされる', () => {
    const record = applyProfile(
      [scan('P111', 'barcode', 1), scan('P222', 'barcode', 2)],
      profile,
    )
    expect(record.values.barcode_only.value).toBe('222')
  })
})

describe('プロファイルの JSON シリアライズ', () => {
  it('serializeProfile と parseProfileJson は往復して等しくなる', () => {
    const profile = PRESET_PROFILES[0]
    const result = parseProfileJson(serializeProfile(profile))
    expect(result).toEqual(profile)
  })

  it('壊れた JSON はエラーオブジェクトを返す', () => {
    const result = parseProfileJson('{ this is not valid json')
    expect(result).toHaveProperty('error')
  })

  it('形式が不正な JSON もエラーオブジェクトを返す', () => {
    const result = parseProfileJson(JSON.stringify({ foo: 'bar' }))
    expect(result).toHaveProperty('error')
  })
})
