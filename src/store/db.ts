// IndexedDB のスキーマ定義とデータベースハンドルの遅延シングルトン。
// UI からは profiles.ts / records.ts / settings.ts 経由でのみアクセスする。

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { PRESET_PROFILES } from '../parse/presets'
import type { Profile, RawScan } from '../parse/types'

const DB_NAME = 'dlabel-scanner'
const DB_VERSION = 1

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
}

let dbPromise: Promise<IDBPDatabase<DLabelDB>> | null = null

function openDatabase(): Promise<IDBPDatabase<DLabelDB>> {
  return openDB<DLabelDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('profiles')) {
        db.createObjectStore('profiles', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('records')) {
        const store = db.createObjectStore('records', { keyPath: 'id' })
        store.createIndex('at', 'at')
        store.createIndex('profileId', 'profileId')
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings')
      }
    },
  }).then(async (db) => {
    // 初回起動時のみ、プリセットと既定設定を投入する
    const profileCount = await db.count('profiles')
    if (profileCount === 0) {
      const tx = db.transaction('profiles', 'readwrite')
      await Promise.all(PRESET_PROFILES.map((p) => tx.store.put(p)))
      await tx.done
    }

    const existingSettings = await db.get('settings', SETTINGS_KEY)
    if (!existingSettings) {
      await db.put(
        'settings',
        { ...DEFAULT_SETTINGS, activeProfileId: PRESET_PROFILES[0]?.id ?? '' },
        SETTINGS_KEY,
      )
    }

    return db
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
