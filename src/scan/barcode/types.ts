// バーコード読み取りの共通型。ネイティブ実装（BarcodeDetector）と
// zxing-wasm フォールバック実装の両方がこの形に検出結果を正規化する。

export type BarcodeHit = { value: string; format: string }

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
