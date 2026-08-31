// UI 層でだけ使う小さな共有ヘルパー。src/parse・src/store 側のロジックには手を入れず、
// 表示用の変換やクリップボード操作などをここに集約する。

// ScanRecord.values[].source は永続化の都合上 string 型（RawScan['source'] より広い）
// なので、ここでは string を受けて未知の値にもフォールバックできるようにする。

/** 由来（source）の日本語バッジ表示 */
export function sourceBadgeLabel(source: string): string {
  if (source === 'barcode') return 'BC'
  if (source === 'ocr') return 'OCR'
  return '手入力'
}

export function sourceBadgeClass(source: string): string {
  if (source === 'barcode') return 'bg-cyan-400/15 text-cyan-300'
  if (source === 'ocr') return 'bg-amber-400/15 text-amber-300'
  return 'bg-violet-400/15 text-violet-300'
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

/** epoch ms を "HH:mm:ss" に整形する（一覧の時刻表示用） */
export function formatTime(at: number): string {
  const d = new Date(at)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** epoch ms を "YYYY-MM-DD HH:mm:ss" に整形する */
export function formatDateTime(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 区切り文字のプリセット。値が見えない文字も多いため、日本語ラベルと対応させる */
export const DELIMITER_PRESETS: { label: string; value: string }[] = [
  { label: 'スペース', value: ' ' },
  { label: 'タブ', value: '\t' },
  { label: 'カンマ', value: ',' },
  { label: 'GS (0x1D)', value: '\x1d' },
]

/** 区切り文字を人間が読める表記にする（プリセットに一致すればその名前、なければコード表示） */
export function describeDelimiter(value: string): string {
  const preset = DELIMITER_PRESETS.find((p) => p.value === value)
  if (preset) return preset.label
  if (value.length === 0) return '(空)'
  // eslint-disable-next-line no-control-regex
  const isPrintable = /^[\x20-\x7e]+$/.test(value)
  if (isPrintable) return `"${value}"`
  const codes = Array.from(value)
    .map((ch) => `0x${ch.codePointAt(0)?.toString(16).padStart(2, '0')}`)
    .join(' ')
  return codes
}

/** クリップボードへコピーする。Clipboard API が使えない/拒否された端末向けに execCommand フォールバックを持つ */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // フォールバックへ続行
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

/** マッチ方法（Matcher.kind）の日本語表示名 */
export const MATCHER_LABELS: Record<string, string> = {
  prefix: '接頭辞',
  index: '位置（区切り後の何番目か）',
  fixed: '固定長',
  regex: '正規表現',
  rest: '残り全部',
}

/** マッチ方法選択時に表示する一行説明 */
export const MATCHER_EXPLANATIONS: Record<string, string> = {
  prefix:
    '値が指定した接頭辞で始まるバーコード/OCR結果を、この項目として採用します。複数の項目が同時に接頭辞方式の場合、最も長く一致した接頭辞のルールが優先されます（最長一致優先）。',
  index: '「1本を区切って複数項目に分解」モードで、区切った後の何番目のセグメントかで判定します（この画面では1番目から数えます）。',
  fixed: '文字列の先頭から数えた開始位置と長さで切り出します。',
  regex: '正規表現にマッチした部分を採用します。グループ番号を指定すると、そのキャプチャグループの値だけを使います（0 は一致全体）。',
  rest: 'どの項目のルールにも当てはまらなかった候補を、フォールバックとして受け取ります。',
}

/** 変換（TransformStep.kind）の日本語表示名 */
export const TRANSFORM_LABELS: Record<string, string> = {
  trim: '前後の空白を除去',
  upper: '大文字化',
  lower: '小文字化',
  stripLeadingZeros: '先頭の0を除去',
  toNumber: '数値化',
  slice: '部分文字列を切り出す',
  replace: '正規表現で置換',
}
