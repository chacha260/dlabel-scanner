// UI から使う薄い React フック群。ビジネスロジックは持たず、store/* の関数を呼ぶだけ。

import { useCallback, useEffect, useState } from 'react'
import type { AppSettings } from './db'
import { getSettings, saveSettings } from './settings'
import { listProfiles, getProfile } from './profiles'
import type { Profile } from '../parse/types'
import { listRecords, type RecordFilter } from './records'
import type { ScanRecord } from './db'

/** アプリ設定の取得・更新フック */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getSettings().then((s) => {
      if (cancelled) return
      setSettings(s)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await saveSettings(patch)
    setSettings(next)
    return next
  }, [])

  return { settings, update, loading }
}

/** ラベル定義一覧・選択中プロファイルの取得・切り替えフック */
export function useProfiles() {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [active, setActiveState] = useState<Profile | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    const [list, settings] = await Promise.all([listProfiles(), getSettings()])
    setProfiles(list)
    const found = list.find((p) => p.id === settings.activeProfileId)
    setActiveState(found ?? list[0])
    setLoading(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([listProfiles(), getSettings()]).then(([list, settings]) => {
      if (cancelled) return
      setProfiles(list)
      const found = list.find((p) => p.id === settings.activeProfileId)
      setActiveState(found ?? list[0])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const setActive = useCallback(async (id: string) => {
    const profile = await getProfile(id)
    if (!profile) return
    await saveSettings({ activeProfileId: id })
    setActiveState(profile)
  }, [])

  return { profiles, active, setActive, reload, loading }
}

/** レコード一覧の取得フック。filter が変わるたびに再取得する */
export function useRecords(filter?: RecordFilter) {
  const [records, setRecords] = useState<ScanRecord[]>([])
  const [loading, setLoading] = useState(true)

  const filterKey = JSON.stringify(filter ?? {})

  const reload = useCallback(async () => {
    setLoading(true)
    const list = await listRecords(filter)
    setRecords(list)
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listRecords(filter).then((list) => {
      if (cancelled) return
      setRecords(list)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  return { records, reload, loading }
}
