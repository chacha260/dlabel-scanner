// アプリ全体設定の永続化 API。

import { getDb, DEFAULT_SETTINGS, SETTINGS_KEY, type AppSettings } from './db'

/** 保存済み設定を取得する。DEFAULT_SETTINGS にマージするので新しい設定項目が増えても壊れない */
export async function getSettings(): Promise<AppSettings> {
  const db = await getDb()
  const stored = await db.get('settings', SETTINGS_KEY)
  return { ...DEFAULT_SETTINGS, ...stored }
}

/** 設定の一部を更新して保存する */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const db = await getDb()
  const current = await getSettings()
  const next: AppSettings = { ...current, ...patch }
  await db.put('settings', next, SETTINGS_KEY)
  return next
}
