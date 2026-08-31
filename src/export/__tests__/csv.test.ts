import { describe, expect, it } from 'vitest'
import {
  buildCsv,
  buildTsvForClipboard,
  defaultCsvFilename,
  escapeCsvField,
} from '../csv'
import type { ScanRecord } from '../../store/db'

function makeRecord(overrides: Partial<ScanRecord> = {}): ScanRecord {
  return {
    id: 'rec-1',
    profileId: 'profile-a',
    profileName: 'プロファイルA',
    at: new Date(2026, 0, 2, 3, 4, 5).getTime(), // 2026-01-02 03:04:05 ローカル
    values: {
      part_no: { key: 'part_no', label: '品番', value: 'ABC-123', source: 'barcode' },
      quantity: { key: 'quantity', label: '数量', value: '10', source: 'barcode' },
    },
    columns: [
      { key: 'part_no', label: '品番' },
      { key: 'quantity', label: '数量' },
    ],
    rawScans: [],
    ...overrides,
  }
}

describe('escapeCsvField', () => {
  it('区切り文字を含む値は引用符で囲む', () => {
    expect(escapeCsvField('a,b', ',')).toBe('"a,b"')
  })

  it('区切り文字を含まなければそのまま返す', () => {
    expect(escapeCsvField('abc', ',')).toBe('abc')
  })

  it('" を含む値は引用符で囲み、内部の " を二重にする', () => {
    expect(escapeCsvField('say "hi"', ',')).toBe('"say ""hi"""')
  })

  it('改行を含む値は引用符で囲む', () => {
    expect(escapeCsvField('line1\nline2', ',')).toBe('"line1\nline2"')
    expect(escapeCsvField('line1\rline2', ',')).toBe('"line1\rline2"')
  })

  it('前後に空白がある値は引用符で囲む', () => {
    expect(escapeCsvField(' abc', ',')).toBe('" abc"')
    expect(escapeCsvField('abc ', ',')).toBe('"abc "')
  })

  it('タブ区切りモードではカンマだけを含む値を引用符で囲まない', () => {
    expect(escapeCsvField('a,b', '\t')).toBe('a,b')
  })

  it('タブ区切りモードではタブを含む値を引用符で囲む', () => {
    expect(escapeCsvField('a\tb', '\t')).toBe('"a\tb"')
  })
})

describe('buildCsv - BOM', () => {
  it('bom: true のとき先頭に一度だけ BOM が付く', () => {
    const csv = buildCsv([makeRecord()], { delimiter: ',', bom: true, includeMeta: false })
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv.indexOf('﻿')).toBe(0)
    expect(csv.slice(1).includes('﻿')).toBe(false)
  })

  it('bom: false のとき BOM が付かない', () => {
    const csv = buildCsv([makeRecord()], { delimiter: ',', bom: false, includeMeta: false })
    expect(csv.includes('﻿')).toBe(false)
  })
})

describe('buildCsv - 列の和集合', () => {
  it('異なるプロファイルのレコードでも初出順を保った列の和集合になる', () => {
    const recordA = makeRecord({
      id: 'rec-a',
      profileId: 'profile-a',
      profileName: 'A',
      values: {
        part_no: { key: 'part_no', label: '品番', value: 'P1', source: 'barcode' },
        quantity: { key: 'quantity', label: '数量', value: '5', source: 'barcode' },
      },
      columns: [
        { key: 'part_no', label: '品番' },
        { key: 'quantity', label: '数量' },
      ],
    })
    const recordB = makeRecord({
      id: 'rec-b',
      profileId: 'profile-b',
      profileName: 'B',
      values: {
        quantity: { key: 'quantity', label: '数量', value: '9', source: 'ocr' },
        lot_no: { key: 'lot_no', label: 'ロット', value: 'L1', source: 'ocr' },
      },
      columns: [
        { key: 'quantity', label: '数量' },
        { key: 'lot_no', label: 'ロット' },
      ],
    })

    const csv = buildCsv([recordA, recordB], { delimiter: ',', bom: false, includeMeta: false })
    const [header, rowA, rowB] = csv.trim().split('\r\n')

    expect(header).toBe('品番,数量,ロット')
    expect(rowA).toBe('P1,5,') // rec-a に lot_no がないので空セル
    expect(rowB).toBe(',9,L1') // rec-b に part_no がないので空セル（列がずれない）
  })
})

describe('buildCsv - includeMeta', () => {
  it('日時とラベル定義を先頭 2 列として追加する', () => {
    const csv = buildCsv([makeRecord()], { delimiter: ',', bom: false, includeMeta: true })
    const [header, row] = csv.trim().split('\r\n')
    expect(header).toBe('日時,ラベル定義,品番,数量')
    expect(row.startsWith('2026-01-02 03:04:05,プロファイルA,')).toBe(true)
  })
})

describe('buildCsv - 改行コード', () => {
  it('各行が \\r\\n で終端される', () => {
    const csv = buildCsv([makeRecord(), makeRecord({ id: 'rec-2' })], {
      delimiter: ',',
      bom: false,
      includeMeta: false,
    })
    const parts = csv.split('\r\n')
    // header + 2 records + 末尾の空文字列（最終行にも \r\n が付くため）
    expect(parts.length).toBe(4)
    expect(parts[parts.length - 1]).toBe('')
    expect(csv.includes('\n') && !csv.includes('\r\n')).toBe(false)
  })
})

describe('buildTsvForClipboard', () => {
  it('タブ区切り・BOM なし・\\n 改行で出力する', () => {
    const tsv = buildTsvForClipboard([makeRecord()])
    expect(tsv.includes('﻿')).toBe(false)
    expect(tsv.includes('\r')).toBe(false)
    const [header, row] = tsv.split('\n')
    expect(header).toBe('品番\t数量')
    expect(row).toBe('ABC-123\t10')
  })
})

describe('defaultCsvFilename', () => {
  it('プロファイル名内の / ・空白・日本語文字をサニタイズしてファイル名に含める', () => {
    const name = defaultCsvFilename('A/B ラベル 定義')
    expect(name).toMatch(/^dlabel_.*_\d{8}_\d{6}\.csv$/)
    expect(name).not.toContain('/')
    expect(name).not.toContain(' ')
  })

  it('プロファイル名がなければ日時のみのファイル名になる', () => {
    const name = defaultCsvFilename()
    expect(name).toMatch(/^dlabel_\d{8}_\d{6}\.csv$/)
  })
})
