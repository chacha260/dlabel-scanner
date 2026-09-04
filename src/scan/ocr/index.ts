// OCR 機能の唯一の入口。シャッター操作など、明示的に呼ばれたときだけ実行する
// （フレームループには絶対に組み込まない）。ワーカーはモジュール単位の
// 遅延シングルトンとして、初回呼び出し時にのみ生成する。

import type { NormalizedRect } from '../barcode/types'
export type { NormalizedRect } from '../barcode/types'
import { mapCoverRectToVideo } from './geometry'
import { boxesToMask } from './mask'
import { preprocessRoi, trimBarcodeBoxesToStripes } from './preprocess'
import type { OcrPreprocessOptions } from './preprocess'
import { DEFAULT_OCR_PREPROCESS_OPTIONS } from './preprocess'
import { recognizeWithMlKit } from './mlkit'
import type { OcrOptions, OcrResult, RoiRect } from './types'

export { DEFAULT_OCR_OPTIONS } from './types'
export type { OcrEngineId, OcrOptions, OcrResult, OcrSymbol, RoiRect } from './types'
// ML Kit が使えるかどうかの判定だけを通す（実体は mlkit.ts。ブラウザでは常に false）。
export { isMlKitAvailable } from './mlkit'
export {
  computeOcrScale,
  DEFAULT_OCR_PREPROCESS_OPTIONS,
  OCR_PIXEL_BUDGET,
  TARGET_ROI_HEIGHT_PX,
  trimBarcodeBoxesToStripes,
} from './preprocess'
export type { OcrPreprocessOptions } from './preprocess'
export { applyOcrFilter, correctDigitConfusions, filterAlnumOnly, filterDigitsOnly, OCR_FILTER_LABELS } from './postprocess'
export type { OcrFilterMode } from './postprocess'
// 「どの文字が怪しいか」の判定（文字ごとの信頼度 / 2パス照合）。判定は純粋関数として
// agreement.ts に閉じ込めてあり、ここでは UI から使えるように通すだけ。
export { compareOcrPasses, judgeByConfidence, LOW_CONFIDENCE_THRESHOLD, mergeVerdicts } from './agreement'
export type { CharVerdict } from './agreement'
export { boxesToMask, DEFAULT_MASK_MARGIN, expandRect, normalizedRectToPixels, rectsOverlap } from './mask'
export type { PixelRect } from './mask'
export {
  clampRoi,
  DEFAULT_BARCODE_ROI,
  DEFAULT_ROI,
  isValidRoiRect,
  loadPersistedBarcodeRoi,
  loadPersistedRoi,
  MIN_ROI_H,
  MIN_ROI_W,
  moveRoi,
  resizeRoi,
  savePersistedBarcodeRoi,
  savePersistedRoi,
} from './roi'
export type { HandleId } from './roi'

// OCR エンジンのダウンロード/初期化/認識の進捗。progress は 0..1、status は日本語の表示文言。
export type OcrProgress = { status: string; progress: number }

type RecognizeRequest = { type: 'recognize'; id: number; imageData: ImageData; options: OcrOptions }
type TerminateRequest = { type: 'terminate' }
type WarmupRequest = { type: 'warmup'; id: number }
type ResultResponse = { type: 'result'; id: number; result: OcrResult }
type ErrorResponse = { type: 'error'; id: number; message: string }
// error はワーカー側 (ocr.worker.ts) の handleWarmup が学習データ読み込み等の失敗を
// 伝えるための追加フィールド。'warmup-done' というメッセージ種別自体は変わらない。
type WarmupDoneResponse = { type: 'warmup-done'; id: number; error?: string }
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

// preloadOcr の結果。warmup が失敗した場合でも preloadOcr 自体は reject させない
// （呼び出し側は SimpleScanScreen.tsx で `void preloadOcr(...)` と呼び捨てにしており、
// reject させると unhandled rejection になってしまうため）。失敗した理由を知りたい
// 呼び出し側だけが ok / error を見ればよく、見なくても既存の `void preloadOcr(...)`
// という呼び方はそのまま動く。
export type OcrPreloadResult = { ok: true } | { ok: false; error: string }

// OCR モードに入った時点などで呼んでおくと、tesseract エンジンの初期化を
// 先に済ませ、実際のシャッター時の待ち時間を減らせる。
// 学習データの読み込み失敗など、初期化に失敗した場合も本関数は reject しない
// （上記 OcrPreloadResult のコメントを参照）。失敗しても以降の実際の認識要求
// （recognizeCaptured）では改めて初期化が試みられ、そこでは通常どおり reject する。
export async function preloadOcr(onProgress?: (progress: OcrProgress) => void): Promise<OcrPreloadResult> {
  const worker = ensureWorker()
  const id = nextId++
  if (onProgress) progressListeners.set(id, onProgress)
  return new Promise<OcrPreloadResult>((resolve) => {
    pending.set(id, (response) => {
      if (response.type === 'warmup-done' && response.error) {
        resolve({ ok: false, error: response.error })
        return
      }
      markOcrEngineCached()
      resolve({ ok: true })
    })
    const message: WarmupRequest = { type: 'warmup', id }
    worker.postMessage(message)
  })
}

