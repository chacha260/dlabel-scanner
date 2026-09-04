// OCR 機能の唯一の入口。シャッター操作など、明示的に呼ばれたときだけ実行する
// （フレームループには絶対に組み込まない）。
//
// 以前は tesseract.js（Web Worker 上で動く JS 実装）と ML Kit の2エンジンを
// 併存させ、現場の現品票でどちらが実際に読めるかを比較していた。実機比較の結果
// ML Kit が圧倒的に高精度だったため、tesseract.js は完全に削除し、以後は
// ML Kit（Capacitor のネイティブプラグイン経由、APK でのみ動作）だけを使う。
// これにより「初回だけ約9MBのエンジンをダウンロードする」「Web Worker を起動して
// 進捗を逐次受け取る」といった tesseract.js 固有の配管はすべて不要になった。

import type { NormalizedRect } from '../barcode/types'
export type { NormalizedRect } from '../barcode/types'
import { mapCoverRectToVideo } from './geometry'
import { boxesToMask } from './mask'
import { preprocessRoi, trimBarcodeBoxesToStripes } from './preprocess'
import type { OcrPreprocessOptions } from './preprocess'
import { DEFAULT_OCR_PREPROCESS_OPTIONS } from './preprocess'
import { isMlKitAvailable, recognizeWithMlKit } from './mlkit'
import type { OcrResult, RoiRect } from './types'

export type { OcrResult, RoiRect } from './types'
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
// 「どの文字が怪しいか」の判定（2パス照合）。判定は純粋関数として agreement.ts に
// 閉じ込めてあり、ここでは UI から使えるように通すだけ。
// 注意: 以前はここに文字ごとの信頼度による判定（judgeByConfidence）も含まれていたが、
// ML Kit は信頼度を一切返さないため機能せず削除した（agreement.ts のコメント参照）。
// compareOcrPasses / mergeVerdicts は前処理を変えた2パスの食い違い検出に使うため残す。
export { compareOcrPasses, mergeVerdicts } from './agreement'
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

// シャッターを押した「その瞬間」の映像から、ROI（表示座標）で指定した範囲を
// 前処理込みで切り出す。roi は「画面に表示している枠」に対する割合（表示座標）で
// 受け取り、ここで映像の実解像度上の範囲（映像座標）へ変換する。object-fit: cover
// による切り落としを考慮しないと、画面の枠と実際に切り出される範囲がずれるため、
// 変換は必ずここを通す。maskRects を渡す場合は、映像座標（フレーム全体に対する
// 0..1）で指定すること。
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
 * なるまでの縮小」）は、もともと tesseract.js の LSTM エンジンに合わせて
 * 調整したものだった。Tesseract はスキャンした書類向けのエンジンで、
 * 小さめ・高コントラストのグレースケール画像を好むため、この前処理が効いていた。
 *
 * ところが ML Kit は逆で、**カメラで撮った自然な写真**で学習されている。
 * 同じ画像を渡すと、
 *   - 96px まで縮小されたことで細部の情報が失われる
 *   - グレースケール化・コントラスト伸長で、モデルが期待する画素分布から外れる
 * という二重の不利を負う。tesseract.js は削除したが、この差自体は無くなって
 * いないため、ML Kit へ渡す経路では引き続きこの関数で「切り出しただけ」の
 * 画像を作り、前処理の有無そのものを比較軸として扱えるようにする
 * （比較モード src/ui/OcrCompareSheet.tsx で「素の画像」対「前処理あり」を比べる）。
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

// captureRoi で得た画像を認識する。エンジンは ML Kit の1つだけになったため、
// 以前あったエンジン振り分け・Web Worker への postMessage・進捗通知の配管は
// すべて不要になった（ML Kit はネイティブプラグインの呼び出し1回で完結し、
// 進捗という概念自体を持たない）。
export async function recognizeCaptured(image: ImageData): Promise<OcrResult> {
  if (!isMlKitAvailable()) {
    // ML Kit は Capacitor のネイティブプラグイン経由でしか動かないため、ブラウザ
    // （pnpm dev や GitHub Pages 等）で呼ばれると本来は成立しない。ここで弾かずに
    // recognizeWithMlKit まで進めると、プラグイン未実装による分かりにくい例外
    // （あるいは無反応）になりかねないため、現場でも一目で原因が分かる日本語の
    // エラーとしてここで確実に失敗させる。呼び出し側（UI）は isMlKitAvailable()
    // を見てシャッター自体を無効化するが、その二重の安全策としてここでも自衛する。
    throw new Error('OCRはAndroidアプリ版でのみ利用できます')
  }
  return recognizeWithMlKit(image)
}
