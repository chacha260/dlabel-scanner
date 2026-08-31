// CSV / TSV 生成ロジック。DOM に依存しない純粋関数群（downloadCsv を除く）。

import type { ScanRecord } from '../store/db'

/** CSV フィールドをエスケープする。区切り文字・"・改行・前後の空白を含む場合は引用符で囲む */
export function escapeCsvField(value: string, delimiter: string): string {
  const needsQuote =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\r') ||
    value.includes('\n') ||
    value.startsWith(' ') ||
    value.endsWith(' ')

  if (!needsQuote) return value

  return `"${value.replace(/"/g, '""')}"`
}

const BOM = '﻿'

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

/** epoch ms をローカル時刻の YYYY-MM-DD HH:mm:ss 形式にする */
function formatDateTime(at: number): string {
  const d = new Date(at)
  const y = d.getFullYear()
  const mo = pad2(d.getMonth() + 1)
  const day = pad2(d.getDate())
  const h = pad2(d.getHours())
  const mi = pad2(d.getMinutes())
  const s = pad2(d.getSeconds())
  return `${y}-${mo}-${day} ${h}:${mi}:${s}`
}

/** 複数レコードの列を「初出順を保った和集合」として決定する */
function collectColumns(records: ScanRecord[]): { key: string; label: string }[] {
  const seen = new Map<string, string>()
  for (const rec of records) {
    for (const col of rec.columns) {
      if (!seen.has(col.key)) {
        seen.set(col.key, col.label)
      }
    }
  }
  return Array.from(seen, ([key, label]) => ({ key, label }))
}

export type BuildCsvOptions = {
  delimiter: ',' | '\t'
  bom: boolean
  includeMeta: boolean
}

/** レコード配列から CSV 文字列を組み立てる（Excel 互換の \r\n 改行） */
export function buildCsv(records: ScanRecord[], opts: BuildCsvOptions): string {
  const { delimiter, bom, includeMeta } = opts
  const columns = collectColumns(records)

  const headerCells: string[] = []
  if (includeMeta) {
    headerCells.push('日時', 'ラベル定義')
  }
  headerCells.push(...columns.map((c) => c.label))

  const lines: string[] = []
  lines.push(headerCells.map((c) => escapeCsvField(c, delimiter)).join(delimiter))

  for (const rec of records) {
    const cells: string[] = []
    if (includeMeta) {
      cells.push(formatDateTime(rec.at), rec.profileName)
    }
    for (const col of columns) {
      const value = rec.values[col.key]?.value ?? ''
      cells.push(value)
    }
    lines.push(cells.map((c) => escapeCsvField(c, delimiter)).join(delimiter))
  }

  const body = lines.join('\r\n') + '\r\n'
  return bom ? BOM + body : body
}

/** クリップボード貼り付け用のタブ区切りテキストを組み立てる（BOM なし、\n 改行） */
export function buildTsvForClipboard(records: ScanRecord[]): string {
  const columns = collectColumns(records)

  const lines: string[] = []
  lines.push(columns.map((c) => escapeCsvField(c.label, '\t')).join('\t'))

  for (const rec of records) {
    const cells = columns.map((col) => rec.values[col.key]?.value ?? '')
    lines.push(cells.map((c) => escapeCsvField(c, '\t')).join('\t'))
  }

  return lines.join('\n')
}

/** CSV 文字列をファイルとしてダウンロードさせる（唯一 DOM に依存する関数） */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** ファイル名として安全な文字列にサニタイズする */
function sanitizeForFilename(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** 既定の CSV ファイル名を生成する（例: dlabel_20260901_143012.csv） */
export function defaultCsvFilename(profileName?: string): string {
  const now = new Date()
  const y = now.getFullYear()
  const mo = pad2(now.getMonth() + 1)
  const d = pad2(now.getDate())
  const h = pad2(now.getHours())
  const mi = pad2(now.getMinutes())
  const s = pad2(now.getSeconds())
  const stamp = `${y}${mo}${d}_${h}${mi}${s}`

  const safeName = profileName ? sanitizeForFilename(profileName) : ''
  return safeName ? `dlabel_${safeName}_${stamp}.csv` : `dlabel_${stamp}.csv`
}
