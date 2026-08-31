// 文字列の分割と、単一ルールに対するマッチングを行う純粋関数群。

import type { FieldRule } from './types'

/** 正規表現の特殊文字をエスケープする */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * text を delimiters に含まれるいずれかの区切り文字列で分割する。
 * 空セグメントは除去する。collapseSpaces が true の場合、
 * 分割前に連続する空白文字を 1 個にまとめる。
 */
export function splitByDelimiters(
  text: string,
  delimiters: string[],
  collapseSpaces: boolean,
): string[] {
  let source = text
  if (collapseSpaces) {
    source = source.replace(/\s+/g, ' ')
  }

  const validDelimiters = delimiters.filter((d) => d.length > 0)
  if (validDelimiters.length === 0) {
    return source.length > 0 ? [source] : []
  }

  const pattern = validDelimiters.map(escapeRegExp).join('|')
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch {
    return source.length > 0 ? [source] : []
  }

  return source
    .split(regex)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * 単一のルールの matcher を candidate 文字列に適用し、
 * 抽出された部分文字列を返す。適用できない場合は null。
 * index / rest はここでは扱わない（位置情報が必要なため engine.ts 側で処理する）。
 */
export function matchField(text: string, rule: FieldRule): string | null {
  const matcher = rule.match

  switch (matcher.kind) {
    case 'prefix': {
      const { value, strip, caseSensitive } = matcher
      if (value.length === 0) return null
      const haystack = caseSensitive ? text : text.toLowerCase()
      const needle = caseSensitive ? value : value.toLowerCase()
      if (!haystack.startsWith(needle)) return null
      return strip ? text.slice(value.length) : text
    }

    case 'fixed': {
      const { start, length } = matcher
      if (start < 0 || length < 0) return null
      if (text.length < start) return null
      return text.substring(start, start + length)
    }

    case 'regex': {
      try {
        const re = new RegExp(matcher.pattern, matcher.flags ?? '')
        const m = re.exec(text)
        if (!m) return null
        const group = matcher.group ?? 0
        const extracted = m[group]
        return extracted ?? null
      } catch {
        return null
      }
    }

    case 'index':
    case 'rest':
      // 位置情報・フォールバック処理は engine.ts で扱う
      return null

    default:
      return null
  }
}
