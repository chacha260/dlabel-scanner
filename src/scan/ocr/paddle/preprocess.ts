// canvas に触れる「薄いグルー」部分: ImageDataのリサイズ・切り出し。
//
// アルゴリズム部分（正規化の数式、リサイズ後サイズの計算）はすべて
// tensorize.ts / geometry.ts の純粋関数に切り出してあり、ここではそれらが
// 必要とする「実際にピクセルを動かす」処理（canvasのdrawImageによる拡大縮小・
// 切り出し）だけを行う。ブラウザ標準のdrawImageによる補間（バイリニア相当）に
// 任せており、自前でリサンプリングアルゴリズムを実装していない。
//
// mlkit.tsと同様、OffscreenCanvasを使う（Capacitor WebView・主要ブラウザの
// いずれでも利用可能）。

import type { AxisAlignedBox } from './geometry'

function requireContext2D(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('2D context is not available')
  }
  return ctx
}

function imageDataToCanvas(image: ImageData): OffscreenCanvas {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = requireContext2D(canvas)
  ctx.putImageData(image, 0, 0)
  return canvas
}

/**
 * ImageDataを指定サイズへリサイズする（アスペクト比の保持は呼び出し側の責務。
 * ここでは指定された幅・高さへそのまま引き伸ばす／縮める）。
 */
export function resizeImageData(image: ImageData, targetWidth: number, targetHeight: number): ImageData {
  const w = Math.max(1, Math.round(targetWidth))
  const h = Math.max(1, Math.round(targetHeight))
  const source = imageDataToCanvas(image)
  const canvas = new OffscreenCanvas(w, h)
  const ctx = requireContext2D(canvas)
  ctx.drawImage(source, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

/**
 * 元画像（前処理・縮小をしていない、そのままの解像度のImageData）から、
 * 検出結果の枠（元画像座標）で1枚切り出す。
 *
 * 検出用にリサイズした画像ではなくここで渡された元画像から切り出す理由:
 * 検出は960px程度まで縮小した画像に対して行うため、その画像から直接切り出すと
 * 認識に渡る文字の解像度が不必要に落ちてしまう。文字認識の精度は入力解像度に
 * 敏感なため、切り出しは必ず元解像度の画像に対して行う（仕様として指定されたとおり）。
 *
 * unclipで広げた枠が元画像の外へはみ出す可能性があるため、境界にクランプする。
 */
export function cropImageData(image: ImageData, box: AxisAlignedBox): ImageData {
  const sx = Math.max(0, Math.round(box.x))
  const sy = Math.max(0, Math.round(box.y))
  const sw = Math.max(1, Math.min(image.width - sx, Math.round(box.w)))
  const sh = Math.max(1, Math.min(image.height - sy, Math.round(box.h)))

  const source = imageDataToCanvas(image)
  const canvas = new OffscreenCanvas(sw, sh)
  const ctx = requireContext2D(canvas)
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)
  return ctx.getImageData(0, 0, sw, sh)
}
