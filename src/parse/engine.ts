// バーコード / OCR のスキャン結果をプロファイルに従ってフィールドへ変換するエンジン。
// React や DOM に依存しない純粋関数のみで構成する。

import { splitByDelimiters, matchField } from './matchers'
import { applyTransforms } from './transforms'
import { validateValue } from './validate'
import type { FieldRule, FieldValue, ParsedRecord, Profile, RawScan } from './types'

type Candidate = {
  text: string
  source: RawScan['source']
  segmentIndex: number
  scan: RawScan
}

/** ルールが候補の source を受理できるかどうか */
function ruleAccepts(rule: FieldRule, source: RawScan['source']): boolean {
  if (rule.source === 'both') return true
  if (source === 'manual') return true // 手入力はどのルールにも入力できる
  return rule.source === source
}

/** 候補を分割してマッチング対象のリストを作る */
function buildCandidates(scans: RawScan[], profile: Profile): Candidate[] {
  const candidates: Candidate[] = []
  const delimiters = profile.delimiters ?? []

  for (const scan of scans) {
    if (profile.splitMode === 'splitOne') {
      const segments = splitByDelimiters(scan.value, delimiters, profile.collapseSpaces)
      segments.forEach((segment, index) => {
        candidates.push({ text: segment, source: scan.source, segmentIndex: index, scan })
      })
    } else {
      candidates.push({ text: scan.value, source: scan.source, segmentIndex: 0, scan })
    }
  }

  return candidates
}

type MatchResult = { rule: FieldRule; extracted: string } | null

/**
 * 1 つの候補に対して最初にマッチするルールを優先順位に従って探す。
 * 優先順位: prefix（値が長い順） → fixed → regex → index → rest（フォールバック）
 */
function findMatchingRule(candidate: Candidate, fields: FieldRule[]): MatchResult {
  const applicable = fields.filter((rule) => ruleAccepts(rule, candidate.source))

  const prefixRules = applicable
    .filter((r) => r.match.kind === 'prefix')
    .sort((a, b) => {
      const av = a.match.kind === 'prefix' ? a.match.value.length : 0
      const bv = b.match.kind === 'prefix' ? b.match.value.length : 0
      return bv - av
    })
  for (const rule of prefixRules) {
    const extracted = matchField(candidate.text, rule)
    if (extracted !== null) return { rule, extracted }
  }

  const fixedRules = applicable.filter((r) => r.match.kind === 'fixed')
  for (const rule of fixedRules) {
    const extracted = matchField(candidate.text, rule)
    if (extracted !== null) return { rule, extracted }
  }

  const regexRules = applicable.filter((r) => r.match.kind === 'regex')
  for (const rule of regexRules) {
    const extracted = matchField(candidate.text, rule)
    if (extracted !== null) return { rule, extracted }
  }

  const indexRules = applicable.filter((r) => r.match.kind === 'index')
  for (const rule of indexRules) {
    if (rule.match.kind === 'index' && rule.match.index === candidate.segmentIndex) {
      return { rule, extracted: candidate.text }
    }
  }

  const restRules = applicable.filter((r) => r.match.kind === 'rest')
  if (restRules.length > 0) {
    return { rule: restRules[0], extracted: candidate.text }
  }

  return null
}

export function applyProfile(scans: RawScan[], profile: Profile): ParsedRecord {
  const fields = Array.isArray(profile.fields) ? profile.fields : []
  const values: Record<string, FieldValue> = {}
  const unmatched: RawScan[] = []

  let candidates: Candidate[] = []
  try {
    candidates = buildCandidates(scans ?? [], profile)
  } catch {
    candidates = []
  }

  for (const candidate of candidates) {
    let result: MatchResult = null
    try {
      result = findMatchingRule(candidate, fields)
    } catch {
      result = null
    }

    if (!result) {
      unmatched.push({
        value: candidate.text,
        source: candidate.scan.source,
        format: candidate.scan.format,
        at: candidate.scan.at,
      })
      continue
    }

    const { rule, extracted } = result
    const value = applyTransforms(extracted, rule.transforms ?? [])
    const error = validateValue(value, rule)

    values[rule.key] = {
      key: rule.key,
      label: rule.label,
      value,
      raw: extracted,
      source: candidate.source,
      error,
    }
  }

  const missingRequired: string[] = []
  for (const rule of fields) {
    if (!rule.required) continue
    const fv = values[rule.key]
    if (!fv || fv.error) {
      missingRequired.push(rule.key)
    }
  }

  const complete = profile.completeWhen === 'manual' ? true : missingRequired.length === 0

  return {
    profileId: profile.id,
    values,
    unmatched,
    missingRequired,
    complete,
  }
}

// ---- ID 生成 ----

let idCounter = 0

function generateId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  idCounter += 1
  return `${prefix}-${Date.now()}-${idCounter}`
}

export function newProfileId(): string {
  return generateId('profile')
}

export function newFieldId(): string {
  return generateId('field')
}

// ---- JSON シリアライズ / パース ----

export function serializeProfile(p: Profile): string {
  return JSON.stringify(p, null, 2)
}

function isValidFieldRuleShape(data: unknown): data is FieldRule {
  if (typeof data !== 'object' || data === null) return false
  const f = data as Record<string, unknown>
  if (typeof f.id !== 'string') return false
  if (typeof f.label !== 'string') return false
  if (typeof f.key !== 'string') return false
  if (f.source !== 'barcode' && f.source !== 'ocr' && f.source !== 'both') return false
  if (typeof f.match !== 'object' || f.match === null) return false
  if (!Array.isArray(f.transforms)) return false
  if (typeof f.required !== 'boolean') return false
  return true
}

function isValidProfileShape(data: unknown): data is Profile {
  if (typeof data !== 'object' || data === null) return false
  const p = data as Record<string, unknown>
  if (typeof p.id !== 'string') return false
  if (typeof p.name !== 'string') return false
  if (p.splitMode !== 'perBarcode' && p.splitMode !== 'splitOne') return false
  if (!Array.isArray(p.delimiters) || !p.delimiters.every((d) => typeof d === 'string')) {
    return false
  }
  if (typeof p.collapseSpaces !== 'boolean') return false
  if (!Array.isArray(p.fields) || !p.fields.every(isValidFieldRuleShape)) return false
  if (p.completeWhen !== 'allRequired' && p.completeWhen !== 'manual') return false
  return true
}

export function parseProfileJson(text: string): Profile | { error: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { error: 'JSON の解析に失敗しました' }
  }

  if (!isValidProfileShape(data)) {
    return { error: 'プロファイルの形式が正しくありません' }
  }

  return data
}
