// スキャン確定レコードの永続化 API。

import { getDb, type ScanRecord } from './db'
import type { ParsedRecord, Profile, RawScan } from '../parse/types'

/** ID を採番する。crypto.randomUUID が使えない環境向けのフォールバック付き */
function generateRecordId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `record-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export type SaveRecordInput = {
  parsed: ParsedRecord
  profile: Profile
  rawScans: RawScan[]
  note?: string
}

/** パース結果・プロファイル・生データから ScanRecord を組み立てて保存する */
export async function saveRecord(input: SaveRecordInput): Promise<ScanRecord> {
  const { parsed, profile, rawScans, note } = input

  const values: ScanRecord['values'] = {}
  for (const [key, fv] of Object.entries(parsed.values)) {
    values[key] = { key: fv.key, label: fv.label, value: fv.value, source: fv.source }
  }

  const columns = profile.fields.map((f) => ({ key: f.key, label: f.label }))

  const record: ScanRecord = {
    id: generateRecordId(),
    profileId: profile.id,
    profileName: profile.name,
    at: Date.now(),
    values,
    columns,
    rawScans,
    ...(note !== undefined ? { note } : {}),
  }

  const db = await getDb()
  await db.put('records', record)
  return record
}

export type RecordFilter = {
  profileId?: string
  from?: number
  to?: number
  limit?: number
}

/** 記録済みレコードを新しい順に取得する。日時の範囲指定は at インデックスを使う */
export async function listRecords(filter: RecordFilter = {}): Promise<ScanRecord[]> {
  const db = await getDb()
  const { profileId, from, to, limit } = filter

  const result: ScanRecord[] = []

  if (from !== undefined || to !== undefined) {
    const range = IDBKeyRange.bound(from ?? -Infinity, to ?? Infinity)
    let cursor = await db.transaction('records').store.index('at').openCursor(range, 'prev')
    while (cursor) {
      const rec = cursor.value
      if (!profileId || rec.profileId === profileId) {
        result.push(rec)
        if (limit !== undefined && result.length >= limit) break
      }
      cursor = await cursor.continue()
    }
    return result
  }

  let cursor = await db.transaction('records').store.index('at').openCursor(null, 'prev')
  while (cursor) {
    const rec = cursor.value
    if (!profileId || rec.profileId === profileId) {
      result.push(rec)
      if (limit !== undefined && result.length >= limit) break
    }
    cursor = await cursor.continue()
  }
  return result
}

/** id を指定してレコードを取得する */
export async function getRecord(id: string): Promise<ScanRecord | undefined> {
  const db = await getDb()
  return db.get('records', id)
}

/** レコードを更新（上書き保存）する */
export async function updateRecord(rec: ScanRecord): Promise<ScanRecord> {
  const db = await getDb()
  await db.put('records', rec)
  return rec
}

/** レコードを 1 件削除する */
export async function deleteRecord(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('records', id)
}

/** レコードを複数件削除する */
export async function deleteRecords(ids: string[]): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('records', 'readwrite')
  await Promise.all(ids.map((id) => tx.store.delete(id)))
  await tx.done
}

/** レコードを全件削除する。profileId を指定するとそのプロファイル分のみ削除する */
export async function clearRecords(profileId?: string): Promise<void> {
  const db = await getDb()
  if (!profileId) {
    await db.clear('records')
    return
  }
  const tx = db.transaction('records', 'readwrite')
  let cursor = await tx.store.index('profileId').openCursor(IDBKeyRange.only(profileId))
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}

/** 条件に合うレコード件数を数える */
export async function countRecords(filter: RecordFilter = {}): Promise<number> {
  const db = await getDb()
  const { profileId } = filter
  if (!profileId && filter.from === undefined && filter.to === undefined) {
    return db.count('records')
  }
  // 範囲・プロファイル指定がある場合は listRecords と同じロジックで数える
  const records = await listRecords({ ...filter, limit: undefined })
  return records.length
}
