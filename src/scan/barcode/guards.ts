// バーコードの「誤読ガード」（純粋関数のみ、DOM にも React にも依存しない）。
//
// 背景（現場からの報告）: 「バーコードが切れているなどの際に、まったく違う値が入ることが
// ままある」。ITF（Interleaved 2 of 5）や Code39 は、バーコードの一部分だけがカメラに写った
// 場合でも「短いが規格上は妥当な別の値」としてデコードが成功してしまう性質を持つ
// （クワイエットゾーンやスタート/ストップキャラクタさえ部分的に揃えば、途中で切れていても
// デコーダは「読めた」と判断してしまう）。この誤読を止める仕組みがこれまで一つも無かった。
//
// なぜ「デコード後の検証層」が本命なのか（重要）:
// このアプリのバーコード読み取りには2つの経路がある。
//   - native.ts（Android のネイティブ BarcodeDetector）＝ APK版で実際に使われる主経路。
//     `formats`（対応させるシンボロジーの一覧）以外の内部挙動は一切設定できない
//     （クワイエットゾーンの厳密さ・チェックディジットの検証有無などはブラウザ実装任せで、
//     こちらからは指定できない）。
//   - zxing.worker.ts（zxing-wasm）＝ BarcodeDetector 非対応環境向けのフォールバック。
//     こちらは validateOptionalChecksum 等のオプションを渡せるが、フォールバックの
//     デコーダに手を入れても、実機（APK版）で実際に動いている主経路には一切効かない。
// つまり両経路に共通して効かせられる唯一の場所は「デコードが終わった後、结果
// （BarcodeHit）を検証する層」しかない。このファイルはその検証層であり、
// useBarcodeScanner.ts のフレームループから、native / zxing どちらの経路の結果に対しても
// 同じ関数を通す。
//
// 採用したガードとその理由:
//   1. チェックディジット（数学的検算）: GTIN の mod-10（EAN-13/EAN-8/UPC-A/UPC-E/
//      ITF-14）と Code39 の mod-43（既定OFF、下記参照）。デコーダが「規格として妥当」と
//      判定しても、チェックディジットまで検算していない結果はまだ信用できない。
//   2. 見切れ（box が解析対象画像の縁に接している）の検出。クワイエットゾーンや
//      スタート/ストップキャラクタの検査はデコーダ内部の責務であり、デコード結果
//      （文字列と座標）からは検査できない。代わりに「検出枠が画像の縁ぎりぎりにある」
//      ことを見切れの代理指標として使う。「バーコードが切れている」という現場報告に
//      直接効く、実装可能な唯一の構造的ガード。
//   3. 桁数の範囲（下限・上限）。部分読みは往々にして「本来より短い値」になるため、
//      下限を設定できるだけでも効果がある。
//   4. 複数回一致（連続 N 回同じ値を検出できて初めて採用）は、このファイルではなく
//      agreement.ts に分離してある（フレームをまたいだ状態＝時間軸を持つ処理のため、
//      このファイルの「1件のヒットを検証するだけの純粋関数」という設計とは性質が違う）。
//
// 採用しなかったもの:
//   - スティッチング（レーザースキャナが長いシンボルを複数回の走査に分けて読む技法）は
//     採用しない。カメラ方式は1フレームでシンボル全体を1枚の画像として撮っており、
//     切れているシンボルは「どのフレームでも同じように切れている」。継ぎ合わせる
//     べき断片（=異なる部分を捉えた複数の走査線）がそもそも存在しないため、
//     このアプリでは意味を持たない。
//   - クワイエットゾーン / スタート・ストップキャラクタの自前検査は採用しない。
//     これらはデコーダ内部（バーの間隔・パターンの解釈）の責務であり、
//     デコード結果（文字列と正規化座標）だけを見るこの検証層からは検査できない。
//
// 2次元シンボル（QR / DataMatrix / PDF417）は対象外:
// これらは規格として強力な誤り訂正符号（Reed-Solomon 等）を内蔵しており、
// デコードが成功した時点で内容が数学的に保証されている（1次元シンボルのように
// 「部分的に読めても規格上妥当な別の値になる」という失敗モードが構造的に存在しない）。
// そのため見切れ・複数回一致・桁数といった1次元向けのガードは一切適用せず、
// 常に即座に採用する（QRコードが枠の縁に触れていても、正しく読めていれば正しい）。