// 「今まさに OCR にかけようとしている画像」をシャッター押下の瞬間に同期的に確定させる。
// 前処理（グレースケール化・スケーリング）まで済ませた ImageData を返すので、
// 呼び出し側はこれをそのままプレビュー用サムネイルとしても、認識結果の検証用にも使える。
//
// roi は「画面に表示している枠」に対する割合（表示座標）で受け取り、ここで映像の
// 実解像度上の範囲（映像座標）へ変換する。object-fit: cover による切り落としを
// 考慮しないと、画面の枠と実際に切り出される範囲がずれるため、変換は必ずここを通す。
// maskRects を渡す場合は、映像座標（フレーム全体に対する 0..1）で指定すること。
export function captureRoi(
  source: HTMLVideoElement,
  roi: RoiRect,
  maskRects?: NormalizedRect[],
  preprocessOptions: OcrPreprocessOptions = DEFAULT_OCR_PREPROCESS_OPTIONS,
): ImageData {
  const videoRoi = mapCoverRectToVideo(
    roi,
    source.clientWidth,
    source.clientHeight,
    source.videoWidth,
    source.videoHeight,
  )
  return preprocessRoi(source, videoRoi, maskRects, preprocessOptions)
}

// シャッターを押した「その瞬間」の映像全体を同期的に静止画へ落とし込む。
// これを OffscreenCanvas として保持しておけば、この後の「バーコード検出」や
// 「ROI 切り出し」が非同期でどれだけ時間をかけても、実際に処理する画素は
// 常にシャッター押下時点のもののままになる（撮影後に端末が動いても影響を受けない）。
export function captureFrame(video: HTMLVideoElement): OffscreenCanvas {
  const width = Math.max(1, video.videoWidth)
  const height = Math.max(1, video.videoHeight)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('2D context is not available')
  }
  ctx.drawImage(video, 0, 0, width, height)
  return canvas
}

// captureFrame() で撮った静止フレームと対にする、ROI の映像座標表現。
export type CapturedFrame = {
  frame: OffscreenCanvas
  /** 表示座標の ROI を、撮影時点の映像座標（0..1）へ変換したもの */
  videoRoi: RoiRect
}

// シャッター押下の瞬間に、静止フレームと ROI の映像座標への変換を両方まとめて
// 同期的に確定させる。表示座標→映像座標の変換にはそのときの video 要素の
// clientWidth/clientHeight が必要なため、captureFrame と同じタイミングで行う。
export function captureFrameAndRoi(video: HTMLVideoElement, roi: RoiRect): CapturedFrame {
  const frame = captureFrame(video)
  const videoRoi = mapCoverRectToVideo(roi, video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight)
  return { frame, videoRoi }
}

// 既に映像座標になっている ROI で、静止フレーム（または video 本体）から直接切り出す。
// captureRoi と違い、表示座標→映像座標の変換は行わない
// （captureFrameAndRoi で変換済みの videoRoi をそのまま使うためのもの）。
export function cropVideoSpaceRoi(
  source: HTMLVideoElement | OffscreenCanvas,
  videoRoi: RoiRect,
  maskRects?: NormalizedRect[],
  // 前処理の各段（罫線除去・縞マスク・コントラスト正規化）の ON/OFF。
  // 同じ静止画に対して組み合わせを変えて結果を並べる比較モード（OcrCompareSheet）が
  // ここを切り替えて呼ぶため、既定値任せにせず明示的に渡せるようにしてある。
  preprocessOptions: OcrPreprocessOptions = DEFAULT_OCR_PREPROCESS_OPTIONS,
): ImageData {
  return preprocessRoi(source, videoRoi, maskRects, preprocessOptions)
}

/**
 * ROI（映像座標）を **前処理を一切かけずに、元の解像度・元の色のまま** 切り出す。
 *
 * なぜこれが要るのか（重要）:
 * preprocessRoi のパイプライン（グレースケール化・コントラスト正規化・罫線除去・
 * そして computeOcrScale による「文字行の高さが TARGET_ROI_HEIGHT_PX=96px に
 * なるまでの縮小」）は、すべて **tesseract.js の LSTM エンジンに合わせて**
 * 調整したものである。Tesseract はスキャンした書類向けのエンジンで、
 * 小さめ・高コントラストのグレースケール画像を好むため、この前処理が効く。
 *
 * ところが ML Kit は逆で、**カメラで撮った自然な写真**で学習されている。
 * 同じ画像を渡すと、
 *   - 96px まで縮小されたことで細部の情報が失われる
 *   - グレースケール化・コントラスト伸長で、モデルが期待する画素分布から外れる
 * という二重の不利を負う。つまり「ML Kit のほうが精度が低い」という比較結果が
 * 出たとしても、それが **エンジンの実力差なのか、Tesseract 向けの前処理を
 * 押し付けたせいなのか区別がつかない**。それでは比較する意味がない。
 *
 * そのため ML Kit へ渡す経路では、この関数で「切り出しただけ」の画像を作り、
 * 前処理の有無そのものも比較軸として扱えるようにする。
 *
 * maskRects（バーコードのマスク）だけは前処理とは別の話（読ませたくない領域を
 * 隠すという意図的な操作）なので、渡された場合はここでも塗りつぶす。
 */
