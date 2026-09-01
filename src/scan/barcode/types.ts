// バーコード読み取りの共通型。ネイティブ実装（BarcodeDetector）と
// zxing-wasm フォールバック実装の両方がこの形に検出結果を正規化する。

// 検出したバーコードの位置。「渡した画像そのもの」の幅・高さに対する 0..1 の割合
// （= 映像座標。<video> の表示枠に対する割合である表示座標とは別物）。
// 重要: この割合の分母は「実際に検出に使われた入力の実解像度」であり、
// 経路によって異なる。
//   - フレームループのネイティブ経路: <video> をそのまま渡すため videoWidth/videoHeight
//     （ダウンスケールは一切行わないので、常に映像の実解像度そのもの）
//   - フレームループの zxing フォールバック経路: 長辺 1280px を超える場合だけ
//     縮小した OffscreenCanvas の width/height
//   - シャッター時のバーコードマスク検出（detectBoxes）: バックエンドを問わず、
//     静止済みの OffscreenCanvas（= 映像の実解像度）の width/height
// 正規化（0..1 化）は各経路の detect() 実装が「自分が実際に受け取った入力」の
// サイズで行うため、この型自体はどの経路の結果でも同じ意味（映像座標）で扱える。
export type NormalizedRect = { x: number; y: number; w: number; h: number }

export type BarcodeHit = { value: string; format: string; box?: NormalizedRect }

// バーコード検出に渡せる入力。
//   - <video> をそのまま渡せる（ネイティブ経路のフレームループ用。canvas への
//     描画や ImageBitmap 化を挟まないことで、ダウンスケールも per-frame の
//     コピーも発生しない）
//   - OffscreenCanvas（zxing 経路のフレームループ用、およびシャッター時の
//     静止フレームに対する detectBoxes 用）
// 各 BarcodeReader 実装が、必要なら（zxing 経路のように ImageData 化のため）
// 内部で ImageBitmap への変換を行う。呼び出し側が変換を意識する必要はない。
export type BarcodeInput = HTMLVideoElement | OffscreenCanvas

export interface BarcodeReader {
  detect(input: BarcodeInput): Promise<BarcodeHit[]>
  close(): void
}

// 現品票で使われる可能性のある主要フォーマットのみに絞り、検出を高速化する。
export const SUPPORTED_FORMATS = [
  'code_128',
  'code_39',
  'code_93',
  'codabar',
  'ean_13',
  'ean_8',
  'itf',
  'upc_a',
  'upc_e',
  'qr_code',
  'data_matrix',
  'pdf417',
] as const

export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number]
