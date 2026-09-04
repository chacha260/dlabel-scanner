// OCR（文字認識）関連の型定義。
//
// 以前はここに、tesseract.js 固有の設定（PSM）・複数エンジンの切り替え
// （OcrEngineId）・文字ごとの信頼度（OcrSymbol / OcrResult.symbols）を持っていた。
// 実機比較で tesseract.js より ML Kit が圧倒的に高精度と分かり、tesseract.js を
// 完全に削除してエンジンを ML Kit 1本にしたため、これらは全て不要になった:
// ML Kit は PSM という概念自体を持たず、文字（グリフ）単位の情報も一切返さない
// （TextElement は単語相当の粒度までで、その内訳の文字ごとの信頼度は存在しない）。
// 型として残しても実体が伴わない（常に空・常に無視される）だけなので削除した。
export type OcrResult = {
  text: string
  // 全体の信頼度（0..100）。
  // 注意: ML Kit は信頼度を一切返さないため、この値は常に 0 が入る。
  // これは「信頼度ゼロ（＝まったく信用できない）」ではなく「**信頼度という情報が無い**」
  // という意味なので、UI 側で 0 をそのまま「信頼度 0%」と表示してはいけない。
  confidence: number
  ms: number // 認識にかかった時間（ミリ秒）
}

export type RoiRect = {
  x: number // 0..1 の相対値
  y: number
  w: number
  h: number
}
