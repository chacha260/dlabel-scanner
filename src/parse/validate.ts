// フィールド値のバリデーション。日本語のエラーメッセージを返す。

import type { FieldRule } from './types'

export function validateValue(value: string, rule: FieldRule): string | undefined {
  const v = rule.validate
  if (!v) return undefined

  if (v.minLen !== undefined && value.length < v.minLen) {
    return `${v.minLen}文字以上で入力してください`
  }

  if (v.maxLen !== undefined && value.length > v.maxLen) {
    return `${v.maxLen}文字以内で入力してください`
  }

  if (v.pattern) {
    try {
      const re = new RegExp(`^(?:${v.pattern})$`)
      if (!re.test(value)) {
        return '形式が正しくありません'
      }
    } catch {
      // 不正な正規表現はバリデーション対象外として扱う
      return undefined
    }
  }

  return undefined
}
