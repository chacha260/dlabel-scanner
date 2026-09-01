// バーコード読み取りの共通型。ネイティブ実装（BarcodeDetector）と
// zxing-wasm フォールバック実装の両方がこの形に検出結果を正規化する。

// 検出したバーコードの位置。「渡した画像そのもの」の幅・高さに対する 0..1 の割合
// （= 映像座標。<video> の表示枠に対する割合である表示座標とは別物）。
// フレームループが検出に使う画像は 720px 長辺へダウンスケールした映像なので、
// この割合は元の映像解像度に依存しない（同じ映像座標のまま使い回せる）。
export type NormalizedRect = { x: number; y: number; w: number; h: number }

export type BarcodeHit = { value: string; format: string; box?: NormalizedRect }

export interface BarcodeReader {
  detect(bitmap: ImageBitmap): Promise<BarcodeHit[]>
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