import type { BarcodeHit, NormalizedRect, SupportedFormat } from './types'
import { SUPPORTED_FORMATS } from './types'

// ------------------------------------------------------------------
// 1次元 / 2次元の判定
// ------------------------------------------------------------------

const TWO_DIMENSIONAL_FORMATS: ReadonlySet<string> = new Set(['qr_code', 'data_matrix', 'pdf417'])

/** 2次元シンボル（強力な誤り訂正を内蔵し、デコード成功時点で内容が保証される）かどうか */
export function isTwoDimensionalFormat(format: string): boolean {
  return TWO_DIMENSIONAL_FORMATS.has(format)
}

// ------------------------------------------------------------------
// (1) GTIN の mod-10 チェックディジット検証
// ------------------------------------------------------------------

/**
 * GS1 の mod-10 チェックディジットを検算する純粋関数。
 * 末尾1桁をチェックディジットとみなし、残りの桁から計算した期待値と比較する。
 *
 * アルゴリズムはチェックディジットとの「相対位置」だけで決まり、桁数そのものには
 * 依存しない（右から3,1,3,1…の重みを掛けて合計し、10からの補数を取るだけ）。
 * そのため EAN-13(13桁)・EAN-8(8桁)・UPC-A(12桁)・UPC-E(8桁)・ITF-14(14桁) の
 * どの桁数にも同じ実装をそのまま使い回せる。
 *
 * 数字以外の文字を含む場合や、チェックディジット1桁を除いた残りが無い（1桁以下の）
 * 場合は検証不能として false を返す。
 */
export function verifyGtinCheckDigit(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false
  const payload = digits.slice(0, -1)
  const checkDigit = Number(digits[digits.length - 1])
  let sum = 0
  for (let i = 0; i < payload.length; i++) {
    const digit = Number(payload[payload.length - 1 - i])
    // 右（チェックディジットに近い側）から交互に重み3, 1を掛ける
    const weight = i % 2 === 0 ? 3 : 1
    sum += digit * weight
  }
  const expected = (10 - (sum % 10)) % 10
  return expected === checkDigit
}

// フォーマットごとに「チェックディジット検証を適用してよい桁数」を定める。
// ここに定義した桁数と実際の値の長さが一致したときだけ検証し、それ以外は
// 「検証対象外（=素通し）」として扱う。誤って本来チェックディジットを持たない
// 運用まで弾いてしまわないための限定である。
//
// 特に ITF について: ITF は本来 6桁〜16桁程度まで幅広い運用がある可変長シンボロジーで、
// チェックディジットの有無は運用依存（規格自体に必須の規定は無い）。唯一の例外が
// ITF-14（GTIN-14、物流の集合包装コードとして広く使われる14桁の運用）で、これは
// GS1 の規格上必ず mod-10 チェックディジットを持つ。部分読みが最も起きやすい
// シンボロジーでありながら、ネイティブ経路も zxing の既定もチェックディジットを
// 検証していないため、この14桁のケースだけは検証する価値が高い。
// 14桁以外（ITF-6, ITF-16 等）まで検証対象にしてしまうと、チェックディジットを
// 持たない正当な運用の値を誤って全て拒否することになるため、「14桁のときだけ」
// という限定を必ず守る。
const GTIN_CHECK_LENGTH_BY_FORMAT: Readonly<Partial<Record<SupportedFormat, number>>> = {
  ean_13: 13,
  ean_8: 8,
  upc_a: 12,
  // UPC-E は6桁の圧縮形式（チェックディジットを含まない）で返す実装もあれば、
  // 8桁（先頭の数値システム桁 + 圧縮6桁 + チェックディジット）で返す実装もある。
  // チェックディジットを含まない6桁の形式は検証しようがないため対象外とし、
  // 8桁で返ってきたときだけ検証する。
  upc_e: 8,
  itf: 14,
}

