// 画面のどこからでも呼び出せる簡易トーストの表示ホスト。
// 状態管理そのものは toastBus.ts に分離してある。

import { useEffect, useState } from 'react'
import { getToastItems, subscribeToast, type ToastKind } from './toastBus'

const kindClass: Record<ToastKind, string> = {
  info: 'bg-slate-700 text-slate-100',
  success: 'bg-emerald-600 text-white',
  error: 'bg-red-600 text-white',
}

/** App のルートに一度だけ置くトースト表示ホスト */
export function ToastHost() {
  const [, setTick] = useState(0)

  useEffect(() => subscribeToast(() => setTick((t) => t + 1)), [])

  const items = getToastItems()

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[100] flex flex-col items-center gap-2 px-4">
      {items.map((item) => (
        <div
          key={item.id}
          className={`pointer-events-auto max-w-full rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg ${kindClass[item.kind]}`}
        >
          {item.message}
        </div>
      ))}
    </div>
  )
}
