// OCR 機能の唯一の入口。シャッター操作など、明示的に呼ばれたときだけ実行する
// （フレームループには絶対に組み込まない）。
//
// tesseract.js → ML Kit → PaddleOCR と実機比較を重ねた結果、最終的に PaddleOCR
// （onnxruntime-web・WASM、ブラウザでもAPKでも同じように動く）一本に絞った
// （README「OCR まわりの修正履歴」参照）。エンジンの切り替え・環境判定の配管は
// すべて不要になった。
//
// あわせて、OCR に渡す画像を加工する前処理パイプライン（罫線除去・ROI全体の
// 縞マスク・コントラスト正規化・グレースケール化・拡大縮小）も削除した。
// PaddleOCR には元々ずっと素の画像を渡していて実質使われていなかったため
// （preprocess.ts のコメント参照）。これにより「前処理あり／なしの2経路」を
// 使い分ける必要も無くなり、ROIの切り出しは cropVideoSpaceRoi 1本に統一した
// （旧 cropVideoSpaceRoiRaw を、この用途で唯一の関数になったのでこの名前に
// 統合している）。

import type { NormalizedRect } from '../barcode/types'
export type { NormalizedRect } from '../barcode/types'
import { mapCoverRectToVideo } from './geometry'
import { recognizeWithPaddle } from './paddle'
import type { OcrResult, RoiRect } from './types'

export type { OcrResult, RoiRect } from './types'
// モデル一式が約35MBあるので、読み込みは preparePaddle() を明示的に呼ぶまで遅延される。
export { isPaddleReady, preparePaddle } from './paddle'
// バーコード自動除外（結果カードの「バーコードを自動で除外」トグル）が使う、
// 検出枠を実ピクセルの縞の帯まで縮める処理（preprocess.ts のコメント参照）。
export { trimBarcodeBoxesToStripes } from './preprocess'
export { applyOcrFilter, correctDigitConfusions, filterAlnumOnly, filterDigitsOnly, OCR_FILTER_LABELS } from './postprocess'
export type { OcrFilterMode } from './postprocess'
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

/**
 * ROI（映像座標、0..1）を、静止フレーム（または video 本体）から
 * **元の解像度・元の色のまま** 切り出す。captureFrameAndRoi で変換済みの
 * videoRoi をそのまま使う（表示座標→映像座標の変換はここでは行わない）。
 *
 * 以前はここに、前処理（グレースケール化・コントラスト正規化・罫線除去・
 * 文字行の高さ基準での拡大縮小）をかけた画像を返す経路（cropVideoSpaceRoi）と、
 * 前処理を一切かけない経路（cropVideoSpaceRoiRaw）の2本があった。前処理は
 * tesseract.js の LSTM エンジンに合わせて調整したもので、PaddleOCR には
 * 一度も使われていなかったため（PaddleOCR自身の前処理は
 * src/scan/ocr/paddle/preprocess.ts が別に持つ）、削除して「素の画像を
 * 切り出す」経路1本に統一した。
 *
 * maskRects（バーコードのマスク）は「読ませたくない領域を隠す」意図的な操作
 * なので、渡された場合はここで塗りつぶす。
 */
export function cropVideoSpaceRoi(
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
    // 不透明の中間グレーで塗りつぶす（自然画像を前提とするPaddleOCRに対して、
    // 真っ黒・真っ白の強いエッジを作らないことを優先する）。
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

// cropVideoSpaceRoi で得た画像を認識する。エンジンが PaddleOCR の1つだけになったため、
// 以前あったエンジン振り分け（ML Kit / PaddleOCR）の分岐や、環境判定
// （isMlKitAvailable によるネイティブ/ブラウザの出し分け）はすべて不要になった。
// PaddleOCR は onnxruntime-web（WASM）で動くため、ネイティブ環境かどうかを
// 問わずブラウザでもAPKでも同じように動く。
export async function recognizeCaptured(image: ImageData): Promise<OcrResult> {
  return recognizeWithPaddle(image)
}
