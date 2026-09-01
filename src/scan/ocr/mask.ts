// バーコードマスキングに関する純粋な座標計算のみを集めたモジュール。
// 画素データの読み書き（canvas / getImageData への依存）は preprocess.ts 側で行い、
// ここでは「重なっているか」「どれだけ広げるか」「ピクセルに変換すると何 px か」だけを扱う。
//
// 重要: ここで扱う矩形はすべて映像座標（videoWidth/videoHeight に対する 0..1 の割合）。
// 表示座標（<video> の CSS ボックスに対する割合）はここには一切登場しない。
// 表示座標→映像座標の変換は geometry.ts の mapCoverRectToVideo だけが担当する。

import type { NormalizedRect } from '../barcode/types'

export type PixelRect = { x: number; y: number; w: number; h: number }

// バーコード検出枠を広げる既定のマージン（フレーム全体に対する割合）。
//
// 以前は 0.02（フレーム全体の2%）を既定にしていたが、1080px 高のフレームでは
// 上下左右 約21px も広げることになり、バーコードのすぐ隣に印字された文字
// （縞との隙間はそれよりずっと狭いことが多い）まで塗りつぶしてしまっていた。
// BarcodeDetector の boundingBox には元々クワイエットゾーン分の余白が
// 含まれているため、これ以上フレーム全体基準で広げる必要はない。
// 縞の実際の位置への追い込みは stripes.ts 側（実ピクセルを見て縦方向にのみ
// 縮める）で行うため、ここでの既定マージンは 0 とする。
// expandRect 自体はテスト済みで他用途にも使えるため残すが、既定経路では使わない。
export const DEFAULT_MASK_MARGIN = 0

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** 2つの正規化矩形が重なっているか（面積0の矩形や、辺が接しているだけの場合は重なりとみなさない） */
export function rectsOverlap(a: NormalizedRect, b: NormalizedRect): boolean {
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return false
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** 矩形を上下左右に margin（0..1）だけ広げる。0..1 の範囲でクランプする */
export function expandRect(rect: NormalizedRect, margin: number): NormalizedRect {
  const safeMargin = Number.isFinite(margin) && margin > 0 ? margin : 0
  const x0 = clamp01(rect.x - safeMargin)
  const y0 = clamp01(rect.y - safeMargin)
  const x1 = clamp01(rect.x + rect.w + safeMargin)
  const y1 = clamp01(rect.y + rect.h + safeMargin)
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

/**
 * 正規化矩形（映像座標、0..1）を、指定したフレームサイズ（px）上のピクセル矩形に変換する。
 * 右端・下端を先に丸めてから幅・高さを引き算することで、個別に x と w を丸めるより
 * 誤差が蓄積しにくくしている。frame の範囲外にはみ出さないようクランプする。
 */
export function normalizedRectToPixels(rect: NormalizedRect, frameWidth: number, frameHeight: number): PixelRect {
  const safeW = Number.isFinite(frameWidth) && frameWidth > 0 ? frameWidth : 0
  const safeH = Number.isFinite(frameHeight) && frameHeight > 0 ? frameHeight : 0

  const x0 = Math.round(rect.x * safeW)
  const y0 = Math.round(rect.y * safeH)
  const x1 = Math.round((rect.x + rect.w) * safeW)
  const y1 = Math.round((rect.y + rect.h) * safeH)

  const clampedX0 = Math.max(0, Math.min(x0, safeW))
  const clampedY0 = Math.max(0, Math.min(y0, safeH))
  const clampedX1 = Math.max(clampedX0, Math.min(x1, safeW))
  const clampedY1 = Math.max(clampedY0, Math.min(y1, safeH))

  return { x: clampedX0, y: clampedY0, w: clampedX1 - clampedX0, h: clampedY1 - clampedY0 }
}

/**
 * 検出されたバーコード枠のうち、ROI と重なるものだけをマージン込みで返す。
 * ROI と重ならない枠は OCR に影響しないため除外する（マスクする理由がない）。
 */
export function boxesToMask(
  boxes: NormalizedRect[],
  roi: NormalizedRect,
  margin: number = DEFAULT_MASK_MARGIN,
): NormalizedRect[] {
  return boxes.map((box) => expandRect(box, margin)).filter((expanded) => rectsOverlap(expanded, roi))
}
