// 画面下からせり上がるボトムシート。プロファイル選択・レコード編集など
// 一時的な操作 UI をカメラ映像の上に重ねて表示するために使う。

import type { ReactNode } from 'react'
import { CloseIcon } from './Icons'

type SheetProps = {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  heightClass?: string
}

export function Sheet({ open, onClose, title, children, heightClass = 'max-h-[80vh]' }: SheetProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        aria-label="閉じる"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        className={`relative flex w-full flex-col overflow-hidden rounded-t-2xl bg-slate-800 shadow-2xl ${heightClass}`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {title !== undefined && (
          <div className="flex shrink-0 items-center justify-between border-b border-slate-700 px-4 py-3">
            <h2 className="text-base font-bold text-slate-100">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="閉じる"
              className="rounded-full p-1.5 text-slate-400 active:bg-slate-700"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>
  )
}
