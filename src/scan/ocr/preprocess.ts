// OCR 前処理: 映像から関心領域 (ROI) を切り出し、グレースケール化・
// 画素数予算に基づくスケーリングを行う。外部ライブラリに依存しない純粋な canvas 処理。
//
// 以前はここでヒストグラムから大津の手法によるしきい値を求めて二値化していたが、
// Tesseract は内部で自前の適応的二値化を行うため、事前にハード二値化した画像より
// 素のグレースケール画像の方が概して認識精度が良い。ROI 帯にバーコードのバーが
// 写り込むと、大津の二値化はそれを大きな黒い塊にしてしまい、むしろ有害だった。
// そのため二値化は行わず、グレースケール化とスケーリングのみを行う。

import type { NormalizedRect } from '../barcode/types'
import { normalizedRectToPixels } from './mask'
import type { RoiRect } from './types'

// ROI の切り出し元。ライブの <video> だけでなく、シャッター押下時に captureFrame() で
// 撮った静止フレーム（OffscreenCanvas）からも同じロジックで切り出せるようにする。
export type FrameSource = HTMLVideoElement | OffscreenCanvas

function frameSize(source: FrameSource): { width: number; height: number } {
  if (source instanceof OffscreenCanvas) {
    return { width: source.width, height: source.height }
  }
  return { width: source.videoWidth, height: source.videoHeight }
}

// OCR に渡す画像の出力画素数の上限。Tesseract は画像が大きいほど時間がかかるため、
// 「文字が判別できる最小限の解像度」に抑えることでレスポンスを大幅に改善する。
export const OCR_PIXEL_BUDGET = 300_000

// ROI の実サイズ（sw × sh）から、拡大縮小のスケール係数を求める純粋関数。
// - 小さい ROI はそのまま 2 倍に拡大する（文字が小さすぎると認識精度が落ちるため）
// - 2 倍した結果が画素数予算を超える場合は、予算にちょうど収まるところまでスケールを落とす
// - 最終的なスケールは [0.6, 2] の範囲にクランプする（縮小しすぎると文字が潰れるため）
// - sw・sh が 0 以下や NaN であっても、有限の正の値を返し、絶対に例外を投げない
export function computeOcrScale(sw: number, sh: number): number {
  const safeW = Number.isFinite(sw) && sw > 0 ? sw : 1
  const safeH = Number.isFinite(sh) && sh > 0 ? sh : 1

  const preferredScale = 2
  const sourcePixels = safeW * safeH
  const preferredPixels = sourcePixels * preferredScale * preferredScale

  let scale = preferredScale
  if (preferredPixels > OCR_PIXEL_BUDGET) {
    // sourcePixels * scale^2 = OCR_PIXEL_BUDGET を満たす scale まで落とす
    scale = Math.sqrt(OCR_PIXEL_BUDGET / sourcePixels)
  }

  if (!Number.isFinite(scale) || scale <= 0) {
    scale = 0.6
  }

  return Math.min(2, Math.max(0.6, scale))
}

function getContext2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    throw new Error('2D context is not available')
  }
  return ctx
}

// scale >= 1: ニアレストネイバーで拡大する（グレースケールのまま。二値化はしない）
function resampleUpscale(gray: Uint8ClampedArray, sw: number, sh: number, scale: number): ImageData {
  const outW = Math.max(1, Math.round(sw * scale))
  const outH = Math.max(1, Math.round(sh * scale))
  const out = new ImageData(outW, outH)
  const outData = out.data

  for (let y = 0; y < outH; y++) {
    const srcY = Math.min(sh - 1, Math.floor((y * sh) / outH))
    const rowOffset = srcY * sw
    for (let x = 0; x < outW; x++) {
      const srcX = Math.min(sw - 1, Math.floor((x * sw) / outW))
      const value = gray[rowOffset + srcX]
      const o = (y * outW + x) * 4
      outData[o] = value
      outData[o + 1] = value
      outData[o + 2] = value
      outData[o + 3] = 255
    }
  }

  return out
}

// scale < 1: ニアレストネイバーはエイリアシング（文字のかすれ・欠け）が目立つため、
// 出力1画素あたりの元画素を平均するボックスフィルタで縮小する（グレースケールのまま）。
function resampleDownscale(gray: Uint8ClampedArray, sw: number, sh: number, scale: number): ImageData {
  const outW = Math.max(1, Math.round(sw * scale))
  const outH = Math.max(1, Math.round(sh * scale))
  const out = new ImageData(outW, outH)
  const outData = out.data

  for (let y = 0; y < outH; y++) {
    const srcY0 = Math.floor((y * sh) / outH)
    const srcY1 = Math.max(srcY0 + 1, Math.floor(((y + 1) * sh) / outH))
    for (let x = 0; x < outW; x++) {
      const srcX0 = Math.floor((x * sw) / outW)
      const srcX1 = Math.max(srcX0 + 1, Math.floor(((x + 1) * sw) / outW))

      let sum = 0
      let count = 0
      for (let sy = srcY0; sy < srcY1 && sy < sh; sy++) {
        const rowOffset = sy * sw
        for (let sx = srcX0; sx < srcX1 && sx < sw; sx++) {
          sum += gray[rowOffset + sx]
          count++
        }
      }
      const value = count > 0 ? Math.round(sum / count) : 0
      const o = (y * outW + x) * 4
      outData[o] = value
      outData[o + 1] = value
      outData[o + 2] = value
      outData[o + 3] = 255
    }
  }

  return out
}

