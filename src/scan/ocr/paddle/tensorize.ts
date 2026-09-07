// 画素配列 → モデル入力テンソル用 Float32Array への正規化。
//
// Uint8ClampedArray は ImageData.data と同じ型だが、DOM固有の型ではなく
// Node標準のTypedArrayでもあるため、実際のリサイズ（canvasのdrawImageが必須で
// 純粋関数にできない）とは切り離してここに置き、Vitest（node環境）で
// テストできるようにしてある。呼び出し側（preprocess.ts）が、canvasで
// リサイズ済みのImageDataからこの関数に渡す。
//
// 入力は必ず「モデルが要求する幅・高さにリサイズ済み」のRGBA画素配列である前提
// （このファイル自体はリサイズを行わない）。

export const IMAGENET_MEAN: readonly [number, number, number] = [0.485, 0.456, 0.406]
export const IMAGENET_STD: readonly [number, number, number] = [0.229, 0.224, 0.225]

/**
 * 検出モデル入力用の正規化: RGBA画素配列 → NCHW配置のFloat32Array。
 * 0..255を0..1にしたのち、ImageNetの平均・標準偏差で正規化する
 * （検出モデルの前処理仕様として指定されたとおり）。アルファチャンネルは無視する。
 *
 * pixels.length が width*height*4 に満たない場合は、はみ出す分を0として扱う
 * （例外は投げない）。
 */
export function normalizeDetPixels(pixels: Uint8ClampedArray, width: number, height: number): Float32Array {
  const size = Math.max(0, Math.floor(width)) * Math.max(0, Math.floor(height))
  const out = new Float32Array(3 * size)
  for (let i = 0; i < size; i++) {
    const o = i * 4
    const r = o < pixels.length ? pixels[o] : 0
    const g = o + 1 < pixels.length ? pixels[o + 1] : 0
    const b = o + 2 < pixels.length ? pixels[o + 2] : 0
    out[i] = (r / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0]
    out[size + i] = (g / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1]
    out[2 * size + i] = (b / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2]
  }
  return out
}

/**
 * 認識モデル入力用の正規化: RGBA画素配列 → NCHW配置のFloat32Array。
 * (pixel/255 - 0.5) / 0.5 で -1..1 に正規化する（認識モデルの前処理仕様として
 * 指定されたとおり）。アルファチャンネルは無視する。
 *
 * pixels.length が width*height*4 に満たない場合は、はみ出す分を0として扱う
 * （例外は投げない）。
 */
export function normalizeRecPixels(pixels: Uint8ClampedArray, width: number, height: number): Float32Array {
  const size = Math.max(0, Math.floor(width)) * Math.max(0, Math.floor(height))
  const out = new Float32Array(3 * size)
  for (let i = 0; i < size; i++) {
    const o = i * 4
    const r = o < pixels.length ? pixels[o] : 0
    const g = o + 1 < pixels.length ? pixels[o + 1] : 0
    const b = o + 2 < pixels.length ? pixels[o + 2] : 0
    out[i] = (r / 255 - 0.5) / 0.5
    out[size + i] = (g / 255 - 0.5) / 0.5
    out[2 * size + i] = (b / 255 - 0.5) / 0.5
  }
  return out
}
