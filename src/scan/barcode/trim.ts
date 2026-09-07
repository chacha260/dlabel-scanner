// 読み取り値の「整形（トリミング）」ルール（純粋関数のみ、DOM にも React にも依存しない）。
//
// 現在はバーコードと OCR の両方で共有している（src/ui/SimpleScanScreen.tsx 参照）。
// もともとはバーコード専用に作った機能で、ファイルの場所・名前（barcode/trim.ts）は
// その名残だが、「整形ルールは1つに集約する（設定を2箇所に増やして現場を混乱させない）」
// という方針のもとOCRの結果にも同じルールを適用できるようにした。参照箇所が多く
// ファイル移動はチャーンに見合わないため、置き場所はそのままにしてある。
//
// 背景: GS1-128 バーコードは AI（アプリケーション識別子）付きの複数フィールドを
// 1本の値に連結して持つことが多く、現場が実際に使いたいのは特定の1フィールドだけ、
// ということがよくある。またゼブラ等のラベルでは、印字システムが独自の接頭辞・接尾辞
// （店舗コードや端末IDなど）を付けて出力してくることもある。この2つの事情に対応するため、
// 「前方一致 / 後方一致で決まった文字列を削る」だけでなく「区切り文字が現れた位置で
// 前後どちらかを丸ごと捨てる」という、より柔軟な指定もできるようにしてある
// （ユーザー要望: 「スペース以下などできるだけ柔軟に」）。
//
// cutFromLast / cutUpToLast について: 現場から「`*abcdefg*` のように前置も後置も
// 同じ文字列で囲われている場合、同じ文字だと正確に整形できない」という報告があった。
// 原因は cutFrom/cutUpTo がどちらも「最初に現れた位置」（indexOf）しか探していなかった
// ため。cutUpTo は最初の `*` で・cutFrom も最初の `*`（＝cutUpTo と同じ位置）で
// 探してしまい、cutFrom 単独では先頭の `*` で全部切れて結果が空になる、
// 中身に同じ区切り文字が含まれると内側で切れる、といった不具合になっていた。
// これを解決するため、cutUpTo は「最初に現れた位置」のまま・cutFrom を「最後に
// 現れた位置」に切り替えられるようにした（囲む文字列を1文字ずつ両側から剥がす形）。
// 探索方向を両方に用意してあるのは、cutUpTo 側を最後にしたいケース
// （例: 区切り文字が3つ以上あり、最後の区切りより後ろだけ残したい）もあり得るため。
//
// 制御文字について（重要）: GS1-128 の可変長フィールドの区切りには FNC1 が使われるが、
// バーコードデコーダはこれを GS（Group Separator, 0x1D）としてデコード結果の文字列に
// そのまま含めて返す。この文字は目に見えないため、クリップボードにコピーした値に
// 紛れ込んでいても気づきにくい。そのため cutFrom/cutUpTo/prefix/suffix の各欄に
// 制御文字を「入力できる」ようにエスケープ表記（\t \n \x1D \GS）を用意し（後半の
// unescapeRuleText/escapeRuleText）、一覧・プレビューでは実際の文字はそのままに
// 表示だけ visualizeControlChars で可視化する。

export type TrimRules = {
  enabled: boolean
  /** 前方一致で取り除く接頭辞（複数指定可）。長い文字列から順に判定し、一致した最初の1つだけを1回取り除く */
  stripPrefixes: string[]
  /** 後方一致で取り除く接尾辞（複数指定可）。stripPrefixes と同様、長い順・1回だけ */
  stripSuffixes: string[]
  /** この文字列が現れた位置以降をすべて捨てる（空文字なら無効）。位置は cutFromLast で切り替える */
  cutFrom: string
  /**
   * cutFrom の探索位置を「最初に現れた位置」ではなく「最後に現れた位置」にするか。
   * 既定は false（従来どおり最初）。前置・後置を同じ文字列で囲うケース（例: `*abc*`）で
   * cutUpTo と組み合わせて使うことを想定している（詳しくはファイル冒頭のコメント参照）。
   */
  cutFromLast: boolean
  /** この文字列が現れた位置までを捨てる（それより後ろを残す。空文字なら無効）。位置は cutUpToLast で切り替える */
  cutUpTo: string
  /**
   * cutUpTo の探索位置を「最初に現れた位置」ではなく「最後に現れた位置」にするか。
   * 既定は false（従来どおり最初）。
   */
  cutUpToLast: boolean
  /** 最後に前後の空白を除去する */
  trimWhitespace: boolean
}