/** そのフォーマット・桁数の組み合わせに GTIN チェックディジット検証を適用してよいか */
export function isGtinCheckApplicable(format: string, length: number): boolean {
  const expected = GTIN_CHECK_LENGTH_BY_FORMAT[format as SupportedFormat]
  return expected !== undefined && expected === length
}

// ------------------------------------------------------------------
// (1) Code39 の mod-43 チェックディジット検証（既定OFF）
// ------------------------------------------------------------------

// Code39 が表現できる43文字（0-9, A-Z, "-. $/+%"）。mod-43 はこの文字集合における
// インデックスの合計を43で割った余りを使う。
const CODE39_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%'

/**
 * Code39 の mod-43 チェックディジットを検算する。末尾1文字をチェック文字とみなす。
 *
 * Code39 のチェックディジットは規格上「任意」であり、実際の現場運用では付けていない
 * ケースの方が多い（このアプリの既定でこのチェックを OFF にしているのはそのため。
 * evaluateBarcodeHit / DEFAULT_BARCODE_GUARD_RULES 参照）。付けている運用のためだけに
 * 検証関数自体は用意しておく。
 *
 * Code39 の文字集合に無い文字を含む場合（検証しようがない場合）は false を返す。
 */
export function verifyCode39CheckDigit(value: string): boolean {
  if (value.length < 2) return false
  const payload = value.slice(0, -1)
  const checkChar = value[value.length - 1]
  let sum = 0
  for (const ch of payload) {
    const idx = CODE39_CHARSET.indexOf(ch)
    if (idx === -1) return false
    sum += idx
  }
  const expectedChar = CODE39_CHARSET[sum % 43]
  return expectedChar === checkChar
}

// Code128 について: mod-103 のチェックディジットがシンボロジー自体に内蔵されており、
// どのデコーダ（ネイティブ・zxing とも）も必ず検証済みでなければデコード自体が
// 成功しない。したがってこのファイルには Code128 用の検証関数を用意しない
// （検証すべきものが無い＝何もしないことが正しい）。

// ------------------------------------------------------------------
// (2) 見切れ（構造的ガード）
// ------------------------------------------------------------------

/**
 * 検出枠が解析対象画像の縁に接しているか（=見切れているとみなすか）を判定する。
 * edgeMarginRatio は各辺からの余裕を画像サイズに対する割合で指定する（既定1%）。
 *
 * box は「実際に解析した入力」に対する 0..1 の正規化座標（types.ts のコメント参照）。
 * 「枠内のみ」ONで検出をクロップ画像に対して行った場合、box はそのクロップ自身が
 * 基準になるため、「枠から見切れている」ことがそのまま「検出そのものが縁に接している」
 * ことと一致する。これは意図した挙動（枠の外にはみ出た部分がある＝そのバーコードは
 * 本来ならもっと大きく写っていたはず、という判断材料になる）だが、利用者には
 * なぜ棄却されたか分かる必要があるため、呼び出し側で reason を使って通知すること。
 */
export function isBoxTruncated(box: NormalizedRect, edgeMarginRatio: number): boolean {
  const margin = edgeMarginRatio
  return box.x <= margin || box.y <= margin || box.x + box.w >= 1 - margin || box.y + box.h >= 1 - margin
}

// ------------------------------------------------------------------
// ルールと既定値
// ------------------------------------------------------------------

