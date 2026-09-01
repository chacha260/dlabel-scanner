// IndexedDB のスキーマ定義とデータベースハンドルの遅延シングルトン。
// UI からは profiles.ts / records.ts / settings.ts 経由でのみアクセスする。

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { PRESET_PROFILES } from '../parse/presets'
import type { Profile, RawScan } from '../parse/types'

const DB_NAME = 'dlabel-scanner'
const DB_VERSION = 2

/** スキャン確定時のレコード。プロファイルが後で編集・削除されても履歴が読めるようスナップショットを保持する */
export type ScanRecord = {
  id: string
  profileId: string
  profileName: string // 定義が後で消えても履歴が読めるようスナップショットする
  at: number // epoch ms
  values: Record<string, { key: string; label: string; value: string; source: string }>
  columns: { key: string; label: string }[] // 確定時点の列順を保存（CSV の列順に使う）
  rawScans: RawScan[] // 生データ（「生データ表示」機能とトラブルシュートのため必ず残す）
  note?: string
}

export type AppSettings = {
  activeProfileId: string
  beep: boolean
  vibrate: boolean
  dedupeMs: number
  csvDelimiter: ',' | '\t'
  csvBom: boolean
  ocrWhitelist: string
  ocrPsm: '6' | '7' | '8'
  showRawData: boolean // スキャン画面で生データ（パース前の文字列）を表示するか
}

export const DEFAULT_SETTINGS: AppSettings = {
  activeProfileId: '',
  beep: true,
  vibrate: true,
  dedupeMs: 1500,
  csvDelimiter: ',',
  csvBom: true,
  ocrWhitelist: '',
  ocrPsm: '6',
  showRawData: false,
}

export const SETTINGS_KEY = 'app'

/**
 * 組み立て中（未確定）のスキャンバッファのスナップショット。
 * タブがOSに回収されたり、Service Worker 更新でリロードされたりしても
 * 作業中のデータを失わないよう、一定間隔で drafts ストアへ書き出す。
 * キーは常に 'current' の単一レコードのみを使う（同時に1件しか組み立てないため）。
 */
export type ScanDraft = {
  id: 'current'
  profileId: string
  rawScans: RawScan[]
  fieldOverrides: Record<string, RawScan> // フィールドごとの手入力/部分OCRによる上書き
  updatedAt: number // epoch ms
}

export const DRAFT_ID: ScanDraft['id'] = 'current'

interface DLabelDB extends DBSchema {
  profiles: {
    key: string
    value: Profile
  }
  records: {
    key: string
    value: ScanRecord
    indexes: { at: number; profileId: string }
  }
  settings: {
    key: string
    value: AppSettings
  }
  drafts: {
    key: string
    value: ScanDraft
  }
}

let dbPromise: Promise<IDBPDatabase<DLabelDB>> | null = null

function openDatabase(): Promise<IDBPDatabase<DLabelDB>> {
  return openDB<DLabelDB>(DB_NAME, DB_VERSION, {
    // oldVersion を使って「新規作成」と「マイグレーション」を明確に分岐する。
    // これにより、既存ユーザーの profiles / records / settings は
    // バージョンアップ時に一切触れられず、プリセットの再投入も起きない。
    async upgrade(db, oldVersion, _newVersion, transaction) {
      // oldVersion === 0: DB がまだ存在しない完全な新規作成。
      // ストア作成とプリセット投入は、この分岐の中でのみ行う。
      if (oldVersion < 1) {
        db.createObjectStore('profiles', { keyPath: 'id' })
        const recordsStore = db.createObjectStore('records', { keyPath: 'id' })
        recordsStore.createIndex('at', 'at')
        recordsStore.createIndex('profileId', 'profileId')
        db.createObjectStore('settings')

        const profileStore = transaction.objectStore('profiles')
        await Promise.all(PRESET_PROFILES.map((p) => profileStore.put(p)))
        await transaction
          .objectStore('settings')
          .put({ ...DEFAULT_SETTINGS, activeProfileId: PRESET_PROFILES[0]?.id ?? '' }, SETTINGS_KEY)
      }

      // v1 -> v2: 作業中バッファ保存用の drafts ストアを追加するだけ。
      // 既存の profiles / records / settings には一切触れない。
      // （ここで PRESET_PROFILES を再投入すると、既存ユーザーが編集した
      //   プロファイルを上書きしてしまうため、絶対に行わない）
      if (oldVersion < 2 && !db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'id' })
      }
    },
  })
}

/** DB ハンドルの遅延シングルトンを取得する。どの関数からも安全に await できる */
export function getDb(): Promise<IDBPDatabase<DLabelDB>> {
  if (!dbPromise) {
    dbPromise = openDatabase()
  }
  return dbPromise
}

export type { DLabelDB }