export const DEFAULT_TRIM_RULES: TrimRules = {
  enabled: false,
  stripPrefixes: [],
  stripSuffixes: [],
  cutFrom: '',
  cutFromLast: false,
  cutUpTo: '',
  cutUpToLast: false,
  trimWhitespace: false,
}

/** 「GS(0x1D)以降を削除」プリセットボタンが cutFrom にセットする値 */
export const GS_CUT_FROM = '\x1D'

function sortLongestFirst(items: string[]): string[] {
  // items が想定外の値（配列でない等）でも呼び出し元の try/catch で拾えるよう、
  // ここでは特別な防御はせず素直に処理する。
  return [...items].filter((s) => s.length > 0).sort((a, b) => b.length - a.length)
}

// [start, end) という半開区間で value 中の「残す範囲」を表す。
// cutUpTo/cutFrom/prefix/suffix/whitespace のどの手順も、この範囲を前後どちらかから
// 狭めるだけ（＝範囲の途中を削ることはない）という性質を利用して、
// 最終的な「残す文字列」が常に元の文字列の連続した部分文字列になるようにしている
// （整形パネルのプレビューで、削られた前後を色分け表示できるのはこの性質のおかげ）。
type TrimRange = { start: number; end: number }

/**
 * ルールの適用順序（固定・ドキュメント化された順序。ここが挙動の唯一の正）:
 *   1. cutUpTo       … 指定文字列が現れた位置までを捨てる（それより後ろを残す）。
 *                       cutUpToLast が true なら「最後に現れた位置」、false（既定）なら
 *                       「最初に現れた位置」を使う
 *   2. cutFrom       … 指定文字列が現れた位置以降を全て捨てる。
 *                       cutFromLast が true なら「最後に現れた位置」、false（既定）なら
 *                       「最初に現れた位置」を使う。ただし「最後」で探す場合も、
 *                       手順1で cutUpTo が切り落とした前半部分に現れた位置は拾わない
 *                       （start 以降で見つかった位置に限る）
 *   3. stripPrefixes … 長い文字列から順に判定し、一致した最初の1つだけを1回取り除く
 *                       （繰り返し剥がすことはしない。例: ['A'] を "AAB" に適用すると "AB"）
 *   4. stripSuffixes … stripPrefixes と同様、長い順に判定して1回だけ
 *   5. trimWhitespace … 最後に前後の空白を除去する
 */
function computeTrimRange(value: string, rules: TrimRules): TrimRange {
  let start = 0
  let end = value.length

  if (rules.cutUpTo) {
    // 「最後に現れた位置」を探す場合も lastIndexOf に fromIndex を渡す方法では
    // 「start 以降」を表現できない（lastIndexOf の第2引数は探索の上限であって下限では
    // ない）ため、全体から探したうえで idx >= start かどうかを別途チェックする。
    // なお cutUpTo はこの時点でまだ start=0 のため、実質は文字列全体が対象になる。
    const idx = rules.cutUpToLast ? value.lastIndexOf(rules.cutUpTo) : value.indexOf(rules.cutUpTo, start)
    if (idx !== -1 && idx >= start && idx < end) start = idx + rules.cutUpTo.length
  }
  if (rules.cutFrom) {
    // cutFrom を「最後に現れた位置」で探すときも、cutUpTo で切り落とした前半部分
    // （start より前）に現れた区切り文字を誤って拾わないよう、idx >= start を必須にする。
    // これが無いと `*ab*cd*` で cutUpTo=*(最初) の後に cutFrom=*(最後) を「文字列全体の
    // 最後の *」として素直に使えばよいだけに見えるが、cutUpTo 側を「最後」にした
    // 別ケース（start が後ろにずれている場合）では、start より前の * を拾ってしまい
    // end < start になる壊れた範囲を作りかねないため、常にこのチェックを入れておく。
    const idx = rules.cutFromLast ? value.lastIndexOf(rules.cutFrom) : value.indexOf(rules.cutFrom, start)
    if (idx !== -1 && idx >= start && idx < end) end = idx
  }
  // cutUpTo と cutFrom の指定が交差してしまった場合の保険（範囲が負にならないようにする）
  if (start > end) start = end

  for (const prefix of sortLongestFirst(rules.stripPrefixes)) {
    if (prefix.length <= end - start && value.startsWith(prefix, start)) {
      start += prefix.length
      break
    }
  }

  for (const suffix of sortLongestFirst(rules.stripSuffixes)) {
    if (suffix.length <= end - start && value.slice(start, end).endsWith(suffix)) {
      end -= suffix.length
      break
    }
  }

  if (rules.trimWhitespace) {
    const sub = value.slice(start, end)
    start += sub.length - sub.trimStart().length
    end -= sub.length - sub.trimEnd().length
  }

  return { start, end }
}

