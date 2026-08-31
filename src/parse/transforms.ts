// 抽出済み文字列に対する変換処理。順番に適用する。

import type { TransformStep } from './types'

function stripLeadingZeros(value: string): string {
  // 符号を保持しつつ、先頭の連続する '0' を取り除く。
  // 全て 0 の場合は '0' を 1 桁残す。
  const m = /^([+-]?)0*(\d.*)?$/.exec(value)
  if (!m) return value
  const [, sign, rest] = m
  if (rest === undefined || rest.length === 0) {
    // 数字部分が丸ごと 0 だった、または数字自体が無かった
    return /^[+-]?0+$/.test(value) ? `${sign}0` : value
  }
  return `${sign}${rest}`
}

function toNumber(value: string): string {
  const trimmed = value.trim()
  if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    return value
  }
  const n = Number(trimmed)
  if (Number.isNaN(n)) return value
  return String(n)
}

function applyReplace(
  value: string,
  pattern: string,
  flags: string,
  replacement: string,
): string {
  try {
    const re = new RegExp(pattern, flags)
    return value.replace(re, replacement)
  } catch {
    return value
  }
}

export function applyTransforms(value: string, steps: TransformStep[]): string {
  let result = value
  for (const step of steps) {
    switch (step.kind) {
      case 'trim':
        result = result.trim()
        break
      case 'upper':
        result = result.toUpperCase()
        break
      case 'lower':
        result = result.toLowerCase()
        break
      case 'stripLeadingZeros':
        result = stripLeadingZeros(result)
        break
      case 'toNumber':
        result = toNumber(result)
        break
      case 'slice':
        result = result.slice(step.start, step.end)
        break
      case 'replace':
        result = applyReplace(result, step.pattern, step.flags, step.replacement)
        break
      default:
        break
    }
  }
  return result
}
