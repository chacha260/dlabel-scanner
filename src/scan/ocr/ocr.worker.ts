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
// warmup が失敗しても呼び出し側の Promise は必ず解決させたいため（詳細は handleWarmup の
// コメントを参照）、'warmup-done' というメッセージ種別自体は変えずに、失敗した場合だけ
// error に理由を積んで返す。省略時（成功時）は従来どおり id だけの通知になる。
type WarmupDoneResponse = { type: 'warmup-done'; id: number; error?: string }
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

// getTesseractWorker() の初期化失敗を、現場で原因を切り分けられる日本語メッセージに
// 包み直す。このワーカーの初期化で失敗しうる工程（worker.min.js の取得、wasm コアの
// 取得、langPath からの学習データ取得・読み込み）のうち、実際に踏み抜きやすいのは
// 圧倒的に学習データまわりだった（.gz 展開の失敗で OCR が丸ごと動かなくなっていた
// 不具合を参照）。tesseract.js が返す生の英語エラーだけでは「学習データが読めて
// いない」と現場で気付くのが難しいため、原因の見当と元のエラー内容の両方を残す。
function describeWorkerInitError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return `学習データを読み込めませんでした（OCRエンジンの初期化に失敗しました）: ${raw}`
}

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
        // 学習データ (eng.traineddata) は非圧縮のまま同梱し、gzip: false を渡す。
        //
        // 以前は gzip: true にして eng.traineddata.gz（2.95MB, 展開後5.2MB）を配信し、
        // tesseract.js が fetch 結果の先頭バイトから gzip マジックバイト (0x1F 0x8B) を
        // 検出したら worker.min.js にバンドルされた zlibjs（純JS実装）で展開する方式を
        // 使っていたが、この「.gz を HTTP 経由で運ぶ」という経路には避けがたい曖昧さが
        // あり、OCR が丸ごと使えなくなる不具合の原因になっていた。
        // - サーバや WebView が Content-Encoding: gzip を付けるかどうかで、fetch が
        //   受け取るバイト列が「gzip のまま」か「途中の層で既に展開済み」かが変わる。
        //   これによって zlibjs が二重展開を試みたり、逆に gzip のバイト列のまま
        //   traineddata として読み込まれたりし得る。
        // - 特に Capacitor の APK 版では、WebViewLocalServer#shouldInterceptRequest が
        //   端末内のアセットを直接返す実装になっており、MIME は
        //   URLConnection.guessContentTypeFromName() 任せ（.gz は application/gzip 等に
        //   なる）。さらに aapt が APK 内で .gz ファイルをもう一度 deflate 圧縮するため、
        //   実際には「二重に圧縮された」状態のストリームが配信されていた。この層の
        //   どこかで壊れると、5MB分の純JS展開が失敗し、学習データが読めずに OCR が
        //   一切機能しなくなる（しかも handleWarmup 側で握りつぶされていたため、
        //   何が起きているか呼び出し側からは分からなかった）。
        // 非圧縮ファイルを直接同梱すれば、上記の曖昧さのある経路をまるごと排除できる。
        // なお APK 全体のサイズへの影響はほぼ無い。もともと aapt が APK 内の
        // アセット一式を（.gz かどうかに関わらず）deflate 圧縮して収める仕組みのため、
        // 「非圧縮の traineddata を同梱する」も「gzip 済みの traineddata.gz を同梱する」も
        // 最終的な APK サイズへの寄与はほぼ同じで、二重圧縮という不具合の芽だけが消える。
        gzip: false,
        logger: handleLoggerEvent,
      })
    })().catch((err: unknown) => {
      // 初期化に失敗した Promise をキャッシュに残すと、原因（.gz 展開の失敗など）が
      // 解消された後も次回呼び出しが同じ失敗した Promise を返し続けてしまい、
      // 再試行の機会が永久に失われる。失敗時は必ずキャッシュを空に戻す。
      tesseractWorkerPromise = null
      throw new Error(describeWorkerInitError(err))
    })
  }
  return tesseractWorkerPromise
}

async function applyOptionsIfChanged(worker: TesseractWorker, options: OcrOptions): Promise<void> {
  if (appliedPsm === options.psm) return

  const params: SetParametersArg = {
    tessedit_pageseg_mode: options.psm as unknown as SetParametersArg['tessedit_pageseg_mode'],
  }
  await worker.setParameters(params)
  appliedPsm = options.psm
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
  let error: string | undefined
  try {
    await getTesseractWorker()
  } catch (err) {
    // 以前はここで catch {} としてエラーを完全に握りつぶしていた。warmup は
    // 「事前に済ませておくだけの最適化」なので、そのときの失敗自体は致命的ではなく
    // （実際の認識要求時に改めて getTesseractWorker が呼ばれ、そこでエラーとして
    // 返る）、warmup-done という契約は変えたくない。しかし完全に握りつぶすと、
    // 学習データの読み込みに失敗していても画面上は何も起きないまま OCR モードに
    // 入ってしまい、「OCRが使えない」ことにユーザーもこちらも気付けなかった
    // （.gz 展開失敗の不具合が長らく見つからなかった一因）。そのため、失敗の内容は
    // warmup-done の error フィールドに載せて呼び出し側（preloadOcr）へ伝える。
    error = err instanceof Error ? err.message : String(err)
  } finally {
    post({ type: 'warmup-done', id: request.id, ...(error ? { error } : {}) })
  }
}

async function handleTerminate(): Promise<void> {
  const pending = tesseractWorkerPromise
  tesseractWorkerPromise = null
  appliedPsm = null
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