/**
 * バーコード値からルールに従って不要な部分を取り除く。
 * enabled が false のときは常に value をそのまま返す。
 *
 * ルール適用の結果が空文字になってしまう場合は、読み取り自体を無駄にしないよう
 * 元の値をそのまま返す（一部だけ適用された中途半端な値を返すことは絶対にしない）。
 * ルールの形が壊れている等、想定していない例外が起きた場合も同様に元の値へ
 * フォールバックし、呼び出し側へ例外を伝播させることはない。
 */
export function applyTrimRules(value: string, rules: TrimRules): string {
  if (!rules || !rules.enabled) return value
  try {
    const { start, end } = computeTrimRange(value, rules)
    const result = value.slice(start, end)
    return result === '' ? value : result
  } catch {
    return value
  }
}

export type TrimPreview = {
  /** 削られる前半部分（表示専用。元の値からの抜粋） */
  removedFront: string
  /** 実際に残る部分（適用結果が空になった場合は元の値そのもの） */
  kept: string
  /** 削られる後半部分（表示専用。元の値からの抜粋） */
  removedBack: string
  /** ルール適用結果が空文字になり、元の値へフォールバックしたか */
  fellBackToOriginal: boolean
}

/**
 * 整形パネルのプレビュー用に、削られた部分・残る部分を分けて返す。
 * applyTrimRules と同じ規則（同じ computeTrimRange）を使うため、
 * ここで見せているプレビューは実際の適用結果と必ず一致する。
 */
export function previewTrimRules(value: string, rules: TrimRules): TrimPreview {
  if (!rules || !rules.enabled) {
    return { removedFront: '', kept: value, removedBack: '', fellBackToOriginal: false }
  }
  try {
    const { start, end } = computeTrimRange(value, rules)
    const kept = value.slice(start, end)
    if (kept === '') {
      return { removedFront: '', kept: value, removedBack: '', fellBackToOriginal: true }
    }
    return { removedFront: value.slice(0, start), kept, removedBack: value.slice(end), fellBackToOriginal: false }
  } catch {
    return { removedFront: '', kept: value, removedBack: '', fellBackToOriginal: false }
  }
}

// ルール入力欄向けのエスケープ表記。\\ → \、\t → タブ、\n → 改行、
// \x1D / \GS（大文字小文字は問わない）→ GS(0x1D) に変換する。
// 該当しないバックスラッシュ表記（例: \a）はそのまま残す。
const ESCAPE_SEQUENCE_PATTERN = /\\\\|\\t|\\n|\\x1d|\\gs/gi

/** ユーザーがルール入力欄に書いたエスケープ表記を実際の文字に変換する（適用直前に呼ぶ） */
export function unescapeRuleText(input: string): string {
  try {
    return input.replace(ESCAPE_SEQUENCE_PATTERN, (matched) => {
      const lower = matched.toLowerCase()
      if (lower === '\\\\') return '\\'
      if (lower === '\\t') return '\t'
      if (lower === '\\n') return '\n'
      // \x1d / \gs はどちらも GS (0x1D) 扱い
      return '\x1D'
    })
  } catch {
    return input
  }
}

/** unescapeRuleText の逆変換。保存済みルール（実文字）を入力欄に再表示するときに使う */
export function escapeRuleText(input: string): string {
  try {
    let out = ''
    for (const ch of input) {
      if (ch === '\\') out += '\\\\'
      else if (ch === '\t') out += '\\t'
      else if (ch === '\n') out += '\\n'
      else if (ch === '\x1D') out += '\\x1D'
      else out += ch
    }
    return out
  } catch {
    return input
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f]/g

/**
 * 制御文字（C0コントロール、0x00-0x1F）を目に見える記号（Unicode Control Pictures、
 * 例: GS(0x1D) → '␝'）に置き換えた、表示専用の文字列を作る。
 * 保存されている値そのものは一切変更しない（あくまで一覧・プレビューでの見せ方だけ）。
 */
export function visualizeControlChars(value: string): string {
  try {
    return value.replace(CONTROL_CHAR_PATTERN, (ch) => String.fromCodePoint(0x2400 + ch.charCodeAt(0)))
  } catch {
    return value
  }
}
