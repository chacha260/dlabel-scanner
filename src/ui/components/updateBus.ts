// Service Worker の更新通知を UI に伝えるための小さな購読可能ステート。
// main.tsx で SW を登録し、ここを経由して UpdateBanner に
// 「新しいバージョンがある」ことを伝える（toastBus.ts と同じ設計）。
// registerType: 'prompt' のため、ユーザーが明示的に更新を押すまでは
// 絶対にリロードしない。

type UpdateFn = (reloadPage?: boolean) => Promise<void>

let needRefresh = false
let updateFn: UpdateFn | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** 新しいバージョンの Service Worker が見つかったときに main.tsx から呼ぶ */
export function markNeedRefresh(fn: UpdateFn): void {
  updateFn = fn
  needRefresh = true
  notify()
}

/** 「あとで」を押したときにバナーを閉じる（次に見つかったときはまた表示される） */
export function dismissUpdate(): void {
  needRefresh = false
  notify()
}

export function getNeedRefresh(): boolean {
  return needRefresh
}

/** ユーザーが「更新」を押したときだけ呼ぶ。新しい Service Worker を有効化してリロードする */
export async function applyUpdate(): Promise<void> {
  if (!updateFn) return
  await updateFn(true)
}

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
