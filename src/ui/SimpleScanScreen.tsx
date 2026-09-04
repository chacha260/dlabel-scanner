// アプリの唯一の画面。上部の切り替えで「バーコード」「文字」の2モードを持ち、
// バーコードモードではカメラでバーコードを継続的に読み取り、文字（OCR）モードでは
// 継続的な読み取りを止めて、枠内をシャッターで撮ったときだけ文字を読み取る。
// 結果はどちらのモードでも同じ1つのリストに時系列（新しい順）でため込むだけの
// 最小構成。フィールド振り分け・保存・履歴は一切行わない
// （結果はメモリ上のみに保持し、画面を閉じると消える。これは意図的な仕様）。
//
// 2モードに分けた理由（現場フィードバック）: 以前は水色の枠が1つしかなく、
// 「OCRが読む範囲」と「バーコードを受け付ける範囲」という2つの意味を同時に
// 持っていたため分かりにくいと指摘された。今はモードごとに専用の枠を持たせ、
// 今どちらのモードかを常にはっきり分かるようにしている。
//
// 現場の要件がまだ固まっていないため、まずはこの最小読み取りツールを持って行き、
// 実際に何が必要かを確認するためのもの。ラベル定義エディタ・履歴・CSV書き出し・
// 設定画面などの既存機能は src/ui/legacy 以下に退避してあり、削除はしていない。

import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RawScan } from '../parse/types'
import type { NormalizedRect } from '../scan/barcode/types'
import { CAPTURE_QUALITY_OPTIONS, type CaptureQuality } from '../camera/quality'
import { useCamera } from '../camera/useCamera'
import { resolveZoomValue } from '../camera/zoom'
import { useBarcodeScanner } from '../scan/useBarcodeScanner'
import { isAnyOverlayOpen, isBarcodeScanEnabled, type BarcodeTriggerMode, type ScanMode } from '../scan/scanGating'
import { applyTrimRules, visualizeControlChars, type TrimRules } from '../scan/barcode/trim'
import { truncateForDisplay } from '../scan/barcode/truncate'
import {
  loadBarcodeTriggerMode,
  loadCaptureQuality,
  loadHelpSeen,
  loadRestrictToRoi,
  loadScanMode,
  loadSoundEnabled,
  loadTrimRules,
  loadZoom,
  markHelpSeen,
  saveBarcodeTriggerMode,
  saveCaptureQuality,
  saveRestrictToRoi,
  saveScanMode,
  saveSoundEnabled,
  saveTrimRules,
  saveZoom,
} from './prefs'
import {
  applyOcrFilter,
  boxesToMask,
  captureFrameAndRoi,
  cropVideoSpaceRoi,
  DEFAULT_BARCODE_ROI,
  DEFAULT_OCR_OPTIONS,
  DEFAULT_ROI,
  hasOcrEngineCached,
  loadPersistedBarcodeRoi,
  loadPersistedRoi,
  OCR_FILTER_LABELS,
  preloadOcr,
  recognizeCaptured,
  savePersistedBarcodeRoi,
  savePersistedRoi,
  trimBarcodeBoxesToStripes,
  type HandleId,
  type OcrFilterMode,
  type OcrOptions,
  type OcrProgress,
  type RoiRect,
} from '../scan/ocr'
import { useDraggableRoi } from './useDraggableRoi'
import { Button } from './components/Button'
import { Select, Switch } from './components/Controls'
import { CloseIcon, CopyIcon, FlashIcon, FlashOffIcon, PauseIcon, PlayIcon, ScanIcon, SoundOffIcon, SoundOnIcon, SpinnerIcon, WarningIcon } from './components/Icons'
import { showToast } from './components/toastBus'
import { copyToClipboard, sourceBadgeClass, sourceBadgeLabel } from './lib'

// 使い方（ヘルプ）パネルはエントリーチャンクを太らせないよう別チャンクにする
// （初回表示までに読み込めていればよく、常に即必要というわけではないため）。
const HelpSheet = lazy(() => import('./HelpSheet'))

// 整形パネルも同じ理由で別チャンクにする（バーコードモードで「整形」ボタンを
// 押すまでは読み込まれない）。
const TrimPanel = lazy(() => import('./TrimPanel'))

// ライセンス情報パネルも別チャンクにする。同梱しているライセンス本文全文
// （src/licenses/generated.ts、100KB超）を抱えているため、これをエントリー
// チャンクに載せてしまうと、ライセンスを一度も開かない大多数の利用者にまで
// 起動時のダウンロード・パースの負担がかかる。
const LicenseSheet = lazy(() => import('./LicenseSheet'))

// 「読み取り済み」通知の連打防止だけに使う短い時間窓（ミリ秒）。追加の可否
// （＝一覧に同じ値が既にあるか）には一切関与しない。バーコード検出時の
// ビープ/バイブもこの値を流用する。変更した場合は HelpSheet.tsx の
// 「バーコードを読む」の記載も合わせること。
const NOTIFY_WINDOW_MS = 1500

// 「読み取り済み」表示を出しっぱなしにする時間（ミリ秒）
const DUPLICATE_HINT_VISIBLE_MS = 1200

// 一覧の1行に、既定で表示する最大文字数。
//
// QR コードは最大 2,953 バイト（バイナリ）/ 4,296 文字（英数字）を持てる。
// 数KBの連続した1トークンを <pre className="break-all"> に描画すると Chromium の
// レイアウトは実測でかなり重くなり、一覧はスキャンのたびに全体が再レンダーされる
// ため、「値の長い読み取りが1件増えるたびに画面が詰まる」原因になる。
// 保持している値そのもの（コピー・全部コピーで使う値）は完全なまま一切削らず、
// 見せ方だけをここで制限する（scan/barcode/truncate.ts のコメントも参照）。
// 300文字あれば、現品票で実際に使う長さの値は切り詰めずにそのまま出せる。
const RESULT_PREVIEW_MAX_CHARS = 300

// ROI 枠のリサイズハンドル定義（表示上の位置と、掴んだときのカーソル形状）。
// 実際の当たり判定は h-11 w-11（44px 角）で、見た目の小さな丸印より大きく取る
// （指でも掴みやすいように）。バーコード枠・OCR枠のどちらでも共通で使う。
const RESIZE_HANDLES: { id: HandleId; left: string; top: string; cursor: string }[] = [
  { id: 'nw', left: '0%', top: '0%', cursor: 'nwse-resize' },
  { id: 'n', left: '50%', top: '0%', cursor: 'ns-resize' },
  { id: 'ne', left: '100%', top: '0%', cursor: 'nesw-resize' },
  { id: 'e', left: '100%', top: '50%', cursor: 'ew-resize' },
  { id: 'se', left: '100%', top: '100%', cursor: 'nwse-resize' },
  { id: 's', left: '50%', top: '100%', cursor: 'ns-resize' },
  { id: 'sw', left: '0%', top: '100%', cursor: 'nesw-resize' },
  { id: 'w', left: '0%', top: '50%', cursor: 'ew-resize' },
]

// シャッターを押した瞬間の静止フレームと、その時点での ROI（映像座標）・
// 検出済みバーコード枠（ROI と重なるものだけ、マージン込み・映像座標）をまとめて保持する。
// 「同じ画像で再認識」やマスクON/OFFの切り替えは、この静止フレームに対して
// 再度クロップし直すだけで完結させ、都度カメラや検出をやり直さない。
type CapturedFrameState = {
  frame: OffscreenCanvas
  videoRoi: RoiRect
  maskRects: NormalizedRect[]
}

const PSM_OPTIONS: { value: OcrOptions['psm']; label: string }[] = [
  { value: '7', label: '単一行' },
  { value: '8', label: '単語' },
  { value: '6', label: 'ブロック' },
]

