// OCR 専用の Web Worker。tesseract.js は初回の認識要求が来るまで動的 import
// しないことで、メインバンドルおよびワーカー起動直後のメモリ消費を抑える。
// tesseract.js は内部でさらに 1 段 Worker を生成するが、Android Chrome では
// ネストした Worker は問題なく動作する。

import type { OcrOptions, OcrResult } from './types'

type RecognizeRequest = { type: 'recognize'; id: number; imageData: ImageData; options: OcrOptions }
type TerminateRequest = { type: 'terminate' }
type WarmupRequest = { type: 'warmup'; id: number }
type Request = RecognizeRequest | TerminateRequest | WarmupRequest

type ResultResponse = { type: 'result'; id: number; result: OcrResult }
type ErrorResponse = { type: 'error'; id: number; message: string }
type WarmupDoneResponse = { type: 'warmup-done'; id: number }
type Response = ResultResponse | ErrorResponse | WarmupDoneResponse

// tesseract.js は CommonJS の `export =` 形式のため、動的 import した
// 名前空間の型からワーカー本体の型を導出する（tesseract.js の型を直接 import しない）
type TesseractModule = typeof import('tesseract.js')
type TesseractWorker = Awaited<ReturnType<TesseractModule['createWorker']>>
type SetParametersArg = Parameters<TesseractWorker['setParameters']>[0]

// 完全オフライン動作のため、CDN ではなくアプリ自身が配信する静的ファイルを使う
// （public/vendor/tesseract 以下。Service Worker の CacheFirst で初回取得後はオフライン可）
function vendorUrl(path: string): string {
  // GitHub Pages のようなサブパス配信でも解決できるよう BASE_URL を基準にする
  return new URL(`${import.meta.env.BASE_URL}vendor/tesseract/${path}`, self.location.origin).href
}

let tesseractWorkerPromise: Promise<TesseractWorker> | null = null
let appliedPsm: OcrOptions['psm'] | null = null
let appliedWhitelist: string | null = null

async function getTesseractWorker(): Promise<TesseractWorker> {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = (async () => {
      const { createWorker } = await import('tesseract.js')
      // oem は省略して既定の LSTM_ONLY を使う（Legacy エンジンより高速・省容量）
      return createWorker('eng', undefined, {
        workerPath: vendorUrl('worker.min.js'),
        corePath: vendorUrl('tesseract-core-lstm.wasm.js'),
        langPath: vendorUrl('tessdata'),
        gzip: true,
      })
    })()
  }
  return tesseractWorkerPromise
}

function post(message: Response): void {
  ;(self as unknown as { postMessage(message: Response): void }).postMessage(message)
}

async function applyOptionsIfChanged(worker: TesseractWorker, options: OcrOptions): Promise<void> {
  if (appliedPsm === options.psm && appliedWhitelist === options.whitelist) return

  const params: SetParametersArg = {
    tessedit_pageseg_mode: options.psm as unknown as SetParametersArg['tessedit_pageseg_mode'],
    tessedit_char_whitelist: options.whitelist,
  }
  await worker.setParameters(params)
  appliedPsm = options.psm
  appliedWhitelist = options.whitelist
}

async function handleRecognize(request: RecognizeRequest): Promise<void> {
  const startedAt = performance.now()
  try {
    const worker = await getTesseractWorker()
    await applyOptionsIfChanged(worker, request.options)

    // tesseract.js は ImageData を直接受け付けないため、OffscreenCanvas 経由で渡す
    const canvas = new OffscreenCanvas(request.imageData.width, request.imageData.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('2D context is not available')
    }
    ctx.putImageData(request.imageData, 0, 0)

    const { data } = await worker.recognize(canvas)
    const result: OcrResult = {
      text: data.text.trim(),
      confidence: data.confidence,
      ms: Math.round(performance.now() - startedAt),
    }
    post({ type: 'result', id: request.id, result })
  } catch (err) {
    post({
      type: 'error',
      id: request.id,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

// OCR モード起動時などに事前呼び出しし、実際のシャッター時の待ち時間を減らす
async function handleWarmup(request: WarmupRequest): Promise<void> {
  try {
    await getTesseractWorker()
  } catch {
    // ここでの失敗は致命的ではない（本番の認識要求時に改めてエラーとして返る）
  } finally {
    post({ type: 'warmup-done', id: request.id })
  }
}

async function handleTerminate(): Promise<void> {
  const pending = tesseractWorkerPromise
  tesseractWorkerPromise = null
  appliedPsm = null
  appliedWhitelist = null
  if (!pending) return
  try {
    const worker = await pending
    await worker.terminate()
  } catch {
    // 終了処理の失敗は無視してよい（このワーカー自体は破棄される想定のため）
  }
}

self.addEventListener('message', (event: MessageEvent<Request>) => {
  const data = event.data
  if (data.type === 'recognize') {
    void handleRecognize(data)
  } else if (data.type === 'terminate') {
    void handleTerminate()
  } else if (data.type === 'warmup') {
    void handleWarmup(data)
  }
})
