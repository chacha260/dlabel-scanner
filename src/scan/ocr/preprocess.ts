// OCR 前処理: 映像から関心領域 (ROI) を切り出し、グレースケール化・大津の二値化・
// 2倍のニアレストネイバー拡大を行う。外部ライブラリに依存しない純粋な canvas 処理。

import type { RoiRect } from './types'

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

  // 2倍のニアレストネイバー拡大をしながら二値化する（文字の輪郭が滑らかにならず OCR 向き）
  const scale = 2
  const outW = sw * scale
  const outH = sh * scale
  const out = new ImageData(outW, outH)
  const outData = out.data

  for (let y = 0; y < outH; y++) {
    const srcY = Math.min(sh - 1, Math.floor(y / scale))
    const rowOffset = srcY * sw
    for (let x = 0; x < outW; x++) {
      const srcX = Math.min(sw - 1, Math.floor(x / scale))
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