// バーコードの読み取り契機の選択肢（バーコードモードのセグメント切り替え用）。
// hint は選択中のときだけ画面に出す一行説明で、現場の人が「今どっちなのか」を
// 迷わないようにするためのもの。
const TRIGGER_MODE_OPTIONS: { value: BarcodeTriggerMode; label: string; hint: string }[] = [
  { value: 'continuous', label: '常に読む', hint: 'カメラを向けている間ずっと読み取ります。' },
  { value: 'hold', label: '長押し中だけ', hint: '下の読み取りボタンを押している間だけ読み取ります。' },
]

const FILTER_OPTIONS: { value: OcrFilterMode; label: string }[] = [
  { value: 'raw', label: OCR_FILTER_LABELS.raw },
  { value: 'digits', label: OCR_FILTER_LABELS.digits },
  { value: 'alnum', label: OCR_FILTER_LABELS.alnum },
]

// 統一結果リストの1件。バーコード・OCR共通の形。フィールド振り分けは行わない。
type ResultItem = {
  id: number
  source: 'barcode' | 'ocr'
  raw: string // 元の読み取り値そのもの（バーコード: デコーダの生の値 / OCR: エンジンが実際に読んだ生テキスト）
  // 表示・コピー・重複判定に使う値。
  // バーコード: 読み取りを受け付けた瞬間の整形ルールを適用した結果（空文字になる場合は raw と同じ）。
  //             ルールは後から変えても過去の結果には遡って効かない（スキャン時点で確定させる）。
  // OCR: raw と同じ値を入れておく（フィルタは filterMode の切り替えに追従させたいため、
  //      ここでは適用せず displayValueOf 側で都度計算する）。
  value: string
  format?: string
  at: number
}

// 表示用の値を求める。OCR結果だけ抽出フィルタの対象になる
// （フィルタはここで毎回計算するだけの純粋処理なので、切り替えは即座に反映される）。
// バーコードは整形済みの value をそのまま返す（フィルタのように毎回計算し直すものではない）。
function displayValueOf(item: ResultItem, filterMode: OcrFilterMode): string {
  if (item.source !== 'ocr') return item.value
  return applyOcrFilter(item.raw, filterMode)
}

// 前処理済み ImageData をそのまま canvas に描画するだけの小さな表示コンポーネント。
// 「実際に OCR エンジンへ渡された画像そのもの」を見せるため、映像から再度読み直したりはしない。
function CapturedImageCanvas({ image, className }: { image: ImageData; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    ctx?.putImageData(image, 0, 0)
  }, [image])

  return <canvas ref={canvasRef} className={className} style={{ imageRendering: 'pixelated' }} />
}

