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
// エンジンのダウンロード/初期化/認識の進捗を知らせる。progress は 0..1
type ProgressResponse = { type: 'progress'; id: number; status: string; progress: number }
type Response = ResultResponse | ErrorResponse | WarmupDoneResponse | ProgressResponse

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

// WASM SIMD に対応した最小のバイナリ（v128.const 命令を含む）。この検証に成功するかどうかで
// 実行環境が SIMD 命令に対応しているかを判定する（wasm-feature-detect と同じ手法・同じバイト列）。
// https://github.com/GoogleChromeLabs/wasm-feature-detect
const WASM_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
])

let simdSupportCache: boolean | null = null

// Android Chrome は SIMD 対応だが、念のため WebAssembly.validate に失敗した場合は
// 非SIMD版にフォールバックする（例外を投げない）。
function isWasmSimdSupported(): boolean {
  if (simdSupportCache === null) {
    try {
      simdSupportCache = WebAssembly.validate(WASM_SIMD_PROBE)
    } catch {
      simdSupportCache = false
    }
  }
  return simdSupportCache
}

// tesseract.js の corePath はディレクトリを渡すと SIMD/非SIMD を自動判別する機能を持つが
// （node_modules/tesseract.js/src/worker-script/browser/getCore.js）、その判定は
// SIMD 対応の有無だけでなく Relaxed SIMD にも対応しており、3種類目のコア一式
// （tesseract-core-relaxedsimd-lstm.*）が必要になる。このアプリでは通常版とSIMD版の
// 2種類のみを配布する方針のため、ここでは自前で判定した上でファイル名を直接指定し
// （末尾が `.js` のパスを渡すとライブラリ側の自動判別は行われない）、
// 存在しないファイルを要求してしまう事故を防ぐ。
function resolveCoreFileName(): string {
  return isWasmSimdSupported() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'
}

let tesseractWorkerPromise: Promise<TesseractWorker> | null = null
let appliedPsm: OcrOptions['psm'] | null = null
let appliedWhitelist: string | null = null

// 現在処理中のリクエスト id。tesseract.js の logger はジョブ単位の id を持たないため、
// 直近に処理を開始したリクエストの id を進捗の宛先として扱う
// （OCR はシャッター操作ごとに逐次実行される想定で、同時に複数走らせない）。
let activeRequestId = -1

// tesseract.js の英語ステータス文言を日本語に変換する。未知のものはそのまま表示する。
function translateStatus(status: string): string {
  switch (status) {
    case 'loading tesseract core':
      return 'エンジンを読み込み中'
    case 'initializing tesseract':
      return 'エンジンを初期化中'
    case 'loading language traineddata':
      return '学習データを読み込み中'
    case 'initializing api':
      return '準備中'
    case 'recognizing text':
      return '文字を認識中'
    default:
      return status
  }
}

function post(message: Response): void {
  ;(self as unknown as { postMessage(message: Response): void }).postMessage(message)
}

function handleLoggerEvent(data: { status: string; progress: number }): void {
  post({
    type: 'progress',
    id: activeRequestId,
    status: translateStatus(data.status),
    progress: data.progress,
  })
}

async function getTesseractWorker(): Promise<TesseractWorker> {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = (async () => {
      const { createWorker } = await import('tesseract.js')
      // oem は省略して既定の LSTM_ONLY を使う（Legacy エンジンより高速・省容量）
      return createWorker('eng', undefined, {
        workerPath: vendorUrl('worker.min.js'),
        corePath: vendorUrl(resolveCoreFileName()),
        langPath: vendorUrl('tessdata'),
        gzip: true,
        logger: handleLoggerEvent,
      })
    })()
  }
  return tesseractWorkerPromise
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
  activeRequestId = request.id
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
  activeRequestId = request.id
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
