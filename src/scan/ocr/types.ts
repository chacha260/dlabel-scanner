// OCR（文字認識）関連の型定義。
//
// 以前はここに、tesseract.js 固有の設定（PSM）・複数エンジンの切り替え
// （OcrEngineId）・文字ごとの信頼度（OcrSymbol / OcrResult.symbols）を持っていた。
// tesseract.js → ML Kit → PaddleOCR と実機比較を重ねた結果、最終的に PaddleOCR
// 一本に絞ったため（README「OCR まわりの修正履歴」参照）、エンジンを選ぶための
// OcrEngineId 自体が不要になり削除した。
export type OcrResult = {
  text: string
  // 全体の信頼度（0..100）。PaddleOCR が CTC の各タイムステップの確率から
  // 算出した本物の値が入る。
  confidence: number
  ms: number // 認識にかかった時間（ミリ秒）
}

export type RoiRect = {
  x: number // 0..1 の相対値
  y: number
  w: number
  h: number
}
