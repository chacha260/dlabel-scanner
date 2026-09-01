// OCR結果に対する JS側の後処理フィルタ。エンジン側を文字種で制約する
// （文字ホワイトリストパラメータ）代わりに、既に認識済みのテキストをここで絞り込む。
// フィルタの切り替えは再認識を必要とせず、常に一瞬で反映される。
// DOM にも React にも依存しない純粋関数のみで構成する。

export type OcrFilterMode = 'raw' | 'digits' | 'alnum'

export const OCR_FILTER_LABELS: Record<OcrFilterMode, string> = {
  raw: 'フィルタなし（そのまま）',
  digits: '数字のみ抽出',
  alnum: '英数字のみ抽出',
}

/** 数字（0-9）以外をすべて取り除く */
export function filterDigitsOnly(text: string): string {
  return text.replace(/[^0-9]/g, '')
}

/** 英数字（0-9A-Za-z）と区切りに使われがちな記号（-./）以外をすべて取り除く */
export function filterAlnumOnly(text: string): string {
  return text.replace(/[^0-9A-Za-z\-./]/g, '')
}

/** 指定したモードでテキストをフィルタする（'raw' はそのまま返す） */
export function applyOcrFilter(text: string, mode: OcrFilterMode): string {
  if (mode === 'digits') return filterDigitsOnly(text)
  if (mode === 'alnum') return filterAlnumOnly(text)
  return text
}
