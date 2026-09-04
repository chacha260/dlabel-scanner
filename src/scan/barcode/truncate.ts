// バーコード読み取り値を「表示用に」安全な長さへ切り詰めるための純粋関数。
// DOM にも React にも依存しない。
//
// 背景: QR コードは最大で 2,953 バイト（バイナリ）/ 4,296 文字（英数字）もの
// データを持てる。現品票には情報が欠落すると業務上致命的なため、読み取った値
// そのもの（BarcodeHit.value / RawScan.value）は一切切り詰めずに完全な値のまま
// 保持・搬送する（このファイルの関数はスキャン層のどこからも自動では呼ばれない。
// あくまで「表示（一覧のレンダリングなど）だけ」に使うための道具として用意してある）。
//
// 理由: 数KBの連続した1トークンをそのまま <pre className="break-all"> のような
// 要素に描画すると、Chromium のレイアウトエンジンは実測でかなり重くなる。
// 結果一覧はスキャンのたびに全体が再レンダーされるため、この重さは
// 「値の長い読み取り結果が1件増えるたびにフレームが詰まる」という体感の悪化に
// 直結しうる。値そのものを削ってしまうと現品票の情報が失われるため、
// 「保持する値は完全なまま・見せ方だけ安全な長さに削る」という役割分担にし、
// この関数はその「見せ方」側だけを純粋関数として提供する。

export type TruncatedForDisplay = {
  /** 表示に使ってよい文字列（切り詰められていない場合は value と同じ内容） */
  text: string
  /** 実際に切り詰めが行われたか */
  truncated: boolean
  /** 切り詰めによって表示から除かれた文字数（切り詰めていなければ 0） */
  omittedChars: number
}

/**
 * value を最大 maxChars 文字（UTF-16 コードユニット数ではなく Unicode
 * コードポイント数）まで表示用に切り詰める。
 *
 * - value の長さが maxChars 以下なら、value をそのまま返す（truncated: false）。
 * - 超える場合は先頭から maxChars コードポイント分だけを残す。
 *   Array.from によるコードポイント単位の分割を使い、サロゲートペア
 *   （絵文字等）の途中で切って文字化けさせることを避ける。
 * - maxChars が正の有限数でない（0 以下・NaN・Infinity 等）場合は、
 *   誤った指定によって本来不要な切り詰めや例外が起きるより安全側に倒し、
 *   「切り詰めない」を選んで value をそのまま返す。
 *
 * この関数自身は例外を投げない。
 */
export function truncateForDisplay(value: string, maxChars: number): TruncatedForDisplay {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return { text: value, truncated: false, omittedChars: 0 }
  }

  // まず UTF-16 コードユニット長で足切り判定する（大半の値はここで即終わり、
  // Array.from によるコードポイント分割という高コストな処理を避けられる）。
  // コードポイント数はコードユニット数以下なので、コードユニット長が
  // maxChars 以下であればコードポイント数も必ず maxChars 以下になる。
  if (value.length <= maxChars) {
    return { text: value, truncated: false, omittedChars: 0 }
  }

  const codePoints = Array.from(value)
  if (codePoints.length <= maxChars) {
    return { text: value, truncated: false, omittedChars: 0 }
  }

  const text = codePoints.slice(0, maxChars).join('')
  return { text, truncated: true, omittedChars: codePoints.length - maxChars }
}
