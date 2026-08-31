// 現品票/Dラベルの読み取り値をフィールドに変換するための型定義。
// React や DOM に依存しない純粋なデータ構造のみを扱う。

export type TransformStep =
  | { kind: 'trim' }
  | { kind: 'upper' }
  | { kind: 'lower' }
  | { kind: 'stripLeadingZeros' }
  | { kind: 'toNumber' } // 数値化できなければ元の文字列のまま
  | { kind: 'slice'; start: number; end?: number }
  | { kind: 'replace'; pattern: string; flags: string; replacement: string }

export type Matcher =
  | { kind: 'prefix'; value: string; strip: boolean; caseSensitive: boolean }
  | { kind: 'index'; index: number } // 区切り後の n 番目 (0-based)
  | { kind: 'fixed'; start: number; length: number }
  | { kind: 'regex'; pattern: string; flags?: string; group: number }
  | { kind: 'rest' } // どのルールにも当たらなかった残り

export type FieldRule = {
  id: string
  label: string // 表示名 例: "品番"
  key: string // CSV列名 例: "part_no"
  source: 'barcode' | 'ocr' | 'both'
  match: Matcher
  transforms: TransformStep[]
  required: boolean
  validate?: { pattern?: string; minLen?: number; maxLen?: number }
}

export type Profile = {
  id: string
  name: string
  splitMode: 'perBarcode' | 'splitOne'
  delimiters: string[] // 例: [" ", "\t", ",", ""]
  collapseSpaces: boolean
  fields: FieldRule[]
  completeWhen: 'allRequired' | 'manual'
}

export type RawScan = {
  value: string
  source: 'barcode' | 'ocr' | 'manual'
  format?: string // 例: 'code_128'
  at: number // epoch ms
}

export type FieldValue = {
  key: string
  label: string
  value: string
  raw: string // 変換前の元文字列
  source: RawScan['source']
  error?: string // バリデーション NG の理由
}

export type ParsedRecord = {
  profileId: string
  values: Record<string, FieldValue>
  unmatched: RawScan[] // どのルールにも当てはまらなかったスキャン
  missingRequired: string[] // 未入力の必須フィールドの key
  complete: boolean
}
