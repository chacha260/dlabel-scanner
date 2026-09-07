// PaddleOCR（PP-OCRv5 mobile、onnxruntime-webで動作）による OCR。
//
// 位置づけ: 「高精度・低速のフォールバック」。既定のエンジンはML Kit
// （src/scan/ocr/mlkit.ts）のままで、現場で「読めないときの手段が欲しい」
// という要望に応えるための2つ目のエンジンとして追加する。ML Kitと違い
// Capacitorのネイティブプラグインではなく、onnxruntime-web（WASM）で
// 完全にブラウザ内で動くため、Web版（GitHub Pages）でも動作する。
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

export { disposePaddle, isPaddleReady, preparePaddle } from './session'

/**
 * 前処理していない素のImageDataを認識する。失敗時は例外を投げる
 * （呼び出し側がcatchして日本語メッセージを出す想定。mlkit.tsのrecognizeWithMlKit
 * と同じ方針）。
 *
 * 処理の流れ: 検出（画像全体から文字がありそうな矩形を複数見つける）→
 * 各矩形を元画像から切り出して認識（文字列＋信頼度）→ 読み順（検出側で
 * 上から下・左から右にソート済み）のまま改行で連結する。
 *
 * confidenceはML Kit（常に0＝情報なし）と異なり、CTCの実際の確率から
 * 計算した本物の値（0..100）が入る。この違いは types.ts のOcrResult側の
 * コメントにあるとおり、UI側で「エンジンによって意味が違う」点に注意が必要。
 *
 * 検出で矩形が1つも見つからなかった場合は、空文字・confidence 0 を返す
 * （このとき返るconfidence=0は「1文字も認識しなかった」ことの反映であり、
 * ML Kitのconfidence=0（＝情報が無いことを表す特殊な意味）とは意味が異なる
 * 点に注意）。
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
