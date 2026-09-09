// 新しいバージョンの Service Worker が見つかったときだけ表示する非ブロッキングのバー。
// ユーザーが「更新」を押すまでは絶対にリロードしない
// （スキャン中に無警告でリロードされて作業中のデータを失うことを防ぐため）。
//
// 以前はここで、リロード前に IndexedDB へ「組み立て中の下書き」を保存し切る
// flushPendingDraft()（store/draft.ts）を呼んでいた。これは src/ui/legacy/ScanScreen.tsx
// が registerDraftFlush() で自分の保存関数を登録していたときだけ意味を持つ配線で、
// 現在の唯一の画面（SimpleScanScreen.tsx）は結果をメモリ上にしか保持せず
// （意図的な仕様）登録を一切行わない。src/parse・src/store・src/export を丸ごと
// 削除したのに合わせて、この画面が呼ぶ意味を失った配線ごと削除した。

import { useEffect, useState } from 'react'
import { Button } from './Button'
import { applyUpdate, dismissUpdate, getNeedRefresh, subscribeUpdate } from './updateBus'

export function UpdateBanner() {
  const [needRefresh, setNeedRefresh] = useState(getNeedRefresh)
  const [updating, setUpdating] = useState(false)

  useEffect(() => subscribeUpdate(() => setNeedRefresh(getNeedRefresh())), [])

  if (!needRefresh) return null

  // applyUpdate は成功すると即座にページをリロードするため、この後
  // setUpdating(false) をしても意味は無い（コンポーネントごと消える）が、
  // 万一リロードされない経路が将来入っても「更新中」表示が残り続けない
  // よう finally で戻しておく。
  async function handleUpdate() {
    setUpdating(true)
    try {
      await applyUpdate()
    } finally {
      setUpdating(false)
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