export type BarcodeGuardRules = {
  /**
   * 許可するシンボロジーの一覧。ここに無いフォーマットのヒットは棄却する。
   * 既定は SUPPORTED_FORMATS のすべて（現場のラベルが何を使っているか未確定なため、
   * 既定では絞り込まない）。
   *
   * 実装方針の理由: デコーダ側の `formats` オプションを絞る方式ではなく、
   * 「デコード後に許可リストで弾く」方式を採用している。native.ts と zxing.worker.ts
   * それぞれで別々に formats を絞ると実装が2箇所に分かれ、フォーマット文字列の
   * 変換表（zxing.worker.ts の FORMAT_MAP）とも絡んで管理が煩雑になる。
   * デコード後に共通の許可リストで弾けば、両経路で同じ挙動になり実装は1箇所で済む。
   */
  enabledFormats: SupportedFormat[]
  /** GTIN の mod-10 チェックディジットを検証するか（EAN-13/EAN-8/UPC-A/UPC-E/ITF-14。既定ON） */
  verifyGtinChecksum: boolean
  /**
   * Code39 の mod-43 チェックディジットを検証するか（既定OFF）。
   * Code39 のチェックディジットは規格上任意で、付けていない運用の方が多いため、
   * 既定でONにすると「チェックディジットを付けていないだけの正当な値」まで
   * 大量に誤って弾いてしまう。付けている運用の現場だけが明示的にONにする設定。
   */
  verifyCode39Checksum: boolean
  /** 検出枠が画像の縁に接している（見切れている）ヒットを棄却するか（既定ON） */
  rejectTruncatedBox: boolean
  /** 見切れ判定で各辺から確保する余裕（画像サイズに対する割合）。既定 0.01（1%） */
  edgeMarginRatio: number
  /** 受け入れる値の最小文字数（0 = 無制限。既定0=OFF） */
  minLength: number
  /** 受け入れる値の最大文字数（0 = 無制限。既定0=OFF） */
  maxLength: number
  /**
   * 同じ値を連続何回デコードできて初めて採用するか（既定2、1で実質無効化）。
   * このファイルの evaluateBarcodeHit 自体は1件のヒットしか見ないため使わないが、
   * 呼び出し側（agreement.ts・useBarcodeScanner.ts）が参照する値としてここに定義を
   * 集約しておく（ガードに関する設定を1箇所にまとめ、UIパネルも1つの型を編集するだけで
   * 済むようにするため）。
   */
  requiredAgreementCount: number
}

export const DEFAULT_BARCODE_GUARD_RULES: BarcodeGuardRules = {
  enabledFormats: [...SUPPORTED_FORMATS],
  verifyGtinChecksum: true,
  verifyCode39Checksum: false,
  rejectTruncatedBox: true,
  edgeMarginRatio: 0.01,
  minLength: 0,
  maxLength: 0,
  requiredAgreementCount: 2,
}

// ------------------------------------------------------------------
// ヒット1件の検証
// ------------------------------------------------------------------

export type BarcodeGuardReason =
  | { type: 'formatDisabled'; format: string }
  | { type: 'checkDigitMismatch'; check: 'gtin' | 'code39'; format: string }
  | { type: 'truncated' }
  | { type: 'tooShort'; minLength: number; actualLength: number }
  | { type: 'tooLong'; maxLength: number; actualLength: number }

export type BarcodeGuardResult = { ok: true } | { ok: false; reason: BarcodeGuardReason }

/**
 * 1件の BarcodeHit をルールに従って検証する。native / zxing どちらの経路の結果でも
 * 同じ関数を通すことで、経路によらず同じ誤読ガードが効く（ファイル冒頭のコメント参照）。
 *
 * 検証の順序（棄却理由が複数当てはまる場合、最初に見つかったものだけを返す）:
 *   1. 許可シンボロジー（formatDisabled）
 *   2. ここで2次元シンボルは常に即採用して以降のガードを全てスキップする
 *      （ファイル冒頭「2次元シンボルは対象外」のコメント参照）
 *   3. チェックディジット（GTIN mod-10 / Code39 mod-43）
 *   4. 見切れ（box が画像の縁に接している）
 *   5. 桁数の範囲（下限・上限）
 *
 * 複数回一致（agreement.ts）はフレームをまたいだ時間軸の状態を必要とするため、
 * この純粋関数の責務には含めない（呼び出し側が別途チェックする）。
 */
