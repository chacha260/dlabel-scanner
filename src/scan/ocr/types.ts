// OCR（文字認識）関連の型定義。tesseract.js のパラメータをそのまま公開せず、
// このアプリで使う最小限の形に絞る。

export type OcrOptions = {
  whitelist: string // 認識対象文字（ホワイトリスト）
  psm: '7' | '8' | '6' // 7=単一行 / 8=単一語 / 6=ブロック
}

export type OcrResult = {
  text: string
  confidence: number
  ms: number // 認識にかかった時間（ミリ秒）
}

export const DEFAULT_OCR_OPTIONS: OcrOptions = {
  whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-./',
  psm: '7',
}

export type RoiRect = {
  x: number // 0..1 の相対値
  y: number
  w: number
  h: number
}