export function cropVideoSpaceRoiRaw(
  source: HTMLVideoElement | OffscreenCanvas,
  videoRoi: RoiRect,
  maskRects?: NormalizedRect[],
): ImageData {
  const frameWidth = source instanceof OffscreenCanvas ? source.width : source.videoWidth
  const frameHeight = source instanceof OffscreenCanvas ? source.height : source.videoHeight

  const sx = Math.max(0, Math.round(videoRoi.x * frameWidth))
  const sy = Math.max(0, Math.round(videoRoi.y * frameHeight))
  const sw = Math.max(1, Math.min(frameWidth - sx, Math.round(videoRoi.w * frameWidth)))
  const sh = Math.max(1, Math.min(frameHeight - sy, Math.round(videoRoi.h * frameHeight)))

  const canvas = new OffscreenCanvas(sw, sh)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    throw new Error('2D context is not available')
  }
  // 等倍で切り出すだけ（拡大も縮小もしない。色もそのまま）
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)

  if (maskRects && maskRects.length > 0) {
    // マスクは「読ませたくない領域を隠す」意図的な操作なので前処理とは別扱い。
    // 前処理経路（preprocess.ts の applyMaskFill）は周囲の色をサンプリングした
    // グレーで塗るが、ここでは色情報を保ったままにしたいので、素直に
    // 不透明の中間グレーで塗りつぶす（ML Kit は自然画像を前提とするため、
    // 真っ黒・真っ白の強いエッジを作らないことのほうが重要）。
    ctx.fillStyle = 'rgb(128,128,128)'
    for (const rect of maskRects) {
      const x = Math.round(rect.x * frameWidth) - sx
      const y = Math.round(rect.y * frameHeight) - sy
      const w = Math.round(rect.w * frameWidth)
      const h = Math.round(rect.h * frameHeight)
      ctx.fillRect(x, y, w, h)
    }
  }

  return ctx.getImageData(0, 0, sw, sh)
}

// フレームループが持つバーコードリーダーを再利用して、1枚の静止フレームに対して
// 1回だけ検出を行う関数の型（useBarcodeScanner の detectBoxes を渡す想定）。
export type BoxDetector = (frame: OffscreenCanvas) => Promise<NormalizedRect[]>

// captureFrameAndRoi で確定させた静止フレームに対して、バーコード検出→
// （ROI と重なる枠だけを）マスク候補に絞り込み→実ピクセルを見て縞の帯まで
// 縦方向に縮める→ROI 切り出し、までをまとめて行う。
// 検出に失敗しても例外を投げず、マスクなしで crop を返す（劣化はするが処理は止めない）。
export async function captureRoiWithBarcodeMask(
  captured: CapturedFrame,
  detectBoxes: BoxDetector,
): Promise<{ image: ImageData; maskedCount: number; maskRects: NormalizedRect[] }> {
  let maskRects: NormalizedRect[] = []
  try {
    const boxes = await detectBoxes(captured.frame)
    const candidates = boxesToMask(boxes, captured.videoRoi)
    maskRects = trimBarcodeBoxesToStripes(captured.frame, candidates)
  } catch {
    maskRects = []
  }
  const image = cropVideoSpaceRoi(captured.frame, captured.videoRoi, maskRects.length > 0 ? maskRects : undefined)
  return { image, maskedCount: maskRects.length, maskRects }
}

// captureRoi で得た画像を認識する。同じ ImageData を使い回して
// （PSM/ホワイトリストを変えながら）何度でも再認識できるよう、
// ワーカーへは複製したバッファを転送し、呼び出し元の image は破壊しない。
export async function recognizeCaptured(
  image: ImageData,
  options: OcrOptions,
  onProgress?: (progress: OcrProgress) => void,
): Promise<OcrResult> {
  // エンジンの振り分けはここ1箇所だけで行う。ML Kit は Capacitor の
  // ネイティブプラグイン呼び出しであって Web Worker を使わないため、
  // ワーカーへ postMessage する経路には一切入らせない
  // （ワーカーを起動すると tesseract 一式の遅延 import が走ってしまい、
  // ML Kit だけ使いたい端末でも約9MBのエンジンを読み込む羽目になる）。
  if (options.engine === 'mlkit') {
    // 進捗の概念が無い（プラグイン呼び出し1回で完結する）ため、
    // 呼び出し側の進捗表示が固まって見えないよう、開始と完了だけ通知する。
    onProgress?.({ status: '文字を認識中', progress: 0 })
    try {
      return await recognizeWithMlKit(image)
    } finally {
      onProgress?.({ status: '文字を認識中', progress: 1 })
    }
  }

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
