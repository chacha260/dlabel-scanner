// PaddleOCR（PP-OCRv5 mobile、onnxruntime-webで動作）による OCR。
// このアプリで唯一のOCRエンジン（tesseract.js → ML Kit → PaddleOCR と実機比較を
// 重ねた末の到達点。README「OCR まわりの修正履歴」参照）。Capacitorのネイティブ
// プラグインではなく onnxruntime-web（WASM）で完全にブラウザ内で動くため、
// Web版（GitHub Pages）・APK版のどちらでも同じように動作する。
//
// このファイルは公開APIの薄い窓口に過ぎない。実際の処理は:
//   - session.ts   : onnxruntime-webのセッション管理（wasmPaths・numThreadsの設定含む）
//   - detect.ts    : 検出（DBNet）フェーズのグルー
//   - recognize.ts : 認識（CTC）フェーズのグルー
//   - boxes.ts / geometry.ts / ctc.ts / tensorize.ts / dict.ts
//                  : canvas/ONNXに依存しない純粋関数（Vitestでテスト済み）
// に分かれている。
import type { OcrResult } from '../types'
import { detectTextBoxes } from './detect'
import { recognizeBox } from './recognize'

export { isPaddleReady, preparePaddle } from './session'

/**
 * 前処理していない素のImageDataを認識する。失敗時は例外を投げる
 * （呼び出し側がcatchして日本語メッセージを出す想定）。
 *
 * 処理の流れ: 検出（画像全体から文字がありそうな矩形を複数見つける）→
 * 各矩形を元画像から切り出して認識（文字列＋信頼度）→ 読み順（検出側で
 * 上から下・左から右にソート済み）のまま改行で連結する。
 *
 * confidenceはCTCの実際の確率から計算した本物の値（0..100）が入る
 * （types.ts のOcrResult側のコメント参照）。
 *
 * 検出で矩形が1つも見つからなかった場合は、空文字・confidence 0 を返す
 * （「1文字も認識しなかった」ことの反映であり、confidence自体が本物の値である
 * 点は変わらない）。
 */
export async function recognizeWithPaddle(image: ImageData): Promise<OcrResult> {
  const startedAt = performance.now()

  const boxes = await detectTextBoxes(image)
  if (boxes.length === 0) {
    return { text: '', confidence: 0, ms: Math.round(performance.now() - startedAt) }
  }

  const lines: string[] = []
  let confidenceSum = 0
  for (const box of boxes) {
    const result = await recognizeBox(image, box)
    lines.push(result.text)
    confidenceSum += result.confidence
  }

  return {
    text: lines.join('\n'),
    confidence: confidenceSum / boxes.length,
    ms: Math.round(performance.now() - startedAt),
  }
}
