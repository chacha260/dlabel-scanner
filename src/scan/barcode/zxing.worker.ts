// BarcodeDetector 非対応環境（一部の WebView 等）向けのフォールバック用 Web Worker。
// zxing-wasm を使ってバーコードをデコードする。メインバンドルには含まれず、
// ネイティブ実装が使えないときだけ src/scan/barcode/index.ts から生成される。

import { prepareZXingModule, readBarcodes, type ReadInputBarcodeFormat } from 'zxing-wasm/reader'
// wasm 本体はネットワーク不要で自前ホスト（CDN 参照はオフライン要件に反するため使わない）
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { SUPPORTED_FORMATS } from './types'
import type { BarcodeHit } from './types'

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

prepareZXingModule({
  overrides: { locateFile: () => wasmUrl },
})

type DecodeRequest = { type: 'decode'; id: number; bitmap: ImageBitmap }
type DecodeResponse = { type: 'result'; id: number; hits: BarcodeHit[]; error?: string }

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
    const context = getContext(bitmap.width, bitmap.height)
    context.drawImage(bitmap, 0, 0)
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height)

    const results = await readBarcodes(imageData, {
      formats: ZXING_FORMATS,
      tryHarder: false,
    })

    const hits: BarcodeHit[] = results
      .filter((r) => r.isValid && r.text.length > 0)
      .map((r) => ({ value: r.text, format: REVERSE_FORMAT_MAP.get(r.format) ?? r.format }))

    post({ type: 'result', id, hits })
  } catch (err) {
    post({ type: 'result', id, hits: [], error: err instanceof Error ? err.message : String(err) })
  } finally {
    bitmap.close()
  }
}
