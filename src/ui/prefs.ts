// 画面まわりのユーザー設定。読み取った内容は保存しない方針だが、
// 毎回操作し直すのが煩わしい表示・操作の設定だけは localStorage に残す。

import type { CaptureQuality } from '../camera/quality'
import type { OcrFilterMode } from '../scan/ocr/postprocess'
import type { BarcodeTriggerMode, ScanMode } from '../scan/scanGating'
import { DEFAULT_BARCODE_TRIGGER_MODE } from '../scan/scanGating'
import { DEFAULT_TRIM_RULES, type TrimRules } from '../scan/barcode/trim'
import { DEFAULT_BARCODE_GUARD_RULES, type BarcodeGuardRules } from '../scan/barcode/guards'
import { SUPPORTED_FORMATS, type SupportedFormat } from '../scan/barcode/types'

const SCAN_MODE_STORAGE_KEY = 'dlabel.scanMode'

/**
 * 直近選択していた読み取りモード（バーコード / 文字）。保存値が無い・壊れている
 * 場合はバーコードモードを既定とする（従来からの唯一の挙動だったため）。
 */
export function loadScanMode(): ScanMode {
  try {
    const raw = localStorage.getItem(SCAN_MODE_STORAGE_KEY)
    return raw === 'ocr' ? 'ocr' : 'barcode'
  } catch {
    // プライベートブラウジング等で読めなくても既定値（バーコードモード）で動作させる
    return 'barcode'
  }
}

