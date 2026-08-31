// Toast.tsx が使う購読可能な小さな状態バス。コンポーネントと非コンポーネントの
// エクスポートを分けるため、ロジックのみこのファイルに置く。

export type ToastKind = 'info' | 'success' | 'error'
export type ToastItem = { id: number; message: string; kind: ToastKind }

let items: ToastItem[] = []
let nextId = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** どの画面からでも呼べるトースト表示関数。失敗系は必ず 'error' を指定すること */
export function showToast(message: string, kind: ToastKind = 'info'): void {
  const id = ++nextId
  items = [...items, { id, message, kind }]
  notify()
  setTimeout(() => {
    items = items.filter((i) => i.id !== id)
    notify()
  }, 3200)
}

export function getToastItems(): ToastItem[] {
  return items
}

export function subscribeToast(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
