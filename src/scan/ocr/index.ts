// OCR 機能の唯一の入口。シャッター操作など、明示的に呼ばれたときだけ実行する
// （フレームループには絶対に組み込まない）。ワーカーはモジュール単位の
// 遅延シングルトンとして、初回呼び出し時にのみ生成する。

import { preprocessRoi } from './preprocess'
import type { OcrOptions, OcrResult, RoiRect } from './types'

export { DEFAULT_OCR_OPTIONS } from './types'
export type { OcrOptions, OcrResult, RoiRect } from './types'

type RecognizeRequest = { type: 'recognize'; id: number; imageData: ImageData; options: OcrOptions }
type TerminateRequest = { type: 'terminate' }
type WarmupRequest = { type: 'warmup'; id: number }
type ResultResponse = { type: 'result'; id: number; result: OcrResult }
type ErrorResponse = { type: 'error'; id: number; message: string }
type WarmupDoneResponse = { type: 'warmup-done'; id: number }
type Response = ResultResponse | ErrorResponse | WarmupDoneResponse

let ocrWorker: Worker | null = null
let nextId = 0
const pending = new Map<number, (response: Response) => void>()

function ensureWorker(): Worker {
  if (!ocrWorker) {
    // tesseract.js 本体はこのワーカーの中でさらに遅延 import されるため、
    // ここではワーカースクリプトを起動するだけで初期バンドルは汚れない
    const worker = new Worker(new URL('./ocr.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (event: MessageEvent<Response>) => {
      const data = event.data
      const resolve = pending.get(data.id)
      if (!resolve) return
      pending.delete(data.id)
      resolve(data)
    })
    ocrWorker = worker
  }
  return ocrWorker
}

// OCR モードに入った時点などで呼んでおくと、tesseract エンジンの初期化を
// 先に済ませ、実際のシャッター時の待ち時間を減らせる
export async function preloadOcr(): Promise<void> {
  const worker = ensureWorker()
  const id = nextId++
  return new Promise<void>((resolve) => {
    pending.set(id, () => resolve())
    const message: WarmupRequest = { type: 'warmup', id }
    worker.postMessage(message)
  })
}

export async function runOcr(source: HTMLVideoElement, roi: RoiRect, options: OcrOptions): Promise<OcrResult> {
  const imageData = preprocessRoi(source, roi)
  const worker = ensureWorker()
  const id = nextId++

  return new Promise<OcrResult>((resolve, reject) => {
    pending.set(id, (response) => {
      if (response.type === 'result') {
        resolve(response.result)
      } else if (response.type === 'error') {
        reject(new Error(response.message))
      }
    })
    const message: RecognizeRequest = { type: 'recognize', id, imageData, options }
    // 前処理済み画像のバッファはコピーせず転送する（ゼロコピー）
    worker.postMessage(message, [imageData.data.buffer])
  })
}

export function disposeOcr(): void {
  if (ocrWorker) {
    const terminateMessage: TerminateRequest = { type: 'terminate' }
    try {
      ocrWorker.postMessage(terminateMessage)
    } catch {
      // 送信に失敗しても後続の terminate() で確実に破棄する
    }
    ocrWorker.terminate()
    ocrWorker = null
  }
  // 待機中の呼び出しは破棄されたものとして解決しておく（呼び出し元が永久に待たないように）
  for (const [id, resolve] of pending) {
    resolve({ type: 'error', id, message: 'OCR was disposed' })
  }
  pending.clear()
}
