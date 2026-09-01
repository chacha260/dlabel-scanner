// OCR（文字認識）関連の型定義。tesseract.js のパラメータをそのまま公開せず、
// このアプリで使う最小限の形に絞る。
//
// 注意: 以前はここに文字ホワイトリスト（tesseract.js の文字種制約パラメータ）を
// 持っていたが、LSTM エンジン（OEM 1、本アプリの既定）ではこのパラメータの指定が
// 不安定で、文字がまるごと脱落する既知の原因になるため廃止した。
// エンジンには自由に認識させ、結果の絞り込みは postprocess.ts の
// JS側フィルタ（ユーザーが結果カード上でトグル）で行う。

export type OcrOptions = {
  psm: '7' | '8' | '6' // 7=単一行 / 8=単一語 / 6=ブロック
}

export type OcrResult = {
  text: string
  confidence: number
  ms: number // 認識にかかった時間（ミリ秒）
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
