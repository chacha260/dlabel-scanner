// 組み立て中（未確定）のスキャンバッファを IndexedDB に永続化するモジュール。
// タブがOSに回収されたり、Service Worker 更新でリロードされたりしても
// 作業中のデータを失わないようにするためのもの。React には依存しない
// （UI 側の呼び出しは ScanScreen.tsx から行う）。

import { getDb, DRAFT_ID, type ScanDraft } from './db'
import type { Profile } from '../parse/types'

export type { ScanDraft }
export { DRAFT_ID }

/** 下書きに実データが含まれているか（空のまま保存されている状態と区別するため） */
export function isDraftNonEmpty(draft: Pick<ScanDraft, 'rawScans' | 'fieldOverrides'>): boolean {
  return draft.rawScans.length > 0 || Object.keys(draft.fieldOverrides).length > 0
}

/** 復元バーに表示する「バーコードN件」の件数。生スキャン数とフィールド上書き数を合算する */
export function countDraftScans(draft: Pick<ScanDraft, 'rawScans' | 'fieldOverrides'>): number {
  return draft.rawScans.length + Object.keys(draft.fieldOverrides).length
}

/** 下書きが記録された時点のラベル定義が、現在も存在するかを調べる（削除済みなら undefined） */
export function resolveDraftProfile(draft: Pick<ScanDraft, 'profileId'>, profiles: Profile[]): Profile | undefined {
  return profiles.find((p) => p.id === draft.profileId)
}

/** 下書きを保存する（'current' の単一レコードとして上書き） */
export async function saveDraft(draft: Omit<ScanDraft, 'id'>): Promise<void> {
  const db = await getDb()
  await db.put('drafts', { ...draft, id: DRAFT_ID })
}

/** 保存済みの下書きを取得する。なければ undefined */
export async function loadDraft(): Promise<ScanDraft | undefined> {
  const db = await getDb()
  return db.get('drafts', DRAFT_ID)
}

/** 下書きを破棄する。確定（保存）時とクリア時に必ず呼ぶこと */
export async function clearDraft(): Promise<void> {
  const db = await getDb()
  await db.delete('drafts', DRAFT_ID)
}

// --- ScanScreen の外側（更新バナーなど）から「今すぐ下書きを保存し切る」を
//     呼び出せるようにするための小さな橋渡し。ScanScreen は常時マウントされて
//     いるため、その flush 関数をここに登録しておく。 ---

let pendingFlush: (() => Promise<void>) | null = null

/** ScanScreen が自身の flush 関数を登録する。アンマウント時は null を渡して解除する */
export function registerDraftFlush(fn: (() => Promise<void>) | null): void {
  pendingFlush = fn
}

/** SW 更新など、ScanScreen の外側から下書きの即時保存を要求する */
export function flushPendingDraft(): Promise<void> {
  return pendingFlush ? pendingFlush() : Promise.resolve()
}