// crop 内の輝度（luma）を返す（マスクの塗りつぶし色をサンプリングするための小さなヘルパー）
function luma(data: Uint8ClampedArray, offset: number): number {
  return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2]
}

// ROI 切り出し画像の外周（=ラベルの地の色である可能性が高い部分）をサンプリングして、
// バーコード枠を塗りつぶすためのグレー値を求める。純粋な黒・白で塗ると Tesseract に
// とって不自然に強いエッジになりかねないため、周囲に馴染む中間的な明るさを使う。
// 大きな crop でも計算量が増えすぎないよう、辺に沿って一定間隔で間引いてサンプルする。
function sampleFillGray(data: Uint8ClampedArray, w: number, h: number): number {
  if (w <= 0 || h <= 0) return 128
  let sum = 0
  let count = 0
  const step = Math.max(1, Math.floor(Math.min(w, h) / 32))
  for (let x = 0; x < w; x += step) {
    sum += luma(data, (x) * 4)
    sum += luma(data, ((h - 1) * w + x) * 4)
    count += 2
  }
  for (let y = 0; y < h; y += step) {
    sum += luma(data, (y * w) * 4)
    sum += luma(data, (y * w + (w - 1)) * 4)
    count += 2
  }
  return count > 0 ? Math.round(sum / count) : 128
}

// maskRects（映像座標、フレーム全体に対する 0..1）を、ROI crop（frameWidth×frameHeight の
// フレームから (cropX, cropY) を起点に cropW×cropH だけ切り出したもの）のローカル
// ピクセル座標に変換して、周囲の色で塗りつぶす。
//
// 「映像座標→フレーム全体のピクセル座標」への変換は必ず frameWidth/frameHeight
// （crop 前のフレーム全体のサイズ）を使って行い、その後で crop の原点を引く。
// crop 後のサイズ（sw/sh）を使って正規化してしまうと、ROI 以外の場所にある
// バーコードの割合まで ROI 内の割合として扱うことになり、表示座標と映像座標を
// 混同するのと同種の事故（枠のずれ）につながるため、ここは特に注意する。
function applyMaskFill(
  data: Uint8ClampedArray,
  sw: number,
  sh: number,
  maskRects: NormalizedRect[],
  frameWidth: number,
  frameHeight: number,
  cropX: number,
  cropY: number,
): void {
  const fill = sampleFillGray(data, sw, sh)
  for (const rect of maskRects) {
    const framePx = normalizedRectToPixels(rect, frameWidth, frameHeight)
    const x0 = Math.max(0, framePx.x - cropX)
    const y0 = Math.max(0, framePx.y - cropY)
    const x1 = Math.min(sw, framePx.x + framePx.w - cropX)
    const y1 = Math.min(sh, framePx.y + framePx.h - cropY)
    if (x1 <= x0 || y1 <= y0) continue // ROI と交差しない枠は何もしない

    for (let y = y0; y < y1; y++) {
      const rowOffset = (y * sw) * 4
      for (let x = x0; x < x1; x++) {
        const o = rowOffset + x * 4
        data[o] = fill
        data[o + 1] = fill
        data[o + 2] = fill
        // アルファはそのまま（常に不透明で描画しているため 255 のまま）
      }
    }
  }
}

/**
 * ROI（映像座標、0..1）を source から切り出し、グレースケール化・スケーリングまで行う。
 *
 * maskRects を渡すと、切り出し前にそれらの矩形（映像座標、フレーム全体に対する割合）を
 * 周囲の色で塗りつぶしてからグレースケール化する。バーコードのストライプが ROI に
 * 写り込んで OCR の邪魔になるのを防ぐための仕組み（呼び出し側は mask.ts の
 * boxesToMask で ROI と重なる検出済みバーコード枠だけに絞り込んでから渡す）。
 */
export function preprocessRoi(source: FrameSource, roi: RoiRect, maskRects?: NormalizedRect[]): ImageData {
  const { width: frameWidth, height: frameHeight } = frameSize(source)

  const sx = Math.max(0, Math.round(roi.x * frameWidth))
  const sy = Math.max(0, Math.round(roi.y * frameHeight))
  const sw = Math.max(1, Math.min(frameWidth - sx, Math.round(roi.w * frameWidth)))
  const sh = Math.max(1, Math.min(frameHeight - sy, Math.round(roi.h * frameHeight)))

  const cropCanvas = new OffscreenCanvas(sw, sh)
  const cropCtx = getContext2d(cropCanvas)
  cropCtx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)
  const { data } = cropCtx.getImageData(0, 0, sw, sh)

  if (maskRects && maskRects.length > 0) {
    applyMaskFill(data, sw, sh, maskRects, frameWidth, frameHeight, sx, sy)
  }

  // グレースケール化（輝度＝ luma）。二値化はしない。
  const pixelCount = sw * sh
  const gray = new Uint8ClampedArray(pixelCount)
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4
    gray[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2])
  }

  const scale = computeOcrScale(sw, sh)

  return scale >= 1 ? resampleUpscale(gray, sw, sh, scale) : resampleDownscale(gray, sw, sh, scale)
}
