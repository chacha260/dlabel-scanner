// BarcodeDetector 非対応環境（一部の WebView 等）向けのフォールバック用 Web Worker。
// zxing-wasm を使ってバーコードをデコードする。メインバンドルには含まれず、
// ネイティブ実装が使えないときだけ src/scan/barcode/index.ts から生成される。

import { prepareZXingModule, readBarcodes, type Position, type ReadInputBarcodeFormat } from 'zxing-wasm/reader'
// wasm 本体はネットワーク不要で自前ホスト（CDN 参照はオフライン要件に反するため使わない）
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { SUPPORTED_FORMATS } from './types'
import type { BarcodeHit, NormalizedRect } from './types'

// BarcodeDetector 形式（snake_case）から zxing-cpp の正規フォーマット名へ変換する
const FORMAT_MAP: Record<(typeof SUPPORTED_FORMATS)[number], ReadInputBarcodeFormat> = {
  code_128: 'Code128',
  code_39: 'Code39',
  code_93: 'Code93',
  codabar: 'Codabar',
  ean_13: 'EAN13',
  ean_8: 'EAN8',
  itf: 'ITF',
  upc_a: 'UPCA',
  upc_e: 'UPCE',
  qr_code: 'QRCode',
  data_matrix: 'DataMatrix',
  pdf417: 'PDF417',
}

// zxing-cpp の正規フォーマット名から BarcodeDetector 形式へ逆変換する
const REVERSE_FORMAT_MAP = new Map<string, string>(
  Object.entries(FORMAT_MAP).map(([snake, pascal]) => [pascal, snake]),
)

const ZXING_FORMATS = Object.values(FORMAT_MAP)

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

// zxing-cpp の position は4隅の頂点（topLeft/topRight/bottomLeft/bottomRight）を
// 読み取り対象の画像自身のピクセル座標で返す（zxing-wasm の型定義 position.d.ts の
// ReadResult.position を参照。回転したバーコードでも矩形とは限らないため、
// 4点の外接矩形（min/max）を取ってから、画像の幅・高さで正規化する（映像座標）。
function boxFromPosition(position: Position, imageWidth: number, imageHeight: number): NormalizedRect | undefined {
  if (!(imageWidth > 0) || !(imageHeight > 0)) return undefined
  const xs = [position.topLeft.x, position.topRight.x, position.bottomLeft.x, position.bottomRight.x]
  const ys = [position.topLeft.y, position.topRight.y, position.bottomLeft.y, position.bottomRight.y]
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    x: clamp01(minX / imageWidth),
    y: clamp01(minY / imageHeight),
    w: Math.max(0, Math.min((maxX - minX) / imageWidth, 1)),
    h: Math.max(0, Math.min((maxY - minY) / imageHeight, 1)),
  }
}

prepareZXingModule({
  overrides: { locateFile: () => wasmUrl },
})

type DecodeRequest = { type: 'decode'; id: number; bitmap: ImageBitmap }
type DecodeResponse = { type: 'result'; id: number; hits: BarcodeHit[]; error?: string }

// この worker が受け付ける入力の最終防衛ライン（画素数の上限）。
// 通常はここに届く前に呼び出し側（useBarcodeScanner.ts）が
// CROP_PIXEL_BUDGET_PX（約2.5MP、「枠内のみ」ON時）や ZXING_LONG_EDGE_PX
// （長辺1280px、フル フレーム時）で十分に絞り込んでいるため、この上限に
// 引っかかること自体は想定していない。ただし唯一の例外として、シャッター
// 押下時の detectBoxes()（useBarcodeScanner.ts）は静止フレームを
// ダウンスケールせずそのまま渡す設計であり、カメラ画質プリセット
// （camera/quality.ts）が既定の 'max'（3840x2160=約830万px）のときや、
// 実機のセンサーがそれ以上（12MP級等）を返してきた場合はここまで
// 大きな画素数がそのまま届き得る。
// getImageData() は画素数に比例した ArrayBuffer を確保し、readBarcodes()は
// それを wasm ヒープへコピーするため、際限なく大きい入力を許すと
// emscripten の abort()（RangeError等）や、それによる worker の異常終了を
// 招きうる（barcode/index.ts の createZxingReaderCore が「worker が黙って
// 応答しなくなる」経路を塞いでいるとはいえ、そもそも起こさないに越したことはない）。
// 12MP（画質'max'の830万pxに、実機の12MPセンサー分の余裕を足した値）を
// 緩めの上限とし、これを超える入力はデコードそのものをスキップして
// 空配列を返す（呼び出し側は「見つからなかった」として扱える）。
const MAX_INPUT_PIXELS = 12_000_000

// 使い回す OffscreenCanvas（フレームごとに生成しない）
let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

function getContext(width: number, height: number): OffscreenCanvasRenderingContext2D {
  if (!canvas) {
    canvas = new OffscreenCanvas(width, height)
    ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  if (!ctx) {
    throw new Error('2D context is not available')
  }
  return ctx
}

function post(message: DecodeResponse): void {
  ;(self as unknown as { postMessage(message: DecodeResponse): void }).postMessage(message)
}

self.addEventListener('message', (event: MessageEvent<DecodeRequest>) => {
  const data = event.data
  if (data.type !== 'decode') return
  void handleDecode(data)
})

async function handleDecode(request: DecodeRequest): Promise<void> {
  const { id, bitmap } = request
  try {
    const pixelCount = bitmap.width * bitmap.height
    if (pixelCount > MAX_INPUT_PIXELS) {
      // 上のコメント（MAX_INPUT_PIXELS）参照。getImageData/readBarcodes に
      // 進まず安全に諦める。bitmap.close() は finally で行われる。
      console.warn(
        `[barcode] zxing worker: input too large (${bitmap.width}x${bitmap.height} = ${pixelCount}px), skipping decode`,
      )
      post({
        type: 'result',
        id,
        hits: [],
        error: `入力画像が上限(${MAX_INPUT_PIXELS}px)を超えているためデコードをスキップしました (${bitmap.width}x${bitmap.height})`,
      })
      return
    }

    const context = getContext(bitmap.width, bitmap.height)
    context.drawImage(bitmap, 0, 0)
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height)

    const results = await readBarcodes(imageData, {
      formats: ZXING_FORMATS,
      tryHarder: false,
      // 1フレームに大量のバーコードが写り込む病的な入力（例: 小さいQRを
      // 多数印刷したシートをまるごと写す等）で、1回のデコードに際限なく
      // 時間がかかることを防ぐための上限。現品票が縦に複数並ぶ実運用の
      // ケース（selectNewHits のコメント参照）は数個程度で収まるため、
      // 実用上困らない範囲で十分大きく、かつ zxing-wasm の既定値(255)より
      // 小さく絞ってある。
      maxNumberOfSymbols: 16,
    })

    const hits: BarcodeHit[] = results
      .filter((r) => r.isValid && r.text.length > 0)
      .map((r) => ({
        value: r.text,
        format: REVERSE_FORMAT_MAP.get(r.format) ?? r.format,
        box: boxFromPosition(r.position, imageData.width, imageData.height),
      }))

    post({ type: 'result', id, hits })
  } catch (err) {
    post({ type: 'result', id, hits: [], error: err instanceof Error ? err.message : String(err) })
  } finally {
    bitmap.close()
  }
}
