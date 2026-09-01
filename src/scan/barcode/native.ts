// Android Chrome が実装しているネイティブ BarcodeDetector API を使うリーダー。
// 標準の DOM 型定義には含まれていないため、必要最小限のインターフェースを
// このファイル内だけで宣言する（グローバル汚染を避ける）。

import type { BarcodeHit, BarcodeReader, NormalizedRect } from './types'
import { SUPPORTED_FORMATS } from './types'

// boundingBox は DOMRectReadOnly だが、使うのは x/y/width/height の4値だけなので
// 最小限のインターフェースに絞る。
interface BoundingBoxLike {
  x: number
  y: number
  width: number
  height: number
}

interface DetectedBarcodeLike {
  rawValue: string
  format: string
  // detect() に渡した ImageBitmap のピクセル座標系（= 映像座標に対応する解像度）。
  boundingBox: BoundingBoxLike
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

// BarcodeDetector の boundingBox（detect() に渡した画像自身のピクセル座標）を、
// その画像の幅・高さに対する 0..1 の割合（映像座標）へ正規化する。
function toNormalizedBox(box: BoundingBoxLike | undefined, imageWidth: number, imageHeight: number): NormalizedRect | undefined {
  if (!box || !(imageWidth > 0) || !(imageHeight > 0)) return undefined
  return {
    x: clamp01(box.x / imageWidth),
    y: clamp01(box.y / imageHeight),
    w: Math.max(0, Math.min(box.width / imageWidth, 1)),
    h: Math.max(0, Math.min(box.height / imageHeight, 1)),
  }
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
        return results.map((r) => ({
          value: r.rawValue,
          format: r.format,
          box: toNormalizedBox(r.boundingBox, bitmap.width, bitmap.height),
        }))
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