export function evaluateBarcodeHit(hit: BarcodeHit, rules: BarcodeGuardRules): BarcodeGuardResult {
  if (!rules.enabledFormats.includes(hit.format as SupportedFormat)) {
    return { ok: false, reason: { type: 'formatDisabled', format: hit.format } }
  }

  if (isTwoDimensionalFormat(hit.format)) {
    return { ok: true }
  }

  if (rules.verifyGtinChecksum && isGtinCheckApplicable(hit.format, hit.value.length)) {
    if (!verifyGtinCheckDigit(hit.value)) {
      return { ok: false, reason: { type: 'checkDigitMismatch', check: 'gtin', format: hit.format } }
    }
  }

  if (rules.verifyCode39Checksum && hit.format === 'code_39') {
    if (!verifyCode39CheckDigit(hit.value)) {
      return { ok: false, reason: { type: 'checkDigitMismatch', check: 'code39', format: hit.format } }
    }
  }

  // box を持たないヒット（位置情報を提供しないバックエンド）は判定のしようがないため、
  // roiFilter.ts の isHitInRoi と同じ方針で棄却せず素通しする。
  if (rules.rejectTruncatedBox && hit.box && isBoxTruncated(hit.box, rules.edgeMarginRatio)) {
    return { ok: false, reason: { type: 'truncated' } }
  }

  if (rules.minLength > 0 && hit.value.length < rules.minLength) {
    return { ok: false, reason: { type: 'tooShort', minLength: rules.minLength, actualLength: hit.value.length } }
  }
  if (rules.maxLength > 0 && hit.value.length > rules.maxLength) {
    return { ok: false, reason: { type: 'tooLong', maxLength: rules.maxLength, actualLength: hit.value.length } }
  }

  return { ok: true }
}

// ------------------------------------------------------------------
// 棄却理由 → 日本語メッセージ
// ------------------------------------------------------------------

// UI（設定パネルのチェックリスト・トースト・ヘルプ文言）で共通して使う
// フォーマット名の表示ラベル。BarcodeGuardPanel.tsx からも import して使うため export する
// （表示名をパネルとトーストの2箇所に別々に書くと、将来どちらかだけ更新し忘れる元になる）。
export const BARCODE_FORMAT_LABELS: Readonly<Record<string, string>> = {
  code_128: 'Code128',
  code_39: 'Code39',
  code_93: 'Code93',
  codabar: 'Codabar',
  ean_13: 'EAN-13',
  ean_8: 'EAN-8',
  itf: 'ITF',
  upc_a: 'UPC-A',
  upc_e: 'UPC-E',
  qr_code: 'QRコード',
  data_matrix: 'DataMatrix',
  pdf417: 'PDF417',
}

/**
 * 棄却理由を、現場の人が次に何をすればよいか分かる短い日本語メッセージに組み立てる。
 * showToast にそのまま渡せる長さ・文体にしてある（trim.ts のコメントと同様、
 * このアプリは「何が起きたか」を隠さず短く伝える方針）。
 */
export function describeBarcodeGuardReason(reason: BarcodeGuardReason): string {
  switch (reason.type) {
    case 'formatDisabled': {
      const label = BARCODE_FORMAT_LABELS[reason.format] ?? reason.format
      return `${label} は設定で無効になっているため読み取りませんでした`
    }
    case 'checkDigitMismatch': {
      const label = BARCODE_FORMAT_LABELS[reason.format] ?? reason.format
      // ITF は 14桁のときだけ検証するため、その旨を添えて「なぜ引っかかったか」を
      // 具体的に伝える（バーコードが切れている等の疑いを持ってもらうため）。
      const suffix = reason.check === 'gtin' && reason.format === 'itf' ? '・14桁' : ''
      return `チェックディジットが合いません（${label}${suffix}）。読み取りませんでした`
    }
    case 'truncated':
      return 'バーコードが見切れています。全体が枠に入るように写してください'
    case 'tooShort':
      return `読み取った値が短すぎます（${reason.actualLength}桁、下限は${reason.minLength}桁）。バーコード全体が枠に入っているか確認してください`
    case 'tooLong':
      return `読み取った値が長すぎます（${reason.actualLength}桁、上限は${reason.maxLength}桁）。別のバーコードを誤って読み取っていないか確認してください`
  }
}
