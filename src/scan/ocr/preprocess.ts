// OCR 前処理: 映像から関心領域 (ROI) を切り出し、グレースケール化・
// 画素数予算に基づくスケーリングを行う。外部ライブラリに依存しない純粋な canvas 処理。
//
// 以前はここでヒストグラムから大津の手法によるしきい値を求めて二値化していたが、
// Tesseract は内部で自前の適応的二値化を行うため、事前にハード二値化した画像より
// 素のグレースケール画像の方が概して認識精度が良い。ROI 帯にバーコードのバーが
// 写り込むと、大津の二値化はそれを大きな黒い塊にしてしまい、むしろ有害だった。
// そのため二値化は行わず、グレースケール化とスケーリングのみを行う。

import type { RoiRect } from './types'

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

export function preprocessRoi(source: HTMLVideoElement, roi: RoiRect): ImageData {
  const videoWidth = source.videoWidth
  const videoHeight = source.videoHeight

  const sx = Math.max(0, Math.round(roi.x * videoWidth))
  const sy = Math.max(0, Math.round(roi.y * videoHeight))
  const sw = Math.max(1, Math.min(videoWidth - sx, Math.round(roi.w * videoWidth)))
  const sh = Math.max(1, Math.min(videoHeight - sy, Math.round(roi.h * videoHeight)))

  const cropCanvas = new OffscreenCanvas(sw, sh)
  const cropCtx = getContext2d(cropCanvas)
  cropCtx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)
  const { data } = cropCtx.getImageData(0, 0, sw, sh)

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
