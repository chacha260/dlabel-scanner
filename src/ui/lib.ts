// UI 層でだけ使う小さな共有ヘルパー。
//
// 以前はここに、退避済み画面（src/ui/legacy/）や削除済みのパース/永続化エンジン
// （src/parse/・src/store/・src/export/）向けの表示ヘルパー（formatTime /
// formatDateTime / DELIMITER_PRESETS / describeDelimiter / MATCHER_LABELS /
// MATCHER_EXPLANATIONS / TRANSFORM_LABELS）も置いていたが、それらの画面・
// エンジンを丸ごと削除したのに合わせて、呼び出し元が無くなったこれらの
// エクスポートも削除した（必要になれば git 履歴から復元できる）。
// 現在残っているのは SimpleScanScreen.tsx が実際に使っているものだけ。

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
