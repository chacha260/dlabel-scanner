// OCR（文字認識）関連の型定義。tesseract.js のパラメータをそのまま公開せず、
// このアプリで使う最小限の形に絞る。
//
// 注意: 以前はここに文字ホワイトリスト（tesseract.js の文字種制約パラメータ）を
// 持っていたが、LSTM エンジン（OEM 1、本アプリの既定）ではこのパラメータの指定が
// 不安定で、文字がまるごと脱落する既知の原因になるため廃止した。
// エンジンには自由に認識させ、結果の絞り込みは postprocess.ts の
// JS側フィルタ（ユーザーが結果カード上でトグル）で行う。

/**
 * どのOCRエンジンで認識するか。
 *
 * - 'tesseract': tesseract.js（LSTM）。Web Worker の中で動く。ブラウザでも APK でも動く
 *   唯一のエンジンで、`pnpm dev` でローカル検証できるのはこちらだけ。
 * - 'mlkit'    : Google ML Kit Text Recognition v2（端末内蔵モデル、bundled）。
 *   Capacitor のネイティブプラグイン経由なので **APK でしか動かない**（ブラウザでは
 *   isMlKitAvailable() が false になり、選択できない）。
 *
 * 2つのエンジンを併存させているのは、どちらが現場のラベルで実際に読めるかを
 * まだ測れていないため。現品票の実画像もゴールデンデータも手元に無い状態で
 * 推論だけでエンジンを入れ替えると、良くなったのか悪くなったのか誰にも分からない。
 * 比較モード（src/ui/OcrCompareSheet.tsx）で同じ静止画に両エンジンをかけ、
 * 実物で決着してから負けたほうを消す方針。
 */
export type OcrEngineId = 'tesseract' | 'mlkit'

export type OcrOptions = {
  // PSM は tesseract.js 固有の設定で、ML Kit では意味を持たない（無視される）。
  psm: '7' | '8' | '6' // 7=単一行 / 8=単一語 / 6=ブロック
  /** 省略時は 'tesseract'（従来からの唯一の挙動） */
  engine?: OcrEngineId
}

/**
 * 1文字ぶんの認識結果。tesseract.js の Word.symbols[] から取り出した
 * text / confidence だけを持つ（bbox など画面表示に使わない情報は持ち込まない）。
 * data.blocks が取得できなかった場合（後述）は、この配列自体を空にする。
 */
export type OcrSymbol = { text: string; confidence: number }

export type OcrResult = {
  text: string
  // 全体の信頼度（0..100）。
  // 注意: ML Kit は信頼度を一切返さないため、'mlkit' エンジンでは常に 0 が入る。
  // これは「信頼度ゼロ（＝まったく信用できない）」ではなく「**信頼度という情報が無い**」
  // という意味なので、UI 側で 0 をそのまま「信頼度 0%」と表示してはいけない。
  confidence: number
  ms: number // 認識にかかった時間（ミリ秒）
  // 文字ごとの信頼度。「I と 1」のような1文字単位の混同を後段（postprocess.ts）で
  // 検出・可視化できるようにするために追加した。ただし worker.recognize() に
  // { blocks: true } を渡してもエンジンや実行環境の状態によっては
  // data.blocks が null で返ってくることがあり（tesseract.js 側の既知の挙動）、
  // その場合にワーカーが例外を投げて OCR 自体を失敗させるのは本末転倒なので、
  // 取得できなかったときは空配列にする。呼び出し側（UI）は空配列でも
  // 問題なく動作すること（＝symbols は「あれば使う」補助情報という位置づけ）。
  symbols: OcrSymbol[]
}

export const DEFAULT_OCR_OPTIONS: OcrOptions = {
  psm: '7',
}

export type RoiRect = {
  x: number // 0..1 の相対値
  y: number
  w: number
  h: number
}
