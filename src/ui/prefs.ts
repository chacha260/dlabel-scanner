// 画面まわりのユーザー設定。読み取った内容は保存しない方針だが、
// 毎回操作し直すのが煩わしい表示・操作の設定だけは localStorage に残す。

import type { CaptureQuality } from '../camera/quality'
import type { OcrFilterMode } from '../scan/ocr/postprocess'
import { DEFAULT_OCR_PREPROCESS_OPTIONS, type OcrPreprocessOptions } from '../scan/ocr/preprocess'
import type { BarcodeTriggerMode, ScanMode } from '../scan/scanGating'
import { DEFAULT_BARCODE_TRIGGER_MODE } from '../scan/scanGating'
import { DEFAULT_TRIM_RULES, type TrimRules } from '../scan/barcode/trim'

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

// 注意: 以前はここに「丁寧に読む」(ocrCareful: PSMを変えて2パス認識する設定)と
// 「OCRエンジン選択」(ocrEngine: tesseract / mlkit)の保存関数があったが、
// どちらも tesseract.js の削除に伴って意味を失ったため削除した。
// - ocrCareful は「2回目にPSMを変える」実装だったため、PSM自体が無い ML Kit
//   単独構成では成立しない（前処理を変えた2パスとして作り直すのは別の作業）。
// - ocrEngine はエンジンが ML Kit の1つだけになったため選択の余地が無い。

const OCR_PREPROCESS_STORAGE_KEY = 'dlabel.ocrPreprocess'

// 保存値の形を信用せず、OcrPreprocessOptions として妥当な形かどうかを1フィールドずつ
// 確かめる（isValidTrimRules と同じ流儀。他バージョンのアプリや手動編集で
// 壊れている可能性があるため）。
function isValidOcrPreprocessOptions(value: unknown): value is OcrPreprocessOptions {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.removeRuledLines === 'boolean' &&
    typeof v.maskStripes === 'boolean' &&
    typeof v.normalizeContrast === 'boolean'
  )
}

/**
 * OCR前処理（罫線除去・縞マスク・コントラスト正規化）の各段ON/OFF。比較モード
 * （OcrCompareSheet）で「この設定を使う」を選んだ組み合わせを、次回のシャッターにも
 * 引き継ぐために永続化する。保存値が無い・壊れている場合は
 * DEFAULT_OCR_PREPROCESS_OPTIONS（すべてON、従来からの唯一の挙動）にフォールバックする。
 */
export function loadOcrPreprocess(): OcrPreprocessOptions {
  try {
    const raw = localStorage.getItem(OCR_PREPROCESS_STORAGE_KEY)
    if (raw === null) return DEFAULT_OCR_PREPROCESS_OPTIONS
    const parsed: unknown = JSON.parse(raw)
    return isValidOcrPreprocessOptions(parsed) ? parsed : DEFAULT_OCR_PREPROCESS_OPTIONS
  } catch {
    // プライベートブラウジング等で読めない・壊れている場合は既定値（すべてON）で動作させる
    return DEFAULT_OCR_PREPROCESS_OPTIONS
  }
}

export function saveOcrPreprocess(options: OcrPreprocessOptions): void {
  try {
    localStorage.setItem(OCR_PREPROCESS_STORAGE_KEY, JSON.stringify(options))
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}

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
function isValidTrimRules(value: unknown): value is TrimRules {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.enabled === 'boolean' &&
    isStringArray(v.stripPrefixes) &&
    isStringArray(v.stripSuffixes) &&
    typeof v.cutFrom === 'string' &&
    typeof v.cutUpTo === 'string' &&
    typeof v.trimWhitespace === 'boolean'
  )
}

/**
 * バーコード値の整形（トリミング）ルール。保存値が無い・壊れている場合は
 * DEFAULT_TRIM_RULES（＝OFF）にフォールバックする。
 */
export function loadTrimRules(): TrimRules {
  try {
    const raw = localStorage.getItem(TRIM_RULES_STORAGE_KEY)
    if (raw === null) return DEFAULT_TRIM_RULES
    const parsed: unknown = JSON.parse(raw)
    return isValidTrimRules(parsed) ? parsed : DEFAULT_TRIM_RULES
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