export function saveScanMode(mode: ScanMode): void {
  try {
    localStorage.setItem(SCAN_MODE_STORAGE_KEY, mode)
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}

const BARCODE_TRIGGER_MODE_STORAGE_KEY = 'dlabel.barcodeTriggerMode'

/**
 * バーコードの読み取り契機（常に読む / ボタンを押している間だけ読む）。
 * 保存値が無い・壊れている場合は 'continuous'（常に読む）を既定とする。
 * この既定は、この設定が存在しなかった頃からの唯一の挙動であり、
 * 設定を一度も触っていない利用者の手元で挙動が変わらないようにするためのもの。
 */
export function loadBarcodeTriggerMode(): BarcodeTriggerMode {
  try {
    const raw = localStorage.getItem(BARCODE_TRIGGER_MODE_STORAGE_KEY)
    return raw === 'hold' ? 'hold' : DEFAULT_BARCODE_TRIGGER_MODE
  } catch {
    // プライベートブラウジング等で読めなくても既定値（常に読む）で動作させる
    return DEFAULT_BARCODE_TRIGGER_MODE
  }
}

export function saveBarcodeTriggerMode(mode: BarcodeTriggerMode): void {
  try {
    localStorage.setItem(BARCODE_TRIGGER_MODE_STORAGE_KEY, mode)
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}

const OCR_FILTER_MODE_STORAGE_KEY = 'dlabel.ocrFilterMode'

/**
 * OCR結果の抽出フィルタ。PSM と同じ理由で永続化する。
 * 保存値が無い・壊れている場合は従来の既定である 'raw'（フィルタなし）とする。
 */
export function loadOcrFilterMode(): OcrFilterMode {
  try {
    const raw = localStorage.getItem(OCR_FILTER_MODE_STORAGE_KEY)
    if (raw === 'digits' || raw === 'alnum' || raw === 'digitsFixed') return raw
    return 'raw'
  } catch {
    return 'raw'
  }
}

export function saveOcrFilterMode(mode: OcrFilterMode): void {
  try {
    localStorage.setItem(OCR_FILTER_MODE_STORAGE_KEY, mode)
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}

// 注意: 以前はここに「丁寧に読む」(ocrCareful: PSMを変えて2パス認識する設定)、
// 「OCRエンジン選択」(ocrEngine: tesseract / mlkit / paddle)、
// 「OCR前処理」(ocrPreprocess: 罫線除去・縞マスク・コントラスト正規化の各段ON/OFF、
// 比較パネル OcrCompareSheet が使っていた設定)の保存関数があったが、いずれも
// 不要になったため削除した。
// - ocrCareful は「2回目にPSMを変える」実装だったため、PSM自体が無い ML Kit
//   以降の構成では成立しない（前処理を変えた2パスとして作り直すのは別の作業）。
// - ocrEngine は tesseract.js → ML Kit → PaddleOCR と実機比較を重ねた末に
//   PaddleOCR 一本に絞ったため（README「OCR まわりの修正履歴」参照）、
//   選ぶ余地そのものが無くなった。
// - ocrPreprocess は、その前処理パイプライン自体（src/scan/ocr/preprocess.ts）と
//   比較パネル（OcrCompareSheet.tsx）を丸ごと削除したため、保存する対象が
//   無くなった。

const SOUND_STORAGE_KEY = 'dlabel.soundEnabled'

/** 読み取り音を鳴らすか。保存値が無い・壊れている場合は ON とする */
export function loadSoundEnabled(): boolean {
  try {
    const raw = localStorage.getItem(SOUND_STORAGE_KEY)
    if (raw === null) return true
    return raw === 'true'
  } catch {
    // プライベートブラウジング等で読めなくても既定値で動作させる
    return true
  }
}

export function saveSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, String(enabled))
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}

const RESTRICT_TO_ROI_STORAGE_KEY = 'dlabel.restrictToRoi'

/** バーコード読み取りを枠内だけに絞るか。保存値が無い・壊れている場合は ON とする */
export function loadRestrictToRoi(): boolean {
  try {
    const raw = localStorage.getItem(RESTRICT_TO_ROI_STORAGE_KEY)
    if (raw === null) return true
    return raw === 'true'
  } catch {
    // プライベートブラウジング等で読めなくても既定値（ON）で動作させる
    return true
  }
}

export function saveRestrictToRoi(enabled: boolean): void {
  try {
    localStorage.setItem(RESTRICT_TO_ROI_STORAGE_KEY, String(enabled))
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}

const HELP_SEEN_STORAGE_KEY = 'dlabel.helpSeen'

/** 使い方（ヘルプ）パネルを一度でも見せたことがあるか。初回起動時の自動表示判定に使う */
export function loadHelpSeen(): boolean {
  try {
    return localStorage.getItem(HELP_SEEN_STORAGE_KEY) === 'true'
  } catch {
    // プライベートブラウジング等で読めない場合は「未表示」扱いにする
    // （毎回自動で開いてしまうだけで、実害はない）
    return false
  }
}

export function markHelpSeen(): void {
  try {
    localStorage.setItem(HELP_SEEN_STORAGE_KEY, 'true')
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}

const ZOOM_STORAGE_KEY = 'dlabel.zoom'

/**
 * 直近のズーム値。保存値が無い・壊れている場合は null を返す
 * （呼び出し側は「保存された値が無い」ものとして扱う）。
 * 保存されたのが別端末での値である可能性があるため、適用前に必ず
 * camera/zoom.ts の resolveZoomValue で現在の端末の範囲に対して検証すること。
 */
export function loadZoom(): number | null {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  } catch {
    // プライベートブラウジング等で読めなくても既定のズーム（範囲下限）で動作させる
    return null
  }
}

export function saveZoom(value: number): void {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(value))
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}

const CAPTURE_QUALITY_STORAGE_KEY = 'dlabel.captureQuality'

/**
 * カメラ取得解像度（画質）のプリセット。保存値が無い・壊れている場合は
 * 既定の 'max'（端末の最大解像度）とする。'max' が既定なのは、720px一律
 * ダウンスケールを撤廃して得た読み取り精度を、この設定のせいで
 * 知らないうちに退行させないため（camera/quality.ts を参照）。
 */
export function loadCaptureQuality(): CaptureQuality {
  try {
    const raw = localStorage.getItem(CAPTURE_QUALITY_STORAGE_KEY)
    return raw === 'fhd' || raw === 'hd' ? raw : 'max'
  } catch {
    // プライベートブラウジング等で読めなくても既定値（最大解像度）で動作させる
    return 'max'
  }
}

export function saveCaptureQuality(value: CaptureQuality): void {
  try {
    localStorage.setItem(CAPTURE_QUALITY_STORAGE_KEY, value)
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}

const TRIM_RULES_STORAGE_KEY = 'dlabel.trimRules'

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

// 保存値の形を信用せず、TrimRules として妥当な形かどうかを1フィールドずつ確かめる
// （localStorage の値は他バージョンのアプリや手動編集で壊れている可能性があるため）。
//
// 注意: cutFromLast/cutUpToLast は後から追加したフィールドなので、ここでは
// 「存在しない（=旧バージョンで保存された値）」ことも許容し、必須にはしない。
// もし必須にしてしまうと、この2フィールドを持たない既存の保存値がすべて
// isValidTrimRules で弾かれ、DEFAULT_TRIM_RULES（＝整形OFF・全ルール空）まで
// リセットされてしまう。それは「最後に現れた位置」機能を使わない大多数の
// 既存ユーザーにとって、アップデートしただけでせっかく設定した整形ルールが
// 消えるという最悪の体験になるため、欠けている場合は false を補って読み込む
// （呼び出し側の loadTrimRules で対応）。
// cutFromLast/cutUpToLast は「無くてもよい」ことを型でも表現する
// （TrimRules そのものを返り値の型にすると、この2フィールドが常に boolean である
// ことを TypeScript に約束してしまい、下の loadTrimRules 側で「無ければ false を
// 補う」という分岐が「常に false 側は通らない」という誤った警告の元になるため）。
type StoredTrimRules = Omit<TrimRules, 'cutFromLast' | 'cutUpToLast'> & {
  cutFromLast?: boolean
  cutUpToLast?: boolean
}

function isValidTrimRules(value: unknown): value is StoredTrimRules {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.enabled === 'boolean' &&
    isStringArray(v.stripPrefixes) &&
    isStringArray(v.stripSuffixes) &&
    typeof v.cutFrom === 'string' &&
    (v.cutFromLast === undefined || typeof v.cutFromLast === 'boolean') &&
    typeof v.cutUpTo === 'string' &&
    (v.cutUpToLast === undefined || typeof v.cutUpToLast === 'boolean') &&
    typeof v.trimWhitespace === 'boolean'
  )
}

/**
 * バーコード値の整形（トリミング）ルール。保存値が無い・壊れている場合は
 * DEFAULT_TRIM_RULES（＝OFF）にフォールバックする。
 * cutFromLast/cutUpToLast が無い旧バージョンの保存値は、両方 false（＝従来通り
 * 「最初に現れた位置」を使う）を補って読み込む（isValidTrimRules 冒頭のコメント参照）。
 */
export function loadTrimRules(): TrimRules {
  try {
    const raw = localStorage.getItem(TRIM_RULES_STORAGE_KEY)
    if (raw === null) return DEFAULT_TRIM_RULES
    const parsed: unknown = JSON.parse(raw)
    if (!isValidTrimRules(parsed)) return DEFAULT_TRIM_RULES
    return {
      ...parsed,
      cutFromLast: parsed.cutFromLast ?? false,
      cutUpToLast: parsed.cutUpToLast ?? false,
    }
  } catch {
    // プライベートブラウジング等で読めない・壊れている場合は既定値（OFF）で動作させる
    return DEFAULT_TRIM_RULES
  }
}

export function saveTrimRules(rules: TrimRules): void {
  try {
    localStorage.setItem(TRIM_RULES_STORAGE_KEY, JSON.stringify(rules))
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}

const BARCODE_GUARD_RULES_STORAGE_KEY = 'dlabel.barcodeGuardRules'

// バーコード誤読ガード（scan/barcode/guards.ts）の設定。isValidTrimRules と違い、
// ここでは「保存値の形が丸ごと妥当かどうか」を1回で判定して丸ごと既定値に
// フォールバックする方式ではなく、フィールドごとに個別にサニタイズしてから
// 組み立てる方式にしてある。
//
// 理由（isValidTrimRules 冒頭のコメントにある教訓をさらに一歩進めたもの）:
// 「保存値の一部が壊れている・欠けている」ときに全フィールドを既定値へ巻き戻すと、
// 例えば「有効なシンボロジーだけ丁寧に絞り込んで保存していた」利用者が、
// 将来のバージョンで別のフィールド（例: 複数回一致の回数）が1つ追加された拍子に、
// せっかく絞り込んだシンボロジーの設定までまとめてリセットされてしまう。
// フィールドごとに独立してサニタイズすれば、そのフィールドだけが壊れている・
// 欠けている場合でも、他の正常なフィールドは保存されていた値のまま生き残る。

/** enabledFormats を検証する。SUPPORTED_FORMATS に含まれる文字列だけを残し、
 * 1つも残らない場合（＝バーコードが一切読めなくなる壊れた状態）は既定（全許可）に戻す。 */
function sanitizeEnabledFormats(value: unknown): SupportedFormat[] {
  if (!Array.isArray(value)) return [...DEFAULT_BARCODE_GUARD_RULES.enabledFormats]
  const known: readonly string[] = SUPPORTED_FORMATS
  const filtered = value.filter((v): v is SupportedFormat => typeof v === 'string' && known.includes(v))
  return filtered.length > 0 ? filtered : [...DEFAULT_BARCODE_GUARD_RULES.enabledFormats]
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 0以上の有限数だけを許す（桁数の下限・上限は0=無制限という意味を持つため） */
function sanitizeNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 複数回一致の回数は1〜3に丸める（UIの選択肢自体もこの範囲だが、保存値の破損や
 * 手動編集で範囲外の値が入り込むことに備えて、読み込み側でも必ず丸める）。 */
function sanitizeAgreementCount(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(3, Math.max(1, Math.round(value)))
}

/**
 * バーコードの誤読ガード設定。保存値が無い場合は DEFAULT_BARCODE_GUARD_RULES を返す。
 * 保存値がある場合は、上記のとおりフィールドごとに個別のフォールバックを適用して
 * 組み立てる（一部のフィールドだけが欠けている・型が壊れていても、他のフィールドは
 * 保存されていた値をそのまま活かす）。
 */
export function loadBarcodeGuardRules(): BarcodeGuardRules {
  try {
    const raw = localStorage.getItem(BARCODE_GUARD_RULES_STORAGE_KEY)
    if (raw === null) return DEFAULT_BARCODE_GUARD_RULES
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_BARCODE_GUARD_RULES
    const v = parsed as Record<string, unknown>
    return {
      enabledFormats: sanitizeEnabledFormats(v.enabledFormats),
      verifyGtinChecksum: sanitizeBoolean(v.verifyGtinChecksum, DEFAULT_BARCODE_GUARD_RULES.verifyGtinChecksum),
      verifyCode39Checksum: sanitizeBoolean(v.verifyCode39Checksum, DEFAULT_BARCODE_GUARD_RULES.verifyCode39Checksum),
      rejectTruncatedBox: sanitizeBoolean(v.rejectTruncatedBox, DEFAULT_BARCODE_GUARD_RULES.rejectTruncatedBox),
      edgeMarginRatio: sanitizeNonNegativeNumber(v.edgeMarginRatio, DEFAULT_BARCODE_GUARD_RULES.edgeMarginRatio),
      minLength: sanitizeNonNegativeNumber(v.minLength, DEFAULT_BARCODE_GUARD_RULES.minLength),
      maxLength: sanitizeNonNegativeNumber(v.maxLength, DEFAULT_BARCODE_GUARD_RULES.maxLength),
      requiredAgreementCount: sanitizeAgreementCount(v.requiredAgreementCount, DEFAULT_BARCODE_GUARD_RULES.requiredAgreementCount),
    }
  } catch {
    // プライベートブラウジング等で読めない・JSON自体が壊れている場合は既定値で動作させる
    return DEFAULT_BARCODE_GUARD_RULES
  }
}

export function saveBarcodeGuardRules(rules: BarcodeGuardRules): void {
  try {
    localStorage.setItem(BARCODE_GUARD_RULES_STORAGE_KEY, JSON.stringify(rules))
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}
