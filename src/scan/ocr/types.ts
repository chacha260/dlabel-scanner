// OCR（文字認識）関連の型定義。
//
// 以前はここに、tesseract.js 固有の設定（PSM）・複数エンジンの切り替え
// （OcrEngineId）・文字ごとの信頼度（OcrSymbol / OcrResult.symbols）を持っていた。
// 実機比較で tesseract.js より ML Kit が圧倒的に高精度と分かり、tesseract.js を
// 完全に削除してエンジンを ML Kit 1本にしたため、これらは全て不要になった:
// ML Kit は PSM という概念自体を持たず、文字（グリフ）単位の情報も一切返さない
// （TextElement は単語相当の粒度までで、その内訳の文字ごとの信頼度は存在しない）。
// 型として残しても実体が伴わない（常に空・常に無視される）だけなので削除した。
/**
 * どのOCRエンジンで認識するか。
 *
 * - 'mlkit'  : Google ML Kit Text Recognition v2（端末内蔵モデル）。**既定**。
 *   Androidネイティブで動きハードウェアアクセラレーションが効くため速い。
 *   実機比較で tesseract.js を圧倒したエンジンで、通常はこれで足りる。
 *   Capacitor のネイティブプラグイン経由なので **APK でしか動かない**。
 * - 'paddle' : PaddleOCR（PP-OCRv5 mobile）を onnxruntime-web で動かすもの。
 *   **「ML Kit で読めなかったときの手段」という位置づけ**。WASM の単一スレッド
 *   実行なので ML Kit より明確に遅い（数百ms〜数秒）代わりに、別系統のモデルなので
 *   ML Kit が苦手な画像を読めることがある。ブラウザでも動く（＝Web版でも使える）。
 *
 * 2つを併存させているのは「速いほうを既定にし、駄目なときだけ重いほうを試す」
 * という使い分けのため。エンジンを1つに絞ると、読めなかったときの打ち手が
 * 「撮り直す」しか無くなってしまう。
 */
export type OcrEngineId = 'mlkit' | 'paddle'

export const DEFAULT_OCR_ENGINE: OcrEngineId = 'mlkit'

export type OcrResult = {
  text: string
  // 全体の信頼度（0..100）。
  // 注意: **エンジンによって意味が違う**。
  //  - 'mlkit'  : ML Kit は信頼度を一切返さないため常に 0 が入る。これは
  //    「信頼度ゼロ（＝まったく信用できない）」ではなく「信頼度という情報が無い」
  //    という意味であり、UI 側で 0 をそのまま「信頼度 0%」と表示してはいけない。
  //  - 'paddle' : CTC の各タイムステップの確率から算出した本物の値が入る。
  // つまり「confidence が 0 かどうか」ではなく「どのエンジンで認識したか」を見て
  // 表示の可否を決めること（UI 側は OcrResult と一緒にエンジンを保持している）。
  confidence: number
  ms: number // 認識にかかった時間（ミリ秒）
}

export type RoiRect = {
  x: number // 0..1 の相対値
  y: number
  w: number
  h: number
}
