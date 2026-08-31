// ラベル定義（プロファイル）の永続化 API。

import { getDb } from './db'
import { newProfileId, parseProfileJson, serializeProfile } from '../parse/engine'
import type { Profile } from '../parse/types'

/** 登録されているプロファイル一覧を取得する */
export async function listProfiles(): Promise<Profile[]> {
  const db = await getDb()
  return db.getAll('profiles')
}

/** id を指定してプロファイルを取得する */
export async function getProfile(id: string): Promise<Profile | undefined> {
  const db = await getDb()
  return db.get('profiles', id)
}

/** プロファイルを新規作成・上書き保存する */
export async function saveProfile(p: Profile): Promise<Profile> {
  const db = await getDb()
  await db.put('profiles', p)
  return p
}

/** プロファイルを削除する。最後の 1 件は削除できない */
export async function deleteProfile(id: string): Promise<{ error?: string }> {
  const db = await getDb()
  const count = await db.count('profiles')
  if (count <= 1) {
    return { error: '最後のラベル定義は削除できません' }
  }
  await db.delete('profiles', id)
  return {}
}

/** プロファイルを複製する。名前に「（コピー）」を付け、新しい id を割り当てる */
export async function duplicateProfile(id: string): Promise<Profile | { error: string }> {
  const original = await getProfile(id)
  if (!original) {
    return { error: '複製元のラベル定義が見つかりません' }
  }
  const copy: Profile = {
    ...original,
    id: newProfileId(),
    name: `${original.name}（コピー）`,
  }
  return saveProfile(copy)
}

/** JSON 文字列からプロファイルを取り込む。既存 id と衝突する場合は新しい id を割り当てる */
export async function importProfileJson(text: string): Promise<Profile | { error: string }> {
  const parsed = parseProfileJson(text)
  if ('error' in parsed) {
    return parsed
  }

  const existing = await getProfile(parsed.id)
  const profile: Profile = existing ? { ...parsed, id: newProfileId() } : parsed

  return saveProfile(profile)
}

/** プロファイルを JSON 文字列としてエクスポートする */
export async function exportProfileJson(id: string): Promise<string | { error: string }> {
  const profile = await getProfile(id)
  if (!profile) {
    return { error: 'ラベル定義が見つかりません' }
  }
  return serializeProfile(profile)
}
