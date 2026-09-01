// 新しいバージョンの Service Worker が見つかったときだけ表示する非ブロッキングのバー。
// ユーザーが「更新」を押すまでは絶対にリロードしない
// （スキャン中に無警告でリロードされて作業中のデータを失うことを防ぐため）。
// 「更新」を押したときは、リロード前に必ず下書きを保存し切ってから反映する。

import { useEffect, useState } from 'react'
import { flushPendingDraft } from '../../store/draft'
import { Button } from './Button'
import { applyUpdate, dismissUpdate, getNeedRefresh, subscribeUpdate } from './updateBus'

export function UpdateBanner() {
  const [needRefresh, setNeedRefresh] = useState(getNeedRefresh)
  const [updating, setUpdating] = useState(false)

  useEffect(() => subscribeUpdate(() => setNeedRefresh(getNeedRefresh())), [])

  if (!needRefresh) return null

  async function handleUpdate() {
    setUpdating(true)
    try {
      // 更新中にスキャン画面が組み立て中のデータを持っていても失われないよう、
      // リロードの直前に必ず下書きを保存し切る。
      await flushPendingDraft()
    } finally {
      await applyUpdate()
    }
  }

  return (
    <div
      className="fixed inset-x-0 top-0 z-[200] flex items-center justify-between gap-3 bg-cyan-500 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-lg"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.5rem)' }}
    >
      <span>新しいバージョンがあります</span>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={dismissUpdate}
          disabled={updating}
          className="rounded-lg px-3 py-1.5 text-slate-900/80 underline underline-offset-2 disabled:opacity-50"
        >
          あとで
        </button>
        <Button variant="secondary" size="md" loading={updating} onClick={() => void handleUpdate()}>
          更新
        </Button>
      </div>
    </div>
  )
}
