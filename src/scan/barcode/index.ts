// UI から見た唯一の入口。どちらのバックエンド（ネイティブ / zxing-wasm）が
// 動いているかを呼び出し側が意識しなくて済むようにするファサード。

import type { BarcodeHit, BarcodeInput, BarcodeReader } from './types'
import { createNativeReader, isNativeAvailable } from './native'

export type { BarcodeHit, BarcodeInput, BarcodeReader, NormalizedRect } from './types'
export { SUPPORTED_FORMATS } from './types'
export { selectNewHits } from './dedupe'
export { filterHitsByRoi, isHitInRoi } from './roiFilter'

export type BarcodeBackend = 'native' | 'zxing'

type DecodeMessage = { type: 'decode'; id: number; bitmap: ImageBitmap }
type ResultMessage = { type: 'result'; id: number; hits: BarcodeHit[]; error?: string }

// zxing-wasm ワーカーを使う BarcodeReader 実装。id で紐づけた
// Promise ベースのリクエスト / レスポンスとして振る舞う。
// zxing-wasm は ImageData でしか読めないため、<video> / OffscreenCanvas の
// どちらを渡されても、ここで ImageBitmap 化してからワーカーへ転送する
// （呼び出し側は BarcodeReader.detect の入力を意識しなくてよい）。
function createZxingReader(worker: Worker): BarcodeReader {
  let nextId = 0
  const pending = new Map<number, (hits: BarcodeHit[]) => void>()

  worker.addEventListener('message', (event: MessageEvent<ResultMessage>) => {
    const data = event.data
    if (data.type !== 'result') return
    const resolve = pending.get(data.id)
    if (resolve) {
      pending.delete(data.id)
      resolve(data.hits)
    }
  })

  return {
    async detect(input: BarcodeInput): Promise<BarcodeHit[]> {
      const bitmap = await createImageBitmap(input)
      const id = nextId++
      return new Promise<BarcodeHit[]>((resolve) => {
        pending.set(id, resolve)
        const message: DecodeMessage = { type: 'decode', id, bitmap }
        worker.postMessage(message, [bitmap])
      })
    },
    close() {
      pending.clear()
      worker.terminate()
    },
  }
}

async function createFallbackReader(): Promise<{ reader: BarcodeReader; backend: BarcodeBackend }> {
  // zxing-wasm のワーカーと wasm はここまで遅延させ、初期バンドルに含めない
  const worker = new Worker(new URL('./zxing.worker.ts', import.meta.url), { type: 'module' })
  return { reader: createZxingReader(worker), backend: 'zxing' }
}

export async function createBarcodeReader(): Promise<{ reader: BarcodeReader; backend: BarcodeBackend }> {
  if (isNativeAvailable()) {
    try {
      const reader = await createNativeReader()
      return { reader, backend: 'native' }
    } catch {
      // ネイティブ実装の生成に失敗した端末は zxing-wasm にフォールバックする
      return createFallbackReader()
    }
  }
  return createFallbackReader()
}
