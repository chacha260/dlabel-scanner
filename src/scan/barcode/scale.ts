// zxing-wasm フォールバック経路（BarcodeDetector 非対応環境）専用の
// ダウンスケール計算のみを集めた純粋関数。DOM/canvas には一切依存しない。
//
// ネイティブ経路はダウンスケールを一切行わない（useBarcodeScanner.ts が
// <video> をそのまま渡す）。zxing-wasm は ImageData を介したソフトウェア
// デコードのため、あまり大きな画像を渡すと処理時間が伸びてしまう。
// そのため「長辺が上限(capPx)を超える場合だけ」アスペクト比を保ったまま
// 上限に収める。超えていなければ一切縮小しない（等倍のまま）。

export type ScaledSize = { width: number; height: number; scale: number }

export function computeDownscaledSize(sourceWidth: number, sourceHeight: number, capPx: number): ScaledSize {
  const safeW = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : 1
  const safeH = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 1
  const safeCap = Number.isFinite(capPx) && capPx > 0 ? capPx : 1

  const longEdge = Math.max(safeW, safeH)
  const scale = longEdge > safeCap ? safeCap / longEdge : 1
  const width = Math.max(1, Math.round(safeW * scale))
  const height = Math.max(1, Math.round(safeH * scale))
  return { width, height, scale }
}
