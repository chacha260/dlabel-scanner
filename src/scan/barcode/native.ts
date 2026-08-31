// Android Chrome が実装しているネイティブ BarcodeDetector API を使うリーダー。
// 標準の DOM 型定義には含まれていないため、必要最小限のインターフェースを
// このファイル内だけで宣言する（グローバル汚染を避ける）。

import type { BarcodeHit, BarcodeReader } from './types'
import { SUPPORTED_FORMATS } from './types'

interface DetectedBarcodeLike {
  rawValue: string
  format: string
}

interface BarcodeDetectorLike {
  detect(source: ImageBitmap): Promise<DetectedBarcodeLike[]>
}

interface BarcodeDetectorConstructorLike {
  new (options?: { formats: string[] }): BarcodeDetectorLike
  getSupportedFormats(): Promise<string[]>
}

function getBarcodeDetectorCtor(): BarcodeDetectorConstructorLike | undefined {
  return (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorConstructorLike }).BarcodeDetector
}

export function isNativeAvailable(): boolean {
  return typeof getBarcodeDetectorCtor() === 'function'
}

export async function createNativeReader(): Promise<BarcodeReader> {
  const BarcodeDetectorCtor = getBarcodeDetectorCtor()
  if (!BarcodeDetectorCtor) {
    throw new Error('BarcodeDetector is not available')
  }

  const supported = await BarcodeDetectorCtor.getSupportedFormats()
  const formats = SUPPORTED_FORMATS.filter((format) => supported.includes(format))
  // 端末が対応フォーマットを一つも報告しない場合は、既定の一覧のまま試す
  const detector = new BarcodeDetectorCtor({ formats: formats.length > 0 ? formats : [...SUPPORTED_FORMATS] })

  return {
    async detect(bitmap: ImageBitmap): Promise<BarcodeHit[]> {
      try {
        const results = await detector.detect(bitmap)
        return results.map((r) => ({ value: r.rawValue, format: r.format }))
      } catch {
        // 検出エラーは「見つからなかった」として扱い、フレームループを止めない
        return []
      } finally {
        // ネイティブ経路では bitmap の所有権をこのリーダーが持つため、ここで解放する
        bitmap.close()
      }
    },
    close() {
      // ネイティブ実装はリソース解放不要
    },
  }
}
