// OCR 機能の唯一の入口。シャッター操作など、明示的に呼ばれたときだけ実行する
// （フレームループには絶対に組み込まない）。ワーカーはモジュール単位の
// 遅延シングルトンとして、初回呼び出し時にのみ生成する。

import { preprocessRoi } from './preprocess'
import type { OcrOptions, OcrResult, RoiRect } from './types'

export { DEFAULT_OCR_OPTIONS } from './types'
export type { OcrOptions, OcrResult, RoiRect } from './types'
export { computeOcrScale, OCR_PIXEL_BUDGET } from './preprocess'
export { applyOcrFilter, filterAlnumOnly, filterDigitsOnly, OCR_FILTER_LABELS } from './postprocess'
export type { OcrFilterMode } from './postprocess'

// OCR エンジンのダウンロード/初期化/認識の進捗。progress は 0..1、status は日本語の表示文言。
export type OcrProgress = { status: string; progress: number }

type RecognizeRequest = { type: 'recognize'; id: number; imageData: ImageData; options: OcrOptions }
type TerminateRequest = { type: 'terminate' }
type WarmupRequest = { type: 'warmup'; id: number }
type ResultResponse = { type: 'result'; id: number; result: OcrResult }
type ErrorResponse = { type: 'error'; id: number; message: string }
type WarmupDoneResponse = { type: 'warmup-done'; id: number }
type ProgressResponse = { type: 'progress'; id: number; status: string; progress: number }
type Response = ResultResponse | ErrorResponse | WarmupDoneResponse | ProgressResponse

let ocrWorker: Worker | null = null
let nextId = 0
const pending = new Map<number, (response: Response) => void>()
const progressListeners = new Map<number, (progress: OcrProgress) => void>()

// OCRエンジン一式（約9MB）を初回に取得済みかどうかを端末に記録する。
// 「初回だけ時間がかかる」旨の案内をいつ出すかの判定にのみ使う軽量なフラグ。
const OCR_ENGINE_CACHED_KEY = 'dlabel-scanner:ocrEngineCached'

export function hasOcrEngineCached(): boolean {
  try {
    return localStorage.getItem(OCR_ENGINE_CACHED_KEY) === '1'
  } catch {
    // プライベートブラウジング等で localStorage が使えない場合は
    // 「まだキャッシュされていない」扱いにしておく（案内が余分に出るだけで害はない）
    return false
  }
}

function markOcrEngineCached(): void {
  try {
    localStorage.setItem(OCR_ENGINE_CACHED_KEY, '1')
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}

function ensureWorker(): Worker {
  if (!ocrWorker) {
    // tesseract.js 本体はこのワーカーの中でさらに遅延 import されるため、
    // ここではワーカースクリプトを起動するだけで初期バンドルは汚れない
    const worker = new Worker(new URL('./ocr.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (event: MessageEvent<Response>) => {
      const data = event.data
      if (data.type === 'progress') {
        progressListeners.get(data.id)?.({ status: data.status, progress: data.progress })
        return
      }
      const resolve = pending.get(data.id)
      if (!resolve) return
      pending.delete(data.id)
      progressListeners.delete(data.id)
      resolve(data)
    })
    ocrWorker = worker
  }
  return ocrWorker
}

// OCR モードに入った時点などで呼んでおくと、tesseract エンジンの初期化を
// 先に済ませ、実際のシャッター時の待ち時間を減らせる
export async function preloadOcr(onProgress?: (progress: OcrProgress) => void): Promise<void> {
  const worker = ensureWorker()
  const id = nextId++
  if (onProgress) progressListeners.set(id, onProgress)
  return new Promise<void>((resolve) => {
    pending.set(id, () => {
      markOcrEngineCached()
      resolve()
    })
    const message: WarmupRequest = { type: 'warmup', id }
    worker.postMessage(message)
  })
}

// 「今まさに OCR にかけようとしている画像」をシャッター押下の瞬間に同期的に確定させる。
// 前処理（グレースケール化・二値化・スケーリング）まで済ませた ImageData を返すので、
// 呼び出し側はこれをそのままプレビュー用サムネイルとしても、認識結果の検証用にも使える。
export function captureRoi(source: HTMLVideoElement, roi: RoiRect): ImageData {
  return preprocessRoi(source, roi)
}

// captureRoi で得た画像を認識する。同じ ImageData を使い回して
// （PSM/ホワイトリストを変えながら）何度でも再認識できるよう、
// ワーカーへは複製したバッファを転送し、呼び出し元の image は破壊しない。
export async function recognizeCaptured(
  image: ImageData,
  options: OcrOptions,
  onProgress?: (progress: OcrProgress) => void,
): Promise<OcrResult> {
  const worker = ensureWorker()
  const id = nextId++
  if (onProgress) progressListeners.set(id, onProgress)

  // postMessage の第2引数で transfer するとバッファが無効化されるため、
  // 呼び出し元が保持する image はそのまま残るように複製してから渡す（ゼロコピーは複製後の分だけ）
  const transferable = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height)

  return new Promise<OcrResult>((resolve, reject) => {
    pending.set(id, (response) => {
      if (response.type === 'result') {
        markOcrEngineCached()
        resolve(response.result)
      } else if (response.type === 'error') {
        reject(new Error(response.message))
      }
    })
    const message: RecognizeRequest = { type: 'recognize', id, imageData: transferable, options }
    worker.postMessage(message, [transferable.data.buffer])
  })
}

// 既存の呼び出し互換のための一括版（撮影 + 認識をまとめて行う）
export async function runOcr(
  source: HTMLVideoElement,
  roi: RoiRect,
  options: OcrOptions,
  onProgress?: (progress: OcrProgress) => void,
): Promise<OcrResult> {
  const image = captureRoi(source, roi)
  return recognizeCaptured(image, options, onProgress)
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
  progressListeners.clear()
}