// 結果一覧の1行。行ごとに「全文を表示するか」の状態を持たせたいので、
// 一覧の map の中に直接書かずコンポーネントとして切り出してある
// （展開状態を親が Set などで一括管理すると、1行開くだけで一覧全体の
// 再レンダーを誘発してしまい、値の長い行が並ぶ状況ではまさに避けたい負荷になる）。
function ResultRow({
  item,
  filterMode,
  onCopy,
  onDelete,
}: {
  item: ResultItem
  filterMode: OcrFilterMode
  onCopy: (value: string) => void
  onDelete: (id: number) => void
}) {
  const [expanded, setExpanded] = useState(false)

  // コピーに使う値は常に完全な値。切り詰めるのは「見せ方」だけ。
  const value = displayValueOf(item, filterMode)
  // 表示された値が元の読み取り値と違うときだけ、その下に元の値を小さく添える
  // （OCR: フィルタで絞り込んだとき / バーコード: 整形ルールで削られたとき）。
  const showRaw = value !== item.raw
  // 一覧の表示だけ、制御文字（GSなど）を目に見える記号にする。コピーする値
  // （value・item.raw そのもの）は一切変えない。バーコードだけに適用する
  // （OCRの改行等まで記号化すると、複数行のOCR結果が読みにくくなるため）。
  const visualized = item.source === 'barcode' ? visualizeControlChars(value) : value
  const visualizedRaw = item.source === 'barcode' ? visualizeControlChars(item.raw) : item.raw

  const preview = truncateForDisplay(visualized, RESULT_PREVIEW_MAX_CHARS)
  const rawPreview = truncateForDisplay(visualizedRaw, RESULT_PREVIEW_MAX_CHARS)
  const displayValue = expanded ? visualized : preview.text
  const displayRaw = expanded ? visualizedRaw : rawPreview.text
  const canExpand = preview.truncated || rawPreview.truncated

  return (
    <li className="flex items-start gap-2 p-3">
      <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${sourceBadgeClass(item.source)}`}>
        {sourceBadgeLabel(item.source)}
      </span>
      <div className="min-w-0 flex-1">
        <pre className="whitespace-pre-wrap break-all font-mono text-sm text-slate-100">
          {displayValue === '' ? '(空文字)' : displayValue}
          {!expanded && preview.truncated && <span className="text-slate-500">…</span>}
        </pre>
        {showRaw && (
          <p className="mt-0.5 whitespace-pre-wrap break-all text-[11px] text-slate-500">
            元の読み取り: {displayRaw}
            {!expanded && rawPreview.truncated && '…'}
          </p>
        )}
        {canExpand && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="mt-1 rounded bg-slate-800 px-2 py-1 text-[11px] font-semibold text-cyan-300 active:bg-slate-700"
          >
            {expanded
              ? '表示を短くする'
              : `全${Array.from(visualized).length}文字を表示（残り${preview.omittedChars}文字）`}
          </button>
        )}
        {canExpand && (
          <p className="mt-0.5 text-[10px] text-slate-500">
            ※表示だけを短くしています。コピーされる値は常に全文です。
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onCopy(value)}
        aria-label="この行をコピー"
        className="shrink-0 rounded-lg p-1.5 text-slate-300 active:bg-slate-800"
      >
        <CopyIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onDelete(item.id)}
        aria-label="この行を削除"
        className="shrink-0 rounded-full p-1.5 text-slate-400 active:bg-slate-800"
      >
        <CloseIcon className="h-4 w-4" />
      </button>
    </li>
  )
}

export function SimpleScanScreen() {
  // 画質プリセットは起動直後の最初の getUserMedia 要求から効かせたいため、
  // useState の遅延初期化で1度だけ localStorage を読み、useCamera に渡す
  // （loadScanMode 等、他の設定の読み方と同じ流儀）。
  const [initialCaptureQuality] = useState(loadCaptureQuality)
  const camera = useCamera(initialCaptureQuality)

  // バーコードの読み取り契機（常に読む / 読み取りボタンを長押ししている間だけ読む）。
  // 現場フィードバック: 現品票が密集している棚では、狙っていない隣のラベルまで
  // 勝手に拾ってしまうため「押している間だけ読みたい」という要望があった。
  // 一方で棚卸しのように次々に読んでいく作業では常時読み取りのほうが速いので、
  // どちらかに寄せるのではなく切り替えられるようにしてある。
  // 前回選んでいた契機を次回起動時も復元する（既定は従来通り 'continuous'）。
  const [triggerMode, setTriggerMode] = useState<BarcodeTriggerMode>(loadBarcodeTriggerMode)
  // 「長押し中だけ」モードで、読み取りボタンが今まさに押されているか。
  // これは操作の瞬間そのものなので永続化しない（起動時は必ず「押していない」から始める）。
  const [holdActive, setHoldActive] = useState(false)

  // 読み取りモード（バーコード / 文字）。前回選んでいたモードを次回起動時も復元する。
  const [mode, setMode] = useState<ScanMode>(loadScanMode)
  const handleChangeMode = useCallback((next: ScanMode) => {
    setMode(next)
    saveScanMode(next)
    // モードを切り替えた瞬間に指が離れる保証はないため、押下状態は必ず落としておく
    // （文字モードへ移ったあとも holdActive が true のまま残ると、バーコードモードへ
    // 戻った瞬間に押していないのに読み取りが走ってしまう）。
    setHoldActive(false)
  }, [])

  const [results, setResults] = useState<ResultItem[]>([])
  const nextIdRef = useRef(0)
  // useBarcodeScanner に「今この値は一覧にあるか」を答えるための ref。
  // フック側は結果一覧のコピーを一切持たず、常にこの ref 経由で最新の一覧を尋ねるだけ
  // （state を直接渡すと、結果一覧が変わるたびにフレームループの依存が変わってしまう）。
  const resultsRef = useRef(results)
  useEffect(() => {
    resultsRef.current = results
  }, [results])
  // バーコード値の整形（トリミング）ルール。前回設定していた内容を次回起動時も復元する。
  // trimRulesRef はフレームループ（isDuplicateValue・handleScan）から最新値を読むためのもの
  // （state を直接依存配列に入れると、ルールを変えるたびにフレームループ側の再構築が起きるため）。
  const [trimRules, setTrimRules] = useState<TrimRules>(loadTrimRules)
  const trimRulesRef = useRef(trimRules)
  useEffect(() => {
    trimRulesRef.current = trimRules
  }, [trimRules])
  const handleChangeTrimRules = useCallback((next: TrimRules) => {
    setTrimRules(next)
    saveTrimRules(next)
  }, [])

  // 整形パネル。バーコード値の整形ルールを編集する全画面パネルで、使い方パネルと同様、
  // 開いている間はカメラがどこを向いているか分からなくなるため isAnyOverlayOpen 経由で
  // バーコード検出を止める（下の overlaysOpen を参照）。
  const [trimPanelOpen, setTrimPanelOpen] = useState(false)
  const handleOpenTrimPanel = useCallback(() => setTrimPanelOpen(true), [])
  const handleCloseTrimPanel = useCallback(() => setTrimPanelOpen(false), [])

  // 対象はバーコード行のみ。OCR で読んだ文字列がたまたま同じ値でも、
  // バーコードの読み取りを止める理由にはならないため。
  // 重複判定は「整形後の値」で比較する（一覧に残っているのは整形後の値であり、
  // それがこのアプリにとっての“意味のある識別子”のため）。
  const isDuplicateValue = useCallback((value: string) => {
    const trimmed = applyTrimRules(value, trimRulesRef.current)
    return resultsRef.current.some((item) => item.source === 'barcode' && item.value === trimmed)
  }, [])

  const [manualPaused, setManualPaused] = useState(false)
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible')

  // 使い方（ヘルプ）パネル。初めて開いたときだけ自動表示し、以降は「?」ボタンで
  // 手動で開く。開いている間はカメラがどこを向いているか分からなくなるため、
  // isAnyOverlayOpen 経由でバーコード検出を止める（下の overlaysOpen を参照）。
  const [helpOpen, setHelpOpen] = useState(false)

  // ライセンス情報パネル。使い方パネルの中のボタンから開き、その上に重ねて表示する
  // （使い方パネルは開いたまま。閉じると使い方パネルへ戻る）。
  // 使い方パネル・整形パネルと同様、全画面でカメラが見えなくなるため
  // isAnyOverlayOpen 経由でバーコード検出を止める。
  const [licenseOpen, setLicenseOpen] = useState(false)
  const handleOpenLicenses = useCallback(() => setLicenseOpen(true), [])
  const handleCloseLicenses = useCallback(() => setLicenseOpen(false), [])

  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrProgress, setOcrProgress] = useState<OcrProgress | null>(null)
  const [ocrInfo, setOcrInfo] = useState<{ ms: number; confidence: number } | null>(null)
  const [ocrRawText, setOcrRawText] = useState<string | null>(null)
  // シャッターを押した瞬間に確定させた「実際に OCR へ渡す画像」。結果が出たあとも
  // ユーザーが消すか次のシャッターを押すまで表示し続け、同じ画像での再認識にも使う。
  const [capturedImage, setCapturedImage] = useState<ImageData | null>(null)
  const [showFirstUseHint, setShowFirstUseHint] = useState(!hasOcrEngineCached())

  // 結果カード内だけの設定（このアプリで唯一の設定面）。
  const [psm, setPsm] = useState<OcrOptions['psm']>(DEFAULT_OCR_OPTIONS.psm)
  const [filterMode, setFilterMode] = useState<OcrFilterMode>('raw')

  const previewRef = useRef<HTMLDivElement | null>(null)

  // OCR枠・バーコード枠は別物の矩形として、それぞれ独立に移動・リサイズ・永続化する
  // （見た目も既定値も localStorage のキーも別々。useDraggableRoi 内部の説明を参照）。
  // OCR枠はこれまで通り、OCR実行中・使い方パネル表示中はドラッグさせない。
  const ocrBox = useDraggableRoi(DEFAULT_ROI, loadPersistedRoi, savePersistedRoi, previewRef, ocrBusy || helpOpen)
  const barcodeBox = useDraggableRoi(DEFAULT_BARCODE_ROI, loadPersistedBarcodeRoi, savePersistedBarcodeRoi, previewRef, helpOpen)

  // バーコード読み取りを枠内だけに絞るか（既定ON）。OFFなら従来通りフレーム全体を対象にする。
  // このトグルはバーコードモードだけに属する（OCR枠には関係ない）。
  const [restrictToRoi, setRestrictToRoi] = useState<boolean>(loadRestrictToRoi)
  const [soundEnabled, setSoundEnabled] = useState<boolean>(loadSoundEnabled)

  // 「読み取り済み」通知（同じ値が既に一覧にあるときの、静かなフィードバック）。
  // 追加はされない代わりに、枠の上に短く文字を出すだけにする。
  const [duplicateHintVisible, setDuplicateHintVisible] = useState(false)
  const duplicateHintTimeoutRef = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (duplicateHintTimeoutRef.current !== null) window.clearTimeout(duplicateHintTimeoutRef.current)
    }
  }, [])
  const handleDuplicateHit = useCallback(() => {
    setDuplicateHintVisible(true)
    if (duplicateHintTimeoutRef.current !== null) window.clearTimeout(duplicateHintTimeoutRef.current)
    duplicateHintTimeoutRef.current = window.setTimeout(() => {
      setDuplicateHintVisible(false)
      duplicateHintTimeoutRef.current = null
    }, DUPLICATE_HINT_VISIBLE_MS)
  }, [])

  // バーコード自動除外（マスク）関連。トグルは既定ON。
  const [autoMaskEnabled, setAutoMaskEnabled] = useState(true)
  const [maskedCount, setMaskedCount] = useState(0)
  // シャッター押下時点の静止フレーム一式。「同じ画像で再認識」やマスクON/OFFの
  // 切り替え後の再クロップに使う（撮り直しはしない）。
  const capturedFrameRef = useRef<CapturedFrameState | null>(null)

  const preloadTriggeredRef = useRef(false)
  const ensureOcrPreloaded = useCallback(() => {
    if (preloadTriggeredRef.current) return
    preloadTriggeredRef.current = true
    // preloadOcr は失敗しても reject せず { ok: false, error } を返す契約
    // （呼び捨てで unhandled rejection にならないようにするため）。
    // ここで ok を見ずに捨ててしまうと、学習データが読めていないことに誰も気づけず、
    // 「シャッターを押しても毎回失敗するが理由が分からない」状態になる
    // （.gz 展開に依存していた頃、実機でまさにこれが起きていた）。
    // 事前読み込みの失敗自体は致命的ではない（実際の認識時に改めて初期化を試みる）ため、
    // 処理は止めず、軽い通知に留めたうえで次回のシャッターで再試行できるようにする。
    void preloadOcr((p) => setOcrProgress(p)).then((result) => {
      if (result.ok) return
      preloadTriggeredRef.current = false // 次のシャッターでもう一度初期化を試させる
      showToast(result.error, 'error')
    })
  }, [])

  // 画面はこれ1つしかないため、マウント時にカメラを起動しアンマウント時に止めるだけでよい
  useEffect(() => {
    void camera.start()
    return () => camera.stop()
    // camera.start / camera.stop は useCamera 内で useCallback により安定した参照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ブラウザタブ自体の前面/背面をハンドリングする。
  // 画面が背面に回った時点で押下状態も落とす: 押したままアプリを切り替えると
  // pointerup が届かないことがあり、戻ってきたときに押していないのに
  // 読み取りが走り続ける状態になってしまうため。
  useEffect(() => {
    const handleVisibility = () => {
      const visible = document.visibilityState === 'visible'
      setPageVisible(visible)
      if (!visible) setHoldActive(false)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  // 初めての起動時だけ、使い方パネルを自動で開く（以降は「?」ボタンで手動オープン）
  useEffect(() => {
    if (!loadHelpSeen()) {
      setHelpOpen(true)
      markHelpSeen()
    }
  }, [])

  // ズーム対応端末でだけ、直前に使っていたズーム値を復元する。
  // カメラが（再試行等で）張り直されるたびに再適用できるよう、
  // camera.stream の参照が変わったら「まだ適用していない」状態に戻す。
  const zoomAppliedRef = useRef(false)
  useEffect(() => {
    zoomAppliedRef.current = false
  }, [camera.stream])
  useEffect(() => {
    if (zoomAppliedRef.current) return
    if (!camera.ready || !camera.zoomSupported || !camera.zoomRange) return
    zoomAppliedRef.current = true
    // 保存値は別端末のものである可能性があるため、必ず今の端末の範囲で検証してから使う
    const value = resolveZoomValue(loadZoom(), camera.zoomRange)
    if (value !== null) void camera.setZoom(value)
    // camera.setZoom は useCamera 内で useCallback により安定した参照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.ready, camera.zoomSupported, camera.zoomRange, camera.setZoom])

  const handleZoomChange = useCallback(
    (value: number) => {
      void camera.setZoom(value)
      saveZoom(value)
    },
    [camera],
  )

  // 画質プリセットの変更。camera.setQuality がストリームの張り直し（必要な場合のみ）
  // まで面倒を見てくれるので、ここでは保存と呼び出しだけでよい。張り直し後の
  // ズーム再適用も、camera.stream の変化を見ている既存の effect が自動で行う。
  const handleChangeQuality = useCallback((value: CaptureQuality) => {
    saveCaptureQuality(value)
    void camera.setQuality(value)
  }, [camera])

  const handleOpenHelp = useCallback(() => setHelpOpen(true), [])
  const handleCloseHelp = useCallback(() => setHelpOpen(false), [])

  const appendResult = useCallback((source: ResultItem['source'], raw: string, value: string, format?: string) => {
    const id = nextIdRef.current++
    const item: ResultItem = { id, source, raw, value, format, at: Date.now() }
    // ref を state の反映（effect）まで待たずにここで更新する。
    // 待つと、その間に届いたフレームで同じ値が二重に追加され得るため。
    resultsRef.current = [item, ...resultsRef.current]
    setResults((prev) => [item, ...prev])
  }, [])

  const handleScan = useCallback(
    (scan: RawScan) => {
      // 整形ルールは「読み取りを受け付けた瞬間」に確定させ、一覧には整形後の値を積む
      // （ルールを後から変えても、既に一覧にある行には遡って効かない）。
      const trimmed = applyTrimRules(scan.value, trimRulesRef.current)
      appendResult('barcode', scan.value, trimmed, scan.format)
    },
    [appendResult],
  )

  const handleToggleSound = useCallback(() => {
    setSoundEnabled((prev) => {
      const next = !prev
      saveSoundEnabled(next)
      return next
    })
  }, [])

  // 読み取り契機の切り替え。切り替えた瞬間に押下状態を落とすのはもちろん、
  // 「長押し中だけ」へ移るときは手動一時停止も解除する。長押しモードでは
  // 一時停止ボタン自体を出さないため、以前の一時停止状態が残ったままだと
  // 「ボタンを押しているのに読めない」という解除不能な行き止まりになるため。
  const handleChangeTriggerMode = useCallback((next: BarcodeTriggerMode) => {
    setTriggerMode(next)
    saveBarcodeTriggerMode(next)
    setHoldActive(false)
    if (next === 'hold') setManualPaused(false)
  }, [])

  // 読み取りボタンの押下開始。setPointerCapture により、押したまま指がボタンの外へ
  // ずれても pointerup/pointercancel が必ずこの要素に届くようにする
  // （キャプチャしないと、指がずれた瞬間に押しっぱなし状態が残り、離しても
  // 読み取りが止まらなくなる）。
  const handleHoldStart = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // キャプチャに対応していない環境でも、下の setHoldActive(true) 自体は行う
    }
    setHoldActive(true)
  }, [])

  const handleHoldEnd = useCallback(() => {
    setHoldActive(false)
  }, [])

  const handleToggleRestrictToRoi = useCallback(() => {
    setRestrictToRoi((prev) => {
      const next = !prev
      saveRestrictToRoi(next)
      return next
    })
  }, [])

  // 「枠をリセット」は今のモードが持っている枠だけを既定値に戻す
  // （もう一方の枠には触れない）。
  const handleResetRoi = useCallback(() => {
    if (mode === 'ocr') ocrBox.reset()
    else barcodeBox.reset()
  }, [mode, ocrBox, barcodeBox])

  // この画面に実在するオーバーレイは「OCR結果カード」「使い方パネル」「整形パネル」の
  // 3つだけ（一覧・確認ダイアログ・プロファイル選択などはこの画面には存在しない）。
  // isAnyOverlayOpen は汎用の純粋関数のまま流用し、渡すフラグだけを実在するものに絞る。
  // OCR結果カードで止めるのは「認識処理中」だけにする。結果カードはカメラ映像の下に
  // 並ぶだけで視界を塞がないため、表示されている間ずっと検出を止めると
  // 一度 OCR しただけでバーコードが読めなくなってしまう。
  // 使い方パネル・整形パネルはどちらも全画面表示でカメラがどこを向いているか
  // 分からなくなるため、開いている間は常にバーコード検出を止める。
  const overlaysOpen = useMemo(
    () => isAnyOverlayOpen({ ocrResultPanelOpen: ocrBusy, helpOpen, trimPanelOpen, licenseOpen }),
    [ocrBusy, helpOpen, trimPanelOpen, licenseOpen],
  )

  // バーコード検出を有効にすべきかは isBarcodeScanEnabled（純粋関数）だけで判定する。
  // 文字（OCR）モードでは、他の条件が何であれ常に無効になる
  // （＝このモードでは一覧に何も自動追加させない、というのが今回のモード分割の核心）。
  const scanEnabled = useMemo(
    () =>
      isBarcodeScanEnabled({
        tabActive: true,
        cameraReady: camera.ready,
        pageVisible,
        manualPaused,
        overlaysOpen,
        mode,
        // 「長押し中だけ」モードの停止も、専用の分岐ではなくこの述語の条件の
        // ひとつとして畳み込む（scanGating.ts の isTriggerSatisfied を参照）。
        triggerMode,
        holdActive,
      }),
    [camera.ready, pageVisible, manualPaused, overlaysOpen, mode, triggerMode, holdActive],
  )

  const { backend, error: scannerError, detectBoxes } = useBarcodeScanner({
    videoRef: camera.videoRef,
    enabled: scanEnabled,
    // バックエンドは画面が有効な間ずっと保持する（モード切り替えやオーバーレイ開閉で作り直さない）
    active: camera.ready,
    dedupeMs: NOTIFY_WINDOW_MS,
    beep: soundEnabled,
    vibrate: true,
    // バーコードモード専用の枠（表示座標）。「枠内のみ」ON時は、フック側で
    // 映像座標へ変換・絞り込みしてもらう。roi・restrictToRoi は ref 経由で読まれるため、
    // ドラッグや切り替えのたびにフレームループ（バックエンド保持を含む）が張り直されることはない。
    roi: barcodeBox.roi,
    restrictToRoi,
    // 追加の可否は「今その値が結果一覧にあるか」だけで決める。一覧のコピーはフックに渡さず、
    // 常にこの述語（ref 経由）を通じて呼び出し側の最新の状態を尋ねてもらう。
    isDuplicate: isDuplicateValue,
    onDuplicate: handleDuplicateHit,
    onScan: handleScan,
  })

  // scannerError はトーストではなくバナーとして出す。
  // useBarcodeScanner 側は2種類の異常をこの1つの state で表現している:
  //   - 一過性のもの（ウォッチドッグ発火・zxing の連続デコード失敗からの自動復旧）は
  //     数秒後に自分で null へ戻す
  //   - 自動復旧を諦めた恒久的なもの（アプリの再読み込みが必要）は null へ戻さない
  // 「値がセットされている間だけ出す」バナーにしておけば、この2種類を
  // 呼び出し側が区別しなくても、前者は自然に消え、後者は出続ける。
  // 消えてしまうトーストだと、後者の「再読み込みが必要」という重要な状態を
  // 5秒で見失ってしまう。

  const ocrOptions = useMemo(() => ({ psm }), [psm])

  // 実際に認識にかけている ImageData を渡して結果一覧に積む共通処理。
  // シャッター押下の初回認識・「同じ画像で再認識」のどちらからも呼ぶ。
  const runRecognition = useCallback(
    (image: ImageData) => {
      setOcrBusy(true)
      setOcrProgress(null)
      recognizeCaptured(image, ocrOptions, (p) => setOcrProgress(p))
        .then((result) => {
          setShowFirstUseHint(false)
          setOcrInfo({ ms: result.ms, confidence: result.confidence })
          setOcrRawText(result.text)
          if (result.text.trim().length === 0) {
            showToast('文字を読み取れませんでした', 'error')
          } else {
            appendResult('ocr', result.text, result.text)
          }
        })
        .catch(() => showToast('OCRに失敗しました', 'error'))
        .finally(() => {
          setOcrBusy(false)
          setOcrProgress(null)
        })
    },
    [ocrOptions, appendResult],
  )

  const handleShutterOcr = useCallback(() => {
    if (ocrBox.isDragging) return // 枠をドラッグ中に誤ってシャッターが走らないようにする
    if (helpOpen) return // 使い方パネル表示中は誤操作防止のためOCRを起動しない
    const video = camera.videoRef.current
    if (!video || !camera.ready) {
      showToast('カメラの準備ができていません', 'error')
      return
    }
    // シャッターが押された「その瞬間」の映像全体を、await をまたぐ前に同期的に確定させる。
    // ROI の表示座標→映像座標への変換もこの瞬間の video の表示サイズで行うことで、
    // この後バーコード検出が何ms かかっても「押した瞬間の1枚」を扱い続けられる。
    const captured = captureFrameAndRoi(video, ocrBox.roi)
    setOcrInfo(null)
    setOcrRawText(null)
    setOcrBusy(true)
    setOcrProgress(null)
    ensureOcrPreloaded()

    // バーコード検出はフレームループが持つのと同じリーダーを再利用し、
    // シャッター1回につき1回だけ行う（フレームごとには絶対に行わない）。
    // detectBoxes は失敗しても例外を投げず空配列を返す設計なので、ここでは
    // マスクなしで続行するフォールバックだけ考えればよい。
    // .catch() は必須。ここを落とすと、detectBoxes 自体は空配列を返す設計でも、
    // 続く trimBarcodeBoxesToStripes / cropVideoSpaceRoi が例外を投げた場合
    // （巨大フレームでの getImageData 失敗や 2D コンテキスト取得失敗など）に
    // unhandled rejection になるうえ、直前に立てた ocrBusy が誰にも降ろされず
    // 「シャッターボタンが回り続けたまま二度と押せない」行き止まりになる。
    void detectBoxes(captured.frame)
      .then((boxes) => {
        const candidates = boxesToMask(boxes, captured.videoRoi)
        // 検出枠は「縞がありそうな領域」の候補にすぎないため、実ピクセルを見て
        // 縞が密集している行の帯まで縦方向に縮めてから塗りつぶしに使う
        // （隣接する文字まで一緒に塗りつぶしてしまうのを防ぐため）。
        const maskRects = trimBarcodeBoxesToStripes(captured.frame, candidates)
        capturedFrameRef.current = { frame: captured.frame, videoRoi: captured.videoRoi, maskRects }
        const useMask = autoMaskEnabled && maskRects.length > 0
        const image = cropVideoSpaceRoi(captured.frame, captured.videoRoi, useMask ? maskRects : undefined)
        setCapturedImage(image)
        setMaskedCount(useMask ? maskRects.length : 0)
        // runRecognition は自身の finally で ocrBusy を降ろすので、ここでは降ろさない
        runRecognition(image)
      })
      .catch(() => {
        showToast('画像の取り込みに失敗しました', 'error')
        setOcrBusy(false)
        setOcrProgress(null)
      })
  }, [ocrBox.isDragging, ocrBox.roi, helpOpen, camera.videoRef, camera.ready, ensureOcrPreloaded, detectBoxes, autoMaskEnabled, runRecognition])

  // 撮影しなおさず、現在の PSM・マスク設定で同じ静止フレームを読み直す
  // （フィルタはここでは無関係）。マスクON/OFFの切り替え後の比較にもこれを使う。
  const handleRetrySameImage = useCallback(() => {
    const captured = capturedFrameRef.current
    if (!captured) return
    const maskRects = autoMaskEnabled ? captured.maskRects : []
    const image = cropVideoSpaceRoi(captured.frame, captured.videoRoi, maskRects.length > 0 ? maskRects : undefined)
    setCapturedImage(image)
    setMaskedCount(maskRects.length)
    runRecognition(image)
  }, [autoMaskEnabled, runRecognition])

  const handleDismissCapturedImage = useCallback(() => {
    setCapturedImage(null)
    setOcrInfo(null)
    setOcrRawText(null)
    setMaskedCount(0)
    capturedFrameRef.current = null
  }, [])

  const handleToggleAutoMask = useCallback((checked: boolean) => {
    setAutoMaskEnabled(checked)
  }, [])

  // ResultRow へは「呼ぶだけ」の同期的な口として渡すため、ここで await を閉じ込める
  // （行側に Promise の扱いを持ち込まない）。
  const handleCopyRow = useCallback((value: string) => {
    void copyToClipboard(value).then((ok) => {
      showToast(ok ? 'コピーしました' : 'コピーに失敗しました', ok ? 'success' : 'error')
    })
  }, [])

  const handleDeleteRow = useCallback((id: number) => {
    setResults((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const handleCopyAll = useCallback(async () => {
    const text = results.map((item) => displayValueOf(item, filterMode)).join('\n')
    const ok = await copyToClipboard(text)
    showToast(ok ? '全部コピーしました' : 'コピーに失敗しました', ok ? 'success' : 'error')
  }, [results, filterMode])

  const handleClearAll = useCallback(() => {
    setResults([])
  }, [])

  const backendLabel = backend === 'native' ? 'ネイティブ' : backend === 'zxing' ? 'zxing' : '起動中'

  // OCR結果カードに表示するフィルタ後プレビュー（生テキストは常に別行で見せ続ける）
  const filteredPreview = ocrRawText !== null ? applyOcrFilter(ocrRawText, filterMode) : null

  // 今のモードが持っている枠（表示・ドラッグの対象）
  const activeBox = mode === 'ocr' ? ocrBox : barcodeBox

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      {/* 上部バー: モード切り替え（バーコード/文字）と使い方ボタン。
          常にここに固定されるため、カメラエラー中などどの状態でも必ず押せる。 */}
      <div
        className="flex shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-900 p-2"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.5rem)' }}
      >
        <div role="tablist" aria-label="読み取りモード" className="flex flex-1 gap-1 rounded-xl bg-slate-800 p-1">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'barcode'}
            onClick={() => handleChangeMode('barcode')}
            className={`min-h-10 flex-1 rounded-lg text-sm font-bold transition-colors ${
              mode === 'barcode' ? 'bg-cyan-500 text-slate-950' : 'text-slate-300 active:bg-slate-700'
            }`}
          >
            バーコード
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'ocr'}
            onClick={() => handleChangeMode('ocr')}
            className={`min-h-10 flex-1 rounded-lg text-sm font-bold transition-colors ${
              mode === 'ocr' ? 'bg-cyan-500 text-slate-950' : 'text-slate-300 active:bg-slate-700'
            }`}
          >
            文字
          </button>
        </div>
        <button
          type="button"
          onClick={handleOpenHelp}
          aria-label="使い方を開く"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-800 text-lg font-bold text-slate-100 active:bg-slate-700"
        >
          ?
        </button>
      </div>

      {/* カメラ映像（画面上部） */}
      <div ref={previewRef} className="relative shrink-0 overflow-hidden bg-black" style={{ height: '42vh' }}>
        <video ref={camera.videoRef} autoPlay muted playsInline className="absolute inset-0 h-full w-full object-cover" />

        {!camera.error && (
          <div
            // バーコードモード: 「枠内のみ」ON時はこの枠がバーコードの採否を決めるため実線・
            // 明るめに、OFF時は「今は画面全体が対象で、枠は狙う場所の目安に過ぎない」ことが
            // 分かるよう破線にする。文字モードでは枠は常にOCRの対象そのものなので常に実線。
            className={`absolute touch-none rounded-lg border-2 ${
              mode === 'ocr' || restrictToRoi ? 'border-cyan-300' : 'border-dashed border-cyan-300/70'
            }`}
            style={
              {
                left: `${activeBox.roi.x * 100}%`,
                top: `${activeBox.roi.y * 100}%`,
                width: `${activeBox.roi.w * 100}%`,
                height: `${activeBox.roi.h * 100}%`,
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
                cursor: ocrBusy ? undefined : 'move',
              } satisfies CSSProperties
            }
            onPointerDown={(e) => activeBox.beginDrag(e)}
            onPointerMove={activeBox.updateDrag}
            onPointerUp={activeBox.endDrag}
            onPointerCancel={activeBox.endDrag}
          >
            {/* 枠が「何のための枠か」を一目で分かるようにする小さなラベル（枠のすぐ上） */}
            {!ocrBusy && (
              <span className="pointer-events-none absolute -top-5 left-0 rounded bg-slate-900/85 px-1.5 py-0.5 text-[9px] font-semibold text-cyan-200">
                {mode === 'ocr' ? '文字を囲む' : restrictToRoi ? '読み取り範囲: 枠内のみ' : '読み取り範囲: 画面全体'}
              </span>
            )}

            {/* バーコードモード: 一覧に既にある値を検出したときの、静かな「読み取り済み」通知。
                追加はされない代わりに、枠の中央に短く表示するだけに留める（連打はしない）。 */}
            {mode === 'barcode' && duplicateHintVisible && (
              <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-slate-900/90 px-3 py-1.5 text-xs font-bold text-amber-300 shadow-lg">
                読み取り済み
              </span>
            )}

            {/* OCR実行中は、実際に読み取っている静止画をこの枠内に重ねて表示する */}
            {mode === 'ocr' && ocrBusy && capturedImage && (
              <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg bg-black">
                <CapturedImageCanvas image={capturedImage} className="h-full w-full" />
                <div className="absolute inset-0 flex items-center justify-center gap-2 bg-slate-950/40">
                  <SpinnerIcon className="h-5 w-5 text-cyan-300" />
                  <span className="text-xs font-semibold text-cyan-100">この画像を読み取り中…</span>
                </div>
              </div>
            )}
            <span className="pointer-events-none absolute -left-0.5 -top-0.5 h-5 w-5 rounded-tl border-l-4 border-t-4 border-cyan-300" />
            <span className="pointer-events-none absolute -right-0.5 -top-0.5 h-5 w-5 rounded-tr border-r-4 border-t-4 border-cyan-300" />
            <span className="pointer-events-none absolute -bottom-0.5 -left-0.5 h-5 w-5 rounded-bl border-b-4 border-l-4 border-cyan-300" />
            <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 h-5 w-5 rounded-br border-b-4 border-r-4 border-cyan-300" />

            {/* リサイズハンドル: 見た目は小さな丸印だが、当たり判定は指でも掴みやすい44px角 */}
            {!ocrBusy &&
              RESIZE_HANDLES.map((h) => (
                <span
                  key={h.id}
                  role="presentation"
                  className="absolute z-10 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center"
                  style={{ left: h.left, top: h.top, cursor: h.cursor }}
                  onPointerDown={(e) => activeBox.beginDrag(e, h.id)}
                  onPointerMove={activeBox.updateDrag}
                  onPointerUp={activeBox.endDrag}
                  onPointerCancel={activeBox.endDrag}
                >
                  <span className="h-3 w-3 rounded-full border-2 border-cyan-300 bg-slate-950/80" />
                </span>
              ))}
          </div>
        )}

        {camera.error && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-slate-950/95 p-6 text-center">
            <WarningIcon className="h-8 w-8 text-amber-400" />
            <p className="text-sm font-medium text-slate-100">{camera.error}</p>
            <Button variant="primary" size="md" onClick={() => void camera.start()}>
              再試行
            </Button>
          </div>
        )}

        {mode === 'barcode' && manualPaused && !camera.error && (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 flex -translate-y-1/2 justify-center px-4">
            <span className="flex items-center gap-2 rounded-full bg-red-600/95 px-4 py-2 text-sm font-bold text-white shadow-xl">
              <PauseIcon className="h-4 w-4" /> 読み取り停止中
            </span>
          </div>
        )}

        {/* 「長押し中だけ」モードの状態表示。今読んでいるのか待っているのかが
            映像を見たまま分かるようにする（一時停止中の赤い表示とは排他。
            長押しモードでは一時停止ボタン自体を出さないため両方出ることはない）。 */}
        {mode === 'barcode' && triggerMode === 'hold' && !manualPaused && !camera.error && (
          <div className="pointer-events-none absolute inset-x-0 bottom-10 z-20 flex justify-center px-4">
            {holdActive ? (
              <span className="flex items-center gap-2 rounded-full bg-cyan-500/95 px-4 py-2 text-sm font-bold text-slate-950 shadow-xl">
                <ScanIcon className="h-4 w-4" /> 読み取り中
              </span>
            ) : (
              <span className="flex items-center gap-2 rounded-full bg-slate-900/90 px-4 py-2 text-sm font-bold text-slate-300 shadow-xl">
                ボタンを押している間だけ読み取ります
              </span>
            )}
          </div>
        )}

        {!camera.ready && !camera.error && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <SpinnerIcon className="h-8 w-8 text-slate-400" />
          </div>
        )}

        {/* 解像度はどちらのモードでも画質の診断に使えるため常に表示する。
            バーコードのバックエンド名はバーコードモードでスキャンしているときだけの情報。 */}
        {(mode === 'barcode' || camera.resolution) && (
          <span className="absolute right-2 top-2 rounded-lg bg-slate-900/80 px-2 py-1 text-[10px] font-semibold text-slate-300">
            {mode === 'barcode' && `BC: ${backendLabel}`}
            {mode === 'barcode' && camera.resolution && ' / '}
            {camera.resolution && `${camera.resolution.width}×${camera.resolution.height}`}
          </span>
        )}

        {!camera.error && (
          <button
            type="button"
            onClick={handleResetRoi}
            className="absolute left-2 top-2 rounded-lg bg-slate-900/80 px-2 py-1 text-[10px] font-semibold text-slate-300 active:bg-slate-800"
          >
            枠をリセット
          </button>
        )}

        {/* ズームスライダー: 対応端末でだけ表示する。ROI 枠（上の absolute div）とは
            兄弟要素として previewRef 直下に置き、ROI のドラッグハンドラが登録されている
            DOM 部分木の外に出すことで、ここでのポインタ操作が ROI 移動として
            誤検出されないようにする（念のため stopPropagation も併用）。 */}
        {!camera.error && camera.zoomSupported && camera.zoomRange && camera.zoom !== null && (
          <div
            className="absolute inset-x-3 bottom-2 z-20 flex items-center gap-2 rounded-lg bg-slate-900/80 px-2.5 py-1.5"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerMove={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <span className="shrink-0 text-[10px] font-semibold text-slate-300">ズーム</span>
            <input
              type="range"
              aria-label="ズーム"
              min={camera.zoomRange.min}
              max={camera.zoomRange.max}
              step={camera.zoomRange.step > 0 ? camera.zoomRange.step : 0.1}
              value={camera.zoom}
              onChange={(e) => handleZoomChange(Number(e.target.value))}
              className="h-2 min-w-0 flex-1 accent-cyan-400"
            />
          </div>
        )}
      </div>

      {/* コントロール */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-slate-800 bg-slate-900 p-3">
        {mode === 'ocr' && showFirstUseHint && !ocrBusy && (
          <p className="text-center text-[11px] text-slate-400">
            初回のみOCRエンジン（約9MB）をダウンロードします。次回からはオフラインで利用できます。
          </p>
        )}

        {mode === 'ocr' && ocrBusy && ocrProgress && (
          <div className="flex items-center gap-2 rounded bg-slate-800 px-3 py-1.5 text-[11px] text-cyan-100">
            <SpinnerIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 truncate">{ocrProgress.status}</span>
            <span className="tabular-nums">{Math.round(ocrProgress.progress * 100)}%</span>
          </div>
        )}

        {/* OCR結果カード: 直近の読み取り結果と、このアプリで唯一の設定（PSM・抽出フィルタ）。
            文字モードだけに属する UI であり、バーコードモードでは（処理中の状態が
            残っていても）表示しない。 */}
        {mode === 'ocr' && !ocrBusy && capturedImage && ocrInfo && (
          <div className="flex flex-col gap-2 rounded-lg bg-slate-800 p-2.5">
            <div className="flex items-center gap-2">
              <div className="shrink-0 overflow-hidden rounded border border-slate-700 bg-black">
                <CapturedImageCanvas image={capturedImage} className="h-12 w-28 object-contain" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] text-slate-500">読み取った画像</p>
                <p className="truncate text-[11px] text-slate-300">
                  {ocrInfo.ms}ms / 信頼度 {Math.round(ocrInfo.confidence)}%
                </p>
              </div>
              <button
                type="button"
                onClick={handleRetrySameImage}
                className="shrink-0 rounded bg-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-100 active:bg-slate-600"
              >
                同じ画像で再認識
              </button>
              <button
                type="button"
                onClick={handleDismissCapturedImage}
                aria-label="読み取り結果を閉じる"
                className="shrink-0 rounded-full p-1 text-slate-400 active:bg-slate-700"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>

            {maskedCount > 0 && (
              <p className="rounded bg-cyan-950/60 px-2 py-1 text-[11px] font-semibold text-cyan-200">
                バーコード {maskedCount} 箇所を除外して読み取りました
              </p>
            )}

            {/* 生テキストは常に表示し続ける。フィルタはあくまで JS側の後処理であって
                エンジンの認識結果そのものを隠さない（「実際に何が読めたか」を必ず見せる） */}
            <div className="rounded bg-slate-950 p-2">
              <p className="text-[10px] text-slate-500">生の読み取り結果</p>
              <pre className="whitespace-pre-wrap break-all font-mono text-sm text-slate-100">
                {ocrRawText === '' ? '(空文字)' : ocrRawText}
              </pre>
              {filterMode !== 'raw' && (
                <>
                  <p className="mt-1.5 text-[10px] text-slate-500">フィルタ後（{OCR_FILTER_LABELS[filterMode]}）</p>
                  <pre className="whitespace-pre-wrap break-all font-mono text-sm text-cyan-300">
                    {filteredPreview === '' ? '(空文字)' : filteredPreview}
                  </pre>
                </>
              )}
            </div>

            <div className="flex gap-2">
              <Select
                className="flex-1 min-h-9 text-xs"
                value={psm}
                onChange={(e) => setPsm(e.target.value as OcrOptions['psm'])}
                options={PSM_OPTIONS}
                aria-label="PSM選択"
              />
              <Select
                className="flex-1 min-h-9 text-xs"
                value={filterMode}
                onChange={(e) => setFilterMode(e.target.value as OcrFilterMode)}
                options={FILTER_OPTIONS}
                aria-label="抽出フィルタ"
              />
            </div>

            <Switch
              checked={autoMaskEnabled}
              onChange={handleToggleAutoMask}
              label="バーコードを自動で除外"
              hint="枠内で検出したバーコードを塗りつぶしてから読み取ります。OFFにして「同じ画像で再認識」を押すと塗りつぶさずに読み直せます。"
            />
          </div>
        )}

        {/* バーコード読み取りの異常通知。一過性のものは数秒で自動的に消え、
            自動復旧を諦めた恒久的なものだけが出続ける（上の scannerError の説明を参照）。 */}
        {scannerError && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-950/50 px-3 py-2">
            <WarningIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p className="text-[11px] font-semibold leading-relaxed text-amber-200">{scannerError}</p>
          </div>
        )}

        {/* 読み取り契機の切り替え（バーコードモード専用）。画質プリセットと同じ
            セグメント型にして、「設定はこの帯に並ぶ」という見た目の一貫性を保つ。 */}
        {mode === 'barcode' && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="shrink-0 font-semibold text-slate-400">読み取り</span>
              <div role="radiogroup" aria-label="バーコードの読み取り契機" className="flex flex-1 gap-1 rounded-lg bg-slate-800 p-0.5">
                {TRIGGER_MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={triggerMode === opt.value}
                    onClick={() => handleChangeTriggerMode(opt.value)}
                    className={`min-h-8 flex-1 rounded-md text-[11px] font-bold transition-colors ${
                      triggerMode === opt.value ? 'bg-cyan-500 text-slate-950' : 'text-slate-400 active:bg-slate-700'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="pl-[3.25rem] text-[10px] text-slate-500">
              {TRIGGER_MODE_OPTIONS.find((opt) => opt.value === triggerMode)?.hint}
            </p>
          </div>
        )}

        {/* 画質プリセット: バーコード読み取りの負荷とカメラ解像度のトレードオフ設定。
            「枠内のみ」のクロップ最適化で足りないときの保険なので、控えめな見た目にする。
            既定は「最大」（今回の精度改善を退行させないため）。 */}
        {mode === 'barcode' && (
          <div className="flex items-center gap-2 text-[11px]">
            <span className="shrink-0 font-semibold text-slate-400">画質</span>
            <div role="radiogroup" aria-label="画質" className="flex flex-1 gap-1 rounded-lg bg-slate-800 p-0.5">
              {CAPTURE_QUALITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={camera.quality === opt.value}
                  onClick={() => handleChangeQuality(opt.value)}
                  className={`min-h-8 flex-1 rounded-md text-[11px] font-bold transition-colors ${
                    camera.quality === opt.value ? 'bg-cyan-500 text-slate-950' : 'text-slate-400 active:bg-slate-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          {mode === 'barcode' && (
            <>
              {/* 「常に読む」モードでは一時停止ボタン、「長押し中だけ」モードでは
                  読み取りトリガーボタン。この2つは役割が正反対（前者は止めるため、
                  後者は動かすため）なので、同じ場所で排他に出し分ける。
                  長押しモードで一時停止ボタンを併存させると「押しているのに読めない」
                  という原因の分かりにくい行き止まりを作ってしまう。 */}
              {triggerMode === 'continuous' ? (
                <button
                  type="button"
                  onClick={() => setManualPaused((p) => !p)}
                  aria-pressed={manualPaused}
                  className={`flex min-h-14 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-bold ${
                    manualPaused ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-slate-200'
                  }`}
                >
                  {manualPaused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
                  {manualPaused ? '再開' : '一時停止'}
                </button>
              ) : (
                <button
                  type="button"
                  // 押している間だけ読み取る。onPointerDown/Up だけでなく
                  // pointercancel（システムのジェスチャ等に横取りされた場合）も必ず拾う。
                  // これを取りこぼすと押しっぱなし状態が残り、指を離しても止まらなくなる。
                  onPointerDown={handleHoldStart}
                  onPointerUp={handleHoldEnd}
                  onPointerCancel={handleHoldEnd}
                  // 長押しは Android の「テキスト選択」「コンテキストメニュー」を
                  // 誘発しやすいため、touch-none / select-none と併せて明示的に抑止する。
                  onContextMenu={(e) => e.preventDefault()}
                  aria-label="押している間だけバーコードを読み取る"
                  aria-pressed={holdActive}
                  disabled={!camera.ready}
                  className={`flex min-h-14 flex-1 touch-none select-none items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-bold transition-colors disabled:opacity-50 ${
                    holdActive ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-slate-200'
                  }`}
                >
                  <ScanIcon className="h-5 w-5" />
                  {holdActive ? '読み取り中…' : '押して読み取り'}
                </button>
              )}

              <button
                type="button"
                onClick={handleToggleRestrictToRoi}
                aria-label="バーコードを枠内だけで読み取る"
                aria-pressed={restrictToRoi}
                className={`flex min-h-14 items-center justify-center rounded-xl px-3 text-[11px] font-bold ${
                  restrictToRoi ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-slate-400'
                }`}
              >
                枠内のみ
              </button>

              <button
                type="button"
                onClick={handleToggleSound}
                aria-label="読み取り音を切り替える"
                aria-pressed={soundEnabled}
                className={`flex min-h-14 items-center justify-center rounded-xl px-3 ${
                  soundEnabled ? 'bg-slate-800 text-slate-200' : 'bg-slate-800 text-slate-500'
                }`}
              >
                {soundEnabled ? <SoundOnIcon className="h-5 w-5" /> : <SoundOffIcon className="h-5 w-5" />}
              </button>

              <button
                type="button"
                onClick={handleOpenTrimPanel}
                aria-label="バーコード値の整形ルールを設定する"
                aria-pressed={trimRules.enabled}
                className={`flex min-h-14 items-center justify-center rounded-xl px-3 text-[11px] font-bold ${
                  trimRules.enabled ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-slate-400'
                }`}
              >
                整形
              </button>
            </>
          )}

          {mode === 'ocr' && (
            <Button
              variant="primary"
              size="lg"
              loading={ocrBusy}
              disabled={helpOpen}
              onClick={handleShutterOcr}
              className="flex-1 shadow-xl"
            >
              {!ocrBusy && <ScanIcon className="h-5 w-5" />} 枠内をOCR
            </Button>
          )}

          {camera.torchSupported && (
            <button
              type="button"
              onClick={() => void camera.toggleTorch()}
              aria-label="ライトを切り替える"
              className={`flex min-h-14 items-center justify-center rounded-xl px-3 ${
                camera.torchOn ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-slate-200'
              }`}
            >
              {camera.torchOn ? <FlashIcon className="h-5 w-5" /> : <FlashOffIcon className="h-5 w-5" />}
            </button>
          )}
        </div>
      </div>

      {/* 結果一覧（新しい順） */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {results.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">まだ結果がありません</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {results.map((item) => (
              <ResultRow
                key={item.id}
                item={item}
                filterMode={filterMode}
                onCopy={handleCopyRow}
                onDelete={handleDeleteRow}
              />
            ))}
          </ul>
        )}
      </div>

      {/* フッター */}
      <div
        className="flex shrink-0 items-center gap-2 border-t border-slate-800 bg-slate-900 p-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
      >
        <span className="shrink-0 text-xs text-slate-400">{results.length}件</span>
        <Button variant="secondary" size="md" className="flex-1" disabled={results.length === 0} onClick={() => void handleCopyAll()}>
          <CopyIcon className="h-4 w-4" /> 全部コピー
        </Button>
        <Button variant="danger" size="md" className="flex-1" disabled={results.length === 0} onClick={handleClearAll}>
          クリア
        </Button>
      </div>

      {/* 使い方パネル。別チャンクなので、開くまでは読み込まれない */}
      {helpOpen && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950">
              <SpinnerIcon className="h-8 w-8 text-slate-400" />
            </div>
          }
        >
          <HelpSheet onClose={handleCloseHelp} onOpenLicenses={handleOpenLicenses} />
        </Suspense>
      )}

      {/* ライセンス情報パネル。別チャンクなので、開くまでは読み込まれない。
          使い方パネルより後ろに書いてあるが、前後関係は DOM の並び順ではなく
          LicenseSheet 側の z-[80]（使い方パネルは z-[70]）で決めている。 */}
      {licenseOpen && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950">
              <SpinnerIcon className="h-8 w-8 text-slate-400" />
            </div>
          }
        >
          <LicenseSheet onClose={handleCloseLicenses} />
        </Suspense>
      )}

      {/* 整形パネル。別チャンクなので、開くまでは読み込まれない。プレビュー欄の初期値には
          一覧にある直近のバーコード値（元の読み取り値）を渡す（無ければ空欄のまま）。 */}
      {trimPanelOpen && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950">
              <SpinnerIcon className="h-8 w-8 text-slate-400" />
            </div>
          }
        >
          <TrimPanel
            rules={trimRules}
            onChange={handleChangeTrimRules}
            previewSeed={results.find((item) => item.source === 'barcode')?.raw ?? null}
            onClose={handleCloseTrimPanel}
          />
        </Suspense>
      )}
    </div>
  )
}
