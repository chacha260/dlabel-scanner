// OCR 前処理: 映像から関心領域 (ROI) を切り出し、グレースケール化・大津の二値化・
// 画素数予算に基づくスケーリングを行う。外部ライブラリに依存しない純粋な canvas 処理。

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

// 256 階調ヒストグラムからクラス間分散を最大化するしきい値を求める（大津の手法）
function otsuThreshold(histogram: Uint32Array, totalPixels: number): number {
  let sumAll = 0
  for (let t = 0; t < 256; t++) {
    sumAll += t * histogram[t]
  }

  let sumBackground = 0
  let weightBackground = 0
  let bestThreshold = 0
  let bestVariance = -1

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t]
    if (weightBackground === 0) continue

    const weightForeground = totalPixels - weightBackground
    if (weightForeground === 0) break

    sumBackground += t * histogram[t]

    const meanBackground = sumBackground / weightBackground
    const meanForeground = (sumAll - sumBackground) / weightForeground
    const meanDiff = meanBackground - meanForeground
    const betweenClassVariance = weightBackground * weightForeground * meanDiff * meanDiff

    if (betweenClassVariance > bestVariance) {
      bestVariance = betweenClassVariance
      bestThreshold = t
    }
  }

  return bestThreshold
}

// scale >= 1: ニアレストネイバーで拡大しながら二値化する（文字の輪郭が滑らかにならず OCR 向き）
function resampleUpscale(gray: Uint8ClampedArray, sw: number, sh: number, threshold: number, scale: number): ImageData {
  const outW = Math.max(1, Math.round(sw * scale))
  const outH = Math.max(1, Math.round(sh * scale))
  const out = new ImageData(outW, outH)
  const outData = out.data

  for (let y = 0; y < outH; y++) {
    const srcY = Math.min(sh - 1, Math.floor((y * sh) / outH))
    const rowOffset = srcY * sw
    for (let x = 0; x < outW; x++) {
      const srcX = Math.min(sw - 1, Math.floor((x * sw) / outW))
      const value = gray[rowOffset + srcX] > threshold ? 255 : 0
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
// 出力1画素あたりの元画素を平均するボックスフィルタで縮小する。
// 平均はグレースケールの状態で行い、その後にしきい値で二値化する。
function resampleDownscale(gray: Uint8ClampedArray, sw: number, sh: number, threshold: number, scale: number): ImageData {
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
      const average = count > 0 ? sum / count : 0
      const value = average > threshold ? 255 : 0
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

  // グレースケール化（輝度＝ luma）とヒストグラム作成を同時に行う
  const pixelCount = sw * sh
  const gray = new Uint8ClampedArray(pixelCount)
  const histogram = new Uint32Array(256)
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4
    const luma = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2])
    gray[i] = luma
    histogram[luma] += 1
  }

  const threshold = otsuThreshold(histogram, pixelCount)
  const scale = computeOcrScale(sw, sh)

  return scale >= 1
    ? resampleUpscale(gray, sw, sh, threshold, scale)
    : resampleDownscale(gray, sw, sh, threshold, scale)
}
