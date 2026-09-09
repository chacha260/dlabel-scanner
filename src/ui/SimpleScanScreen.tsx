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
// 設定画面などの既存機能は以前 src/ui/legacy 以下に退避してあったが、利用者の
// 判断で削除した（必要になれば git 履歴から復元できる。README「削除した機能」参照）。

import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NormalizedRect } from '../scan/barcode/types'
import { CAPTURE_QUALITY_OPTIONS, type CaptureQuality } from '../camera/quality'
import { useCamera } from '../camera/useCamera'
import { resolveZoomValue } from '../camera/zoom'
import { type RawScan, useBarcodeScanner } from '../scan/useBarcodeScanner'
import { isAnyOverlayOpen, isBarcodeScanEnabled, type BarcodeTriggerMode, type ScanMode } from '../scan/scanGating'
import { applyTrimRules, DEFAULT_TRIM_RULES, visualizeControlChars, type TrimRules } from '../scan/barcode/trim'
import { truncateForDisplay } from '../scan/barcode/truncate'
import { describeBarcodeGuardReason, type BarcodeGuardReason, type BarcodeGuardRules, type BarcodeHit } from '../scan/barcode'
import {
  loadBarcodeGuardRules,
  loadBarcodeTriggerMode,
  loadCaptureQuality,
  loadHelpSeen,
  loadOcrFilterMode,
  loadRestrictToRoi,
  loadScanMode,
  loadSoundEnabled,
  loadTrimRules,
  loadZoom,
  markHelpSeen,
  saveBarcodeGuardRules,
  saveBarcodeTriggerMode,
  saveCaptureQuality,
  saveOcrFilterMode,
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
  DEFAULT_ROI,
  isPaddleReady,
  loadPersistedBarcodeRoi,
  loadPersistedRoi,
  OCR_FILTER_LABELS,
  preparePaddle,
  recognizeCaptured,
  savePersistedBarcodeRoi,
  savePersistedRoi,
  trimBarcodeBoxesToStripes,
  type HandleId,
  type OcrFilterMode,
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

// 整形パネルも同じ理由で別チャンクにする（画面上部の共通設定バーにある「整形」
// ボタンを押すまでは読み込まれない。バーコード・OCR共通のルールを編集するパネル
// なので、モードを問わずここから開く）。
const TrimPanel = lazy(() => import('./TrimPanel'))

// 誤読ガード設定パネルも同じ理由で別チャンクにする（バーコードモード固有ブロックの
// 「誤読ガード」ボタンを押すまでは読み込まれない。TrimPanel と同様、設定項目が
// 多く共通設定バーには並べられないため専用パネルにしてある）。
const BarcodeGuardPanel = lazy(() => import('./BarcodeGuardPanel'))

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

// 「怪しい文字」をタップしたときに切り替える、字形が紛らわしい文字の相互対応表。
// OCRで特に混同されやすいと現場から報告のあった組だけに絞ってある
// （網羅的な類似字形辞書ではない。増やしたい場合はこの配列に追加するだけでよい）。
const CHAR_TOGGLE_PAIRS: readonly (readonly [string, string])[] = [
  ['1', 'I'],
  ['0', 'O'],
  ['5', 'S'],
  ['8', 'B'],
  ['2', 'Z'],
  ['6', 'G'],
  ['7', 'T'],
  ['4', 'A'],
  ['9', 'q'],
]

// 上の対応表を「どちらの向きからでも引ける」双方向マップに展開する。
const CHAR_TOGGLE_MAP: Record<string, string> = Object.fromEntries(
  CHAR_TOGGLE_PAIRS.flatMap(([a, b]) => [
    [a, b],
    [b, a],
  ]),
)

// 統一結果リストの1件。バーコード・OCR共通の形。フィールド振り分けは行わない。
type ResultItem = {
  id: number
  source: 'barcode' | 'ocr'
  raw: string // 元の読み取り値そのもの（バーコード: デコーダの生の値 / OCR: エンジンが実際に読んだ生テキスト）
  // 表示・コピー・重複判定に使う値。
  // バーコード: 読み取りを受け付けた瞬間の整形ルールを適用した結果（空文字になる場合は raw と同じ）。
  //             ルールは後から変えても過去の結果には遡って効かない（スキャン時点で確定させる）。
  // OCR: raw に、読み取りを受け付けた瞬間の整形ルール（ocrTrimRulesSnapshot）を適用した結果。
  //      バーコードと同じ「読み取った瞬間に確定」という心的モデルに揃えるための値であり、
  //      実際の表示・コピーには displayValueOf の計算結果を使う（後述のとおり、OCRは
  //      これに加えて「手直し」「フィルタ」を都度合成する必要があるため、この value 単体を
  //      直接読むことはない）。
  value: string
  format?: string
  at: number
  // OCR結果だけが持つ、「怪しい文字」をユーザーがタップで直した後の文字列。
  // raw（エンジンの生出力）は直しても一切書き換えない（常に見せ続ける方針のため）。
  // 未設定（undefined）は「まだ一度も直していない」＝raw をそのまま使う、という意味。
  correctedRaw?: string
  // OCR結果だけが持つ、この行を読み取った瞬間の整形ルールのスナップショット。
  // 整形ルールは「読み取った瞬間に確定」させる（バーコードと同じ心的モデル）ため、
  // あとから画面上部の「整形」でルールを変えても、この行の表示は変わらない。
  // バーコードは value に結果を1回だけ焼き込んで終わりだが、OCRは焼き込んだ後に
  // 「怪しい文字」の手直しが起きうるため、手直し後の raw に対して整形をかけ直す必要があり、
  // そのために使うルールをこのスナップショットとして持たせている（trimRulesRef.current の
  // “今の値”を使ってしまうと、手直しのたびに最新のルールが遡って効いてしまうため）。
  ocrTrimRulesSnapshot?: TrimRules
}

// 表示用の値を求める。
//
// バーコード: 整形済みの value をそのまま返す（読み取った瞬間に確定済みで、以後は
//             不変。フィルタのように毎回計算し直すものではない）。
//
// OCR: 次の3段階を、この順序で合成する。
//   1. 手直し（correctedRaw、無ければ raw）: 字形の紛らわしい文字をタップで直した後の
//      文字列。これはエンジンの生テキストの「文字の中身」だけを直すもので、文字数・
//      並びは変わらない。
//   2. 整形（ocrTrimRulesSnapshot による applyTrimRules）: 前後の余分な部分を切り出す。
//   3. 文字種フィルタ（filterMode による applyOcrFilter）: 数字のみ/英数字のみを抽出する。
// 整形を先・フィルタを後にしているのは、フィルタ（特に「数字のみ」「英数字のみ」）が
// 空白や記号を落としてしまうと、整形の cutFrom/cutUpTo が探している区切り文字
// （スペースや GS など）自体が消えてしまい、区切り位置を見つけられなくなるため。
// 「まず読み取った値から必要な範囲を切り出し、その上で文字種を絞り込む」という
// 順序でなければ、整形ルールが意図通りに機能しない。
// フィルタだけは filterMode の切り替えに即座に追従させたいので、ここで都度計算する
// （整形は既に発生した「読み取り」という出来事に対する後処理、フィルタは「今どう見たいか」
// という表示の好みなので、性質が違う。整形はスナップショットで固定し、フィルタは
// 常に最新の選択を使う、という非対称な扱いをしているのはこのため）。
function displayValueOf(item: ResultItem, filterMode: OcrFilterMode): string {
  if (item.source !== 'ocr') return item.value
  const corrected = item.correctedRaw ?? item.raw
  const trimmed = applyTrimRules(corrected, item.ocrTrimRulesSnapshot ?? DEFAULT_TRIM_RULES)
  return applyOcrFilter(trimmed, filterMode)
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

// 「生の読み取り結果」を1文字ずつ描画し、字形が紛らわしい文字（CHAR_TOGGLE_MAPに
// 載っている文字）をタップ可能にする。
//
// 以前は agreement.ts の判定（文字ごとの信頼度 / 2パス照合）で「怪しい」と
// 判定された文字だけをタップ可能にし、それ以外は普通のテキストとして表示していた。
// tesseract.js を削除して ML Kit 1本にした結果、判定材料のうち文字ごとの信頼度
// （judgeByConfidence）は完全に成立しなくなった（ML Kit は信頼度を一切返さない）。
// 「どの文字が怪しいか」を機械が教えてくれなくなった以上、"怪しい文字だけ直せる"
// という絞り込みは維持できない。そこで方針を「機械が怪しいと言った文字だけ直せる」
// から「**人がどこでも直せる**」へ広げる: 対応表に載っている文字（字形が紛らわしいと
// 現場から報告のあった文字）は、怪しいかどうかに関わらずすべてタップ可能にする。
// 誤って正しい文字を切り替えてしまっても、もう一度タップすれば元に戻るため実害は無い。
//
// correctedChars は「タップで直した後」の文字配列（生テキストと同じ並び）。
// 生テキスト自体は書き換えない（このアプリの確定方針: エンジンの生出力は
// 常に別行で見せ続ける）ため、直した結果はこの配列にだけ反映し、呼び出し側が
// 一覧行の value に反映する。
function OcrRawTextView({
  text,
  correctedChars,
  onToggleChar,
}: {
  text: string
  correctedChars: string[] | null
  onToggleChar: (index: number) => void
}) {
  const chars = Array.from(text)

  // correctedChars が無い（結果自体が無い）場合はタップ機能ごと出さず、ただのテキスト。
  if (correctedChars === null || correctedChars.length !== chars.length) {
    return <>{text}</>
  }

  return (
    <>
      {chars.map((original, index) => {
        const shown = correctedChars[index] ?? original
        const swapTarget = CHAR_TOGGLE_MAP[shown]
        if (!swapTarget) {
          // 対応表に無い文字（数字・英字以外や対象外の字形）はタップできない、ただの文字。
          return <span key={index}>{shown}</span>
        }
        return (
          <button
            key={index}
            type="button"
            onClick={() => onToggleChar(index)}
            aria-label={`${shown} を ${swapTarget} に切り替える`}
            style={{ font: 'inherit', color: 'inherit' }}
            className="rounded px-0.5 underline decoration-dotted decoration-slate-500 underline-offset-2 active:bg-slate-700"
          >
            {shown}
          </button>
        )
      })}
    </>
  )
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

  // バーコードの誤読ガード設定（scan/barcode/guards.ts）。前回設定していた内容を
  // 次回起動時も復元する。整形ルールと違い useBarcodeScanner 側に直接渡す設定
  // （フレームループが ref 経由で読む）なので、こちら側で ref を持つ必要はない。
  const [barcodeGuardRules, setBarcodeGuardRules] = useState<BarcodeGuardRules>(loadBarcodeGuardRules)
  const handleChangeBarcodeGuardRules = useCallback((next: BarcodeGuardRules) => {
    setBarcodeGuardRules(next)
    saveBarcodeGuardRules(next)
  }, [])

  // 誤読ガードパネル。TrimPanel と同様、全画面でカメラが見えなくなるため
  // isAnyOverlayOpen 経由でバーコード検出を止める（下の overlaysOpen を参照）。
  const [guardPanelOpen, setGuardPanelOpen] = useState(false)
  const handleOpenGuardPanel = useCallback(() => setGuardPanelOpen(true), [])
  const handleCloseGuardPanel = useCallback(() => setGuardPanelOpen(false), [])

  // 誤読ガードで棄却されたヒットの通知。既存の showToast で短く出す。
  // 現場の人が次に何をすればよいか分かる文言は describeBarcodeGuardReason
  // （guards.ts）に集約してあり、ここでは呼ぶだけにする（トーストとヘルプ文言とで
  // 表現がずれないようにするため）。連打防止は useBarcodeScanner 側（dedupeMs）が
  // 既に行っているため、ここでは受け取ったら毎回そのまま出すだけでよい。
  const handleRejectHit = useCallback((_hit: BarcodeHit, reason: BarcodeGuardReason) => {
    showToast(describeBarcodeGuardReason(reason), 'error')
  }, [])

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
  // confidence は PaddleOCR が CTC の確率から算出した本物の値なので、
  // そのまま画面に出せる（types.ts の OcrResult.confidence のコメント参照）。
  const [ocrInfo, setOcrInfo] = useState<{ ms: number; confidence: number } | null>(null)
  const [ocrRawText, setOcrRawText] = useState<string | null>(null)
  // 怪しい文字をタップで直した後の文字列（1文字ずつの配列。ocrRawText と同じ並び）。
  // null は「まだ結果が無い」を表す。生テキスト（ocrRawText）そのものは書き換えない
  // （エンジンの生出力を常に見せ続ける、というこのアプリの確定方針のため）。
  //
  // 以前はここに「どの文字が怪しいか」の自動判定結果（agreement.ts の CharVerdict[]）も
  // 持っていたが、ML Kit は信頼度を返さないため自動判定自体が成立しなくなった
  // （OcrRawTextView のコメント参照）。判定が無い代わりに、対応表に載っている文字は
  // すべてタップ可能にしたので、この state だけで足りる。
  const [correctedChars, setCorrectedChars] = useState<string[] | null>(null)
  // 現在表示中のOCR結果カードに対して「読み取った瞬間」に確定させた整形ルールの
  // スナップショット。結果カードの「整形・フィルタ後」プレビューは、怪しい文字を
  // タップで直した後の生テキストに対してもこのスナップショットで整形をかけ直す
  // 必要があるため（displayValueOf・ResultItem.ocrTrimRulesSnapshot と同じ理由）、
  // trimRulesRef.current（今の設定）ではなくこの state を使う。
  const [ocrTrimSnapshot, setOcrTrimSnapshot] = useState<TrimRules | null>(null)
  // 直近にappendResultした「OCR結果」行のid。怪しい文字をタップで直したとき、
  // 結果一覧の該当行にも反映するために使う（一覧は積みっぱなしで遡って書き換えないのが
  // 基本方針だが、これは「直前に読んだその場の結果を、読んだその場で直す」操作であり、
  // 過去の別の読み取り結果を書き換えるものではない）。
  const lastOcrResultIdRef = useRef<number | null>(null)
  // シャッターを押した瞬間に確定させた「実際に OCR へ渡す画像」。結果が出たあとも
  // ユーザーが消すか次のシャッターを押すまで表示し続け、同じ画像での再認識にも使う。
  const [capturedImage, setCapturedImage] = useState<ImageData | null>(null)

  // 結果カード内だけの設定（このアプリで唯一の設定面）。前回の選択を次回起動時にも
  // 復元する（loadScanMode 等、他の設定の読み方と同じ流儀）。
  const [filterMode, setFilterMode] = useState<OcrFilterMode>(loadOcrFilterMode)

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

  // 戻り値の id は、OCR結果の呼び出し元（runRecognition）が「怪しい文字を後から
  // 直したとき、一覧のどの行に書き戻すか」を覚えておくために使う。
  // ocrTrimRulesSnapshot は OCR結果にだけ渡す（バーコードは value に整形結果を
  // 直接焼き込んでしまうので、スナップショットを別途持つ必要がない）。
  const appendResult = useCallback(
    (source: ResultItem['source'], raw: string, value: string, format?: string, ocrTrimRulesSnapshot?: TrimRules) => {
      const id = nextIdRef.current++
      const item: ResultItem = { id, source, raw, value, format, at: Date.now(), ocrTrimRulesSnapshot }
      // ref を state の反映（effect）まで待たずにここで更新する。
      // 待つと、その間に届いたフレームで同じ値が二重に追加され得るため。
      resultsRef.current = [item, ...resultsRef.current]
      setResults((prev) => [item, ...prev])
      return id
    },
    [],
  )

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

  // この画面に実在するオーバーレイは「OCR結果カード」「使い方パネル」「整形パネル」
  // 「誤読ガード設定パネル」の4つ（一覧・確認ダイアログ・プロファイル選択などは
  // この画面には存在しない）。isAnyOverlayOpen は汎用の純粋関数のまま流用し、
  // 渡すフラグだけを実在するものに絞る。
  // OCR結果カードで止めるのは「認識処理中」だけにする。結果カードはカメラ映像の下に
  // 並ぶだけで視界を塞がないため、表示されている間ずっと検出を止めると
  // 一度 OCR しただけでバーコードが読めなくなってしまう。
  // 使い方パネル・整形パネル・誤読ガードパネルはどれも全画面表示で
  // カメラがどこを向いているか分からなくなるため、開いている間は常にバーコード検出を止める。
  // 誤読ガードパネル（guardPanelOpen）はフラグを増やさず、TrimPanel と
  // 「設定項目が多いのでカメラ映像を覆う専用パネルにする」という性質が完全に同じ
  // trimPanelOpen に OR して流し込む。
  const overlaysOpen = useMemo(
    () =>
      isAnyOverlayOpen({
        ocrResultPanelOpen: ocrBusy,
        helpOpen,
        trimPanelOpen: trimPanelOpen || guardPanelOpen,
        licenseOpen,
      }),
    [ocrBusy, helpOpen, trimPanelOpen, guardPanelOpen, licenseOpen],
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
    // 誤読ガード（scan/barcode/guards.ts）。ルールは ref 経由で読まれるため、
    // パネルで設定を変えるたびにフレームループが張り直されることはない。
    guardRules: barcodeGuardRules,
    onReject: handleRejectHit,
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

  // 認識前にPaddleOCRが使える状態かを確認する共通ヘルパー。
  // PaddleOCRは約35MBのモデル・wasmを初回だけ非同期で読み込む必要があり、
  // 読み込み中は進捗を利用者に見せたい（でないと「反応が無い」ように見えて
  // 不安になる）。preparePaddle は仕様としてrejectしない
  // （{ ok: true } | { ok: false, error } を返す）ため、ここで ok: false を
  // 握りつぶさずエラートーストで見せて中断する（README「2. APK版で OCR が
  // まるごと使えなかった」の教訓＝catch {} で黙って壊れるのを避ける、という
  // 方針に合わせる）。
  // 既に isPaddleReady() が true（一度読み込み済み）なら、案内を出さずそのまま true を返す。
  const ensureEngineReady = useCallback(async (): Promise<boolean> => {
    if (isPaddleReady()) return true
    const prepared = await preparePaddle((status) => showToast(status, 'info'))
    if (!prepared.ok) {
      showToast(prepared.error, 'error')
      return false
    }
    return true
  }, [])

  // 実際に認識にかけている ImageData を渡して結果一覧に積む共通処理。
  // シャッター押下の初回認識・「同じ画像で再認識」のいずれからも呼ぶ。
  //
  // 以前はここに「丁寧に読む」(ocrCareful) がONのときの2パス目（別PSMで再認識し、
  // 食い違いを検出する）ロジックがあったが、ML Kit にはPSMという概念自体が無いため
  // 「別のPSMで」という前提が丸ごと成立しなくなった。前処理を変えた2パス
  // （素の画像 vs コントラスト補正）として作り直すのは別の作業として、ここでは
  // いったん単純な1パスに戻す（compareOcrPasses / mergeVerdicts は agreement.ts に
  // 残してあるので、作り直す際にそのまま使える）。
  const runRecognition = useCallback(
    (image: ImageData) => {
      setOcrBusy(true)

      void recognizeCaptured(image)
        .then((result) => {
          setOcrInfo({ ms: result.ms, confidence: result.confidence })
          setOcrRawText(result.text)
          setCorrectedChars(Array.from(result.text))
          // 整形ルールは「読み取りを受け付けた瞬間」に確定させる（バーコードの
          // handleScan と同じ考え方）。ref から今の設定を1回だけ読み、この結果カード・
          // 一覧行の両方でずっとこのスナップショットを使い続ける。
          const trimSnapshot = trimRulesRef.current
          setOcrTrimSnapshot(trimSnapshot)

          if (result.text.trim().length === 0) {
            lastOcrResultIdRef.current = null
            showToast('文字を読み取れませんでした', 'error')
          } else {
            const trimmedValue = applyTrimRules(result.text, trimSnapshot)
            lastOcrResultIdRef.current = appendResult('ocr', result.text, trimmedValue, undefined, trimSnapshot)
          }
        })
        .catch((err: unknown) => {
          showToast(err instanceof Error ? err.message : 'OCRに失敗しました', 'error')
        })
        .finally(() => {
          setOcrBusy(false)
        })
    },
    [appendResult],
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
    setCorrectedChars(null)
    setOcrTrimSnapshot(null)
    lastOcrResultIdRef.current = null
    setOcrBusy(true)

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
      .then(async (boxes) => {
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

        // まだモデル未読み込みなら、ここで初めて読み込みが走る。約35MBあるため
        // ensureEngineReady 内で進捗をトーストで見せる。読み込みに失敗した場合は
        // ここで中断し、runRecognition（＝ocrBusyを降ろすfinally）を呼ばないので、
        // 自分でocrBusyを降ろす必要がある。
        const ready = await ensureEngineReady()
        if (!ready) {
          setOcrBusy(false)
          return
        }
        // runRecognition は自身の finally で ocrBusy を降ろすので、ここでは降ろさない
        runRecognition(image)
      })
      .catch(() => {
        showToast('画像の取り込みに失敗しました', 'error')
        setOcrBusy(false)
      })
  }, [
    ocrBox.isDragging,
    ocrBox.roi,
    helpOpen,
    camera.videoRef,
    camera.ready,
    detectBoxes,
    autoMaskEnabled,
    ensureEngineReady,
    runRecognition,
  ])

  // 撮影しなおさず、現在のマスク設定で同じ静止フレームを読み直す
  // （フィルタはここでは無関係）。マスクON/OFFの切り替え後の比較にもこれを使う。
  const handleRetrySameImage = useCallback(() => {
    const captured = capturedFrameRef.current
    if (!captured) return
    const maskRects = autoMaskEnabled ? captured.maskRects : []
    const image = cropVideoSpaceRoi(captured.frame, captured.videoRoi, maskRects.length > 0 ? maskRects : undefined)
    setCapturedImage(image)
    setMaskedCount(maskRects.length)
    setOcrBusy(true)
    void ensureEngineReady().then((ready) => {
      if (!ready) {
        setOcrBusy(false)
        return
      }
      runRecognition(image)
    })
  }, [autoMaskEnabled, ensureEngineReady, runRecognition])

  const handleDismissCapturedImage = useCallback(() => {
    setCapturedImage(null)
    setOcrInfo(null)
    setOcrRawText(null)
    setCorrectedChars(null)
    setOcrTrimSnapshot(null)
    lastOcrResultIdRef.current = null
    setMaskedCount(0)
    capturedFrameRef.current = null
  }, [])

  const handleToggleAutoMask = useCallback((checked: boolean) => {
    setAutoMaskEnabled(checked)
  }, [])

  const handleChangeFilterMode = useCallback((next: OcrFilterMode) => {
    setFilterMode(next)
    saveOcrFilterMode(next)
  }, [])

  // 怪しい文字をタップしたときの相互切り替え（例: 1 ↔ I）。対応表に無い文字は
  // 呼び出し側（OcrRawTextView）でそもそもタップできないようにしてあるが、
  // ここでも undefined を弾いて安全側に倒す。
  // 直した結果は correctedChars（表示用）と、直前に積んだ一覧行の value（コピー用）の
  // 両方に反映する。過去の別の読み取り結果を書き換えることはない
  // （lastOcrResultIdRef は「今表示している結果カードの、その1行」だけを指す）。
  const handleToggleChar = useCallback((index: number) => {
    setCorrectedChars((prev) => {
      if (!prev) return prev
      const current = prev[index]
      const swapped = CHAR_TOGGLE_MAP[current]
      if (!swapped) return prev
      const next = [...prev]
      next[index] = swapped
      const correctedRaw = next.join('')
      const targetId = lastOcrResultIdRef.current
      if (targetId !== null) {
        setResults((prevResults) =>
          prevResults.map((item) => (item.id === targetId ? { ...item, correctedRaw } : item)),
        )
      }
      return next
    })
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

  // OCR結果カードに表示する「整形・フィルタ後」プレビュー（生テキストは常に別行で
  // 見せ続ける）。怪しい文字をタップで直していた場合は、直した後の文字列に対して
  // 整形→フィルタの順で適用する（一覧・コピーに使う値と表示を一致させるため。
  // displayValueOf と同じ考え方・同じ順序。整形を先にする理由もそちらのコメント参照）。
  const correctedRawText = correctedChars !== null ? correctedChars.join('') : ocrRawText
  const trimmedPreviewText =
    correctedRawText !== null ? applyTrimRules(correctedRawText, ocrTrimSnapshot ?? DEFAULT_TRIM_RULES) : null
  const filteredPreview = trimmedPreviewText !== null ? applyOcrFilter(trimmedPreviewText, filterMode) : null

  // 今のモードが持っている枠（表示・ドラッグの対象）
  const activeBox = mode === 'ocr' ? ocrBox : barcodeBox

  // ROI枠を描画するか。文字（OCR）モードでは枠が常に「OCRの対象そのもの」を
  // 表すため、常に表示する。バーコードモードで「枠内のみ」がOFFのときは、
  // 読み取り対象が画面全体になり枠に意味が無くなる（枠の外側が暗いままだと、
  // 画面全体が対象なのに枠外が読めなさそうに見えて紛らわしい、という現場指摘）ため、
  // 枠線・四隅のマーカー・リサイズハンドル・枠上のラベル・枠外を暗くする
  // boxShadow をまとめて描画自体をやめる（枠を透明にするだけだと当たり判定や
  // ラベルが残ってしまうため、丸ごと描画しないのが最も分かりやすい）。
  const showRoiBox = mode === 'ocr' || restrictToRoi

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

      {/* 共通設定バー: バーコード・OCRの両方に関わる「設定」（一度決めたらしばらく
          変えないもの）だけをここに集約する。
          置き分けの原則（現場フィードバックを踏まえて定めたもの）:
            - 設定（一度決めたらしばらく変えないもの）      → ここ、モード切替の直下
            - その場の操作（読み取りのたびに押すもの）        → 従来どおり下部の操作行
          この原則に従うと、画質・整形は「設定」なのでここに置き、トーチ・一時停止／
          押して読み取り・シャッターは「その場の操作」なので下部に残る。
          「枠内のみ」「読み取り音」「読み取り契機」はバーコードの読み取り挙動そのものを
          変える設定で OCR には関係が無いため、バーコードモード固有のブロックに残す。
          モードを切り替えてもこのバーの位置・中身は変わらない（切り替えるたびにボタンの
          位置が動くと押し間違いのもとになるため、あえてモード切替の直下という固定位置に
          常に同じ内容を置く）。
          - 画質: 以前はバーコードモードにしか出していなかったが、カメラの取得解像度は
            OCRの精度にも直接効くため、共通設定に格上げした。
          - 整形: バーコード・OCRで共有する整形ルール（TrimRules）を編集する入口。
            ルールが1つに統合されたので、設定の置き場所も1つに統合する。 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-900 px-2 py-1.5">
        <span className="shrink-0 text-[11px] font-semibold text-slate-400">画質</span>
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
        <button
          type="button"
          onClick={handleOpenTrimPanel}
          aria-label="読み取り値の整形ルールを設定する"
          aria-pressed={trimRules.enabled}
          className={`flex min-h-8 shrink-0 items-center justify-center rounded-lg px-3 text-[11px] font-bold ${
            trimRules.enabled ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-slate-300'
          }`}
        >
          整形
        </button>
      </div>

      {/* カメラ映像（画面上部） */}
      <div ref={previewRef} className="relative shrink-0 overflow-hidden bg-black" style={{ height: '42vh' }}>
        <video ref={camera.videoRef} autoPlay muted playsInline className="absolute inset-0 h-full w-full object-cover" />

        {!camera.error && showRoiBox && (
          <div
            // バーコードモード: 「枠内のみ」ON時はこの枠がバーコードの採否を決めるため実線・
            // 明るめにする（OFF時はそもそもこの枠を描画しないので、この分岐に来るのは
            // 常に「枠に意味がある」状態のときだけ。文字モードでは枠は常にOCRの対象
            // そのものなので常に実線）。
            className="absolute touch-none rounded-lg border-2 border-cyan-300"
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
            {/* 枠が「何のための枠か」を一目で分かるようにする小さなラベル（枠のすぐ上）。
                この分岐に来るのは常に「枠内のみ」ONのバーコードモードか文字モードなので、
                「読み取り範囲: 画面全体」という文言はもう出番が無い（枠自体が無いため）。 */}
            {!ocrBusy && (
              <span className="pointer-events-none absolute -top-5 left-0 rounded bg-slate-900/85 px-1.5 py-0.5 text-[9px] font-semibold text-cyan-200">
                {mode === 'ocr' ? '文字を囲む' : '読み取り範囲: 枠内のみ'}
              </span>
            )}

            {/* バーコードモード: 一覧に既にある値を検出したときの、静かな「読み取り済み」通知。
                追加はされない代わりに、枠の中央に短く表示するだけに留める（連打はしない）。
                「枠内のみ」OFF時はこの枠自体が無いため、その場合の通知はプレビュー領域
                中央に表示する（下の showRoiBox === false の分岐を参照）。 */}
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

        {/* バーコードモードで「枠内のみ」がOFFのとき（＝枠を描画していないとき）の
            「読み取り済み」通知の代わりの置き場所。枠が無いのでプレビュー領域全体の
            中央に出す（枠がある場合の見た目・位置は上の分岐のままで変えていない）。 */}
        {!camera.error && !showRoiBox && duplicateHintVisible && (
          <span className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-slate-900/90 px-3 py-1.5 text-xs font-bold text-amber-300 shadow-lg">
            読み取り済み
          </span>
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

        {/* 枠が表示されていない（バーコードモードで「枠内のみ」OFF）ときは、
            リセットする対象の枠自体が見えていないため、このボタンも隠す。 */}
        {!camera.error && showRoiBox && (
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

      {/* コントロール（設定・バナー・結果カード）: 独立スクロール領域。
          以前はここ全体が1つの `shrink-0` コンテナで、overflow の指定も
          無かった。そのため中身（特にOCR結果カード）が想定より高くなると、
          画面全体（`flex h-full flex-col`）の中でこのコンテナだけが伸び続け、
          その下の結果一覧・フッターを画面外へ押し出し、しかも押し出された先は
          スクロール領域ではないため二度と触れなくなる、という実機バグが起きた。

          最初の修正では「シャッター行をこのコンテナの中に残したまま、
          コンテナ自体は `shrink-0` のまま `max-h-[32vh]` の上限だけ足す」形に
          したが、これは不十分だった。ルートの子（この画面全体）のうち
          結果一覧（`min-h-0 flex-1`）以外は全部 `shrink-0` で、`shrink-0` は
          「余っても伸びないが、足りなくても縮まない」という意味である。
          画面高さを H とすると、`shrink-0` な部分（上部バー約80px＋共通設定バー
          約48px＋カメラプレビュー `0.42H`＋コントロール最大`0.32H`＋シャッター行
          約80px＋フッター約68px）の合計は `276 + 0.74H` で、これが H を超えない
          条件は H ≧ 1062px（CSS px）しかない。実機は 3264px物理 / DPR約2.75 ≒
          1187 CSS px でぎりぎり足りていたが、そのとき結果一覧は実質0pxになり
         （読み取った値が1件も見えない）、これより背の低い端末では今度は
          シャッターやフッターがまた画面外へ押し出される。`max-h` は「中身が
          少ないときに広がりすぎない上限」でしかなく、**「足りないときに縮む」
          ことは別途保証しないと、`shrink-0` を積み上げた時点で足し算が
          破綻する**、というのがこの再発の教訓である。

          そこで構造を次のように直した。
          1. シャッター行はこのコンテナの外へ出し、ルート直下の兄弟（`shrink-0`）
             にした（すぐ下を参照）。これによりシャッター行の高さは上の計算の
             「常に確保される固定分」に含まれ、コントロール側がどれだけ縮んでも
             視覚的に切れることがない。
          2. このコンテナ自身は `shrink-0` を外し、`min-h-0` を付けて縮められる
             ようにした（`max-h-[28vh]` は上限のみを規定し、下限は規定しない）。
             画面が狭いときはこのコンテナが真っ先に縮み、内部は
             `overflow-y-auto overscroll-contain` でスクロールして中身を見せる。
          3. 結果一覧（下）に `min-h-[4.5rem]`（約2行ぶん）を与え、どれだけ
             コントロールが伸びても「読み取った値が1件も見えない」状態には
             ならないようにした。

          この構造での「画面に必ず収まる条件」を検算する。縮まない
          （`shrink-0`、または明示した最小値を持つ）部分だけを固定分として足すと:
            上部バー(約80px) + 共通設定バー(約48px) + カメラプレビュー(0.42H)
            + シャッター行(約80px) + フッター(約68px) + 結果一覧の最小高さ(約72px)
            = 348 + 0.42H
          コントロール自身は縮んで0になり得るので計算に入れない（その代わり
          スクロールで中身へアクセスできる）。348 + 0.42H ≦ H を解くと
          0.58H ≧ 348 → H ≧ 約600px となり、現実のどのスマートフォンでも
          成立する（この 600px という数字、もしくは上の各定数を変えるときは、
          この式を書き直して両辺の関係が保たれることを必ず確認すること）。 */}
      <div className="flex min-h-0 max-h-[28vh] flex-col gap-2 overflow-y-auto overscroll-contain border-b border-slate-800 bg-slate-900 p-3">
        {/* OCR結果カード: 直近の読み取り結果と、抽出フィルタ・バーコード自動除外の
            設定。文字モードだけに属する UI であり、バーコードモードでは
            （処理中の状態が残っていても）表示しない。
            以前はここに「OCRエンジン」（Tesseract/ML Kit/PaddleOCR）の切り替え、
            PSM選択、「丁寧に読む」トグル、「精密読み取り」ボタンもあったが、
            最終的にエンジンをPaddleOCR 1つに絞ったため、選ぶ余地の無いこれらの
            UI はすべて削除した（README「OCR まわりの修正履歴」参照）。 */}
        {mode === 'ocr' && !ocrBusy && capturedImage && ocrInfo && (
          <div className="flex flex-col gap-2 rounded-lg bg-slate-800 p-2.5">
            {/* 1段目: サムネイルとテキストだけの行。以前はこの行に操作ボタンも
                並べていたが、「同じ画像で再認識」「設定を比較」「×」（比較機能は
                その後削除）が全部揃うとボタン側の合計幅（shrink-0）だけで実機の画面幅を超えてしまい、
                隣の `flex-1 min-w-0` のテキスト列が「潰れて残る」ことを選んだ結果、
                幅ゼロ近くまで押し潰されて1文字ずつ縦に並ぶ崩れ方をしていた
                （`flex-wrap` はテキスト列自身の折り返しは助けてくれない）。
                ボタンをこの行から追い出し、テキスト列の隣に shrink-0 の兄弟を
                置かないことで、この行は絶対に潰れない。 */}
            <div className="flex items-center gap-2">
              <div className="shrink-0 overflow-hidden rounded border border-slate-700 bg-black">
                <CapturedImageCanvas image={capturedImage} className="h-12 w-28 object-contain" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] text-slate-500">読み取った画像</p>
                {/* confidence は PaddleOCR が CTC の確率から算出した本物の値なので、
                    そのまま実数値を出す（types.ts の OcrResult.confidence参照）。 */}
                <p className="truncate text-[11px] text-slate-300">
                  PaddleOCR / {ocrInfo.ms}ms / 信頼度 {Math.round(ocrInfo.confidence)}%
                </p>
              </div>
            </div>

            {/* 2段目: 操作ボタン群。テキストと同じ行に置かず `flex-wrap` だけで
                並べているため、画面が狭くて全部は入りきらないときは
                「テキストが潰れる」のではなく「ボタンが折り返される」側に倒れる
                （日本語ラベルが長い「同じ画像で再認識」でも同様）。
                × （閉じる）だけは押し間違い防止のため `ml-auto` で右端に離し、
                他の操作ボタンから独立させている（見た目はこれまで通りアイコン
                のみ・小さめのまま）。 */}
            <div className="flex flex-wrap items-center gap-2">
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
                className="ml-auto shrink-0 rounded-full p-1 text-slate-400 active:bg-slate-700"
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
                エンジンの認識結果そのものを隠さない（「実際に何が読めたか」を必ず見せる）。
                下線付きの文字はタップすると紛らわしい字形の候補（1↔I、0↔O など）に
                切り替えられる。直した結果はフィルタ後の表示・一覧・コピーにそのまま
                反映される（元の生テキストの並びはこの表示上でしか変わらず、エンジンが
                実際に返した文字自体はここでも常に見えている）。 */}
            <div className="rounded bg-slate-950 p-2">
              <p className="text-[10px] text-slate-500">生の読み取り結果</p>
              <pre className="whitespace-pre-wrap break-all font-mono text-sm text-slate-100">
                {ocrRawText === '' ? (
                  '(空文字)'
                ) : (
                  <OcrRawTextView
                    text={ocrRawText ?? ''}
                    correctedChars={correctedChars}
                    onToggleChar={handleToggleChar}
                  />
                )}
              </pre>
              {/* 以前はエンジンが返す文字ごとの信頼度や2パス照合で「怪しい」と判定された
                  文字だけをこの注記付きで案内していたが、ML Kit は信頼度を返さないため
                  その判定自体が無くなった。どの文字が怪しいか機械には分からない以上、
                  下線付きの文字（＝対応表に載っている、字形が紛らわしい文字）は
                  すべてタップできる、という案内に変えている（OcrRawTextView参照）。 */}
              {correctedChars !== null && correctedChars.length > 0 && (
                <p className="mt-1 text-[10px] text-slate-500">
                  下線の付いた文字はタップすると候補（1↔I、0↔Oなど）に切り替えられます。
                </p>
              )}
              {/* 整形（ocrTrimSnapshot.enabled）またはフィルタ（filterMode !== 'raw'）の
                  どちらかが効いていれば、生テキストとは違う値になり得るので分けて見せる。
                  整形だけが効いていてフィルタが「フィルタなし」のときも、この行が
                  「一覧に積まれる実際の値」を代表する（displayValueOf と同じ計算）。 */}
              {(filterMode !== 'raw' || (ocrTrimSnapshot?.enabled ?? false)) && (
                <>
                  <p className="mt-1.5 text-[10px] text-slate-500">
                    整形・フィルタ後{filterMode !== 'raw' && `（${OCR_FILTER_LABELS[filterMode]}）`}
                  </p>
                  <pre className="whitespace-pre-wrap break-all font-mono text-sm text-cyan-300">
                    {filteredPreview === '' ? '(空文字)' : filteredPreview}
                  </pre>
                </>
              )}
            </div>

            <Select
              className="min-h-9 text-xs"
              value={filterMode}
              onChange={(e) => handleChangeFilterMode(e.target.value as OcrFilterMode)}
              options={FILTER_OPTIONS}
              aria-label="抽出フィルタ"
            />

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

        {/* 誤読ガード設定への入口（バーコードモード専用）。設定項目が多いため
            共通設定バーの「整形」と同じ流儀で専用パネルへ切り出してあるが、
            OCRには関係しない設定なのでバーコードモード固有ブロックに置く。 */}
        {mode === 'barcode' && (
          <div className="flex items-center gap-2 text-[11px]">
            <span className="shrink-0 font-semibold text-slate-400">誤読対策</span>
            <button
              type="button"
              onClick={handleOpenGuardPanel}
              className="flex min-h-8 flex-1 items-center justify-center rounded-lg bg-slate-800 px-3 text-[11px] font-bold text-slate-200 active:bg-slate-700"
            >
              誤読ガードを設定
            </button>
          </div>
        )}

        </div>

      {/* シャッター行。ルート直下の兄弟（`shrink-0`）として上のコントロール
          スクロール領域の外に出してある。コントロール側が `min-h-0` で縮む
          構造になった以上、シャッターは「縮まない別の要素」として独立させて
          おかないと、コントロールと一緒に潰れて見えなくなる／逆にコントロール
          側が伸びたときに画面外へ押し出される、のどちらの事故も起き得る
         （検算は上のコメントを参照）。 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-t border-slate-800 bg-slate-900 p-3">
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
            </>
          )}

          {mode === 'ocr' && (
            <Button
              variant="primary"
              size="lg"
              loading={ocrBusy}
              // PaddleOCRはブラウザでもAPKでも同じように動くため、環境を理由に
              // 無効化する必要はない（未読み込みなら handleShutterOcr 内の
              // ensureEngineReady が読み込んでから進める）。押せない理由として
              // 残っているのは「使い方パネルを開いている間」の誤操作防止だけ。
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

      {/* 結果一覧（新しい順）。`min-h-[4.5rem]`（約2行ぶん）は、上のコントロールが
          `min-h-0` で縮められるようになったことに対応する下限。無いままだと
          `flex-1`（basis 0）は上が詰まったときに高さ0まで縮み得るため、
          「読み取った値が1件も見えない」状態になってしまう（この最小高さの
          根拠となる足し算は、上のコントロールのコメントに書いた検算を参照）。 */}
      <div className="min-h-[4.5rem] flex-1 overflow-y-auto overscroll-contain">
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

      {/* 整形パネル。別チャンクなので、開くまでは読み込まれない。バーコード・OCR共通の
          ルールを編集するパネルなので、プレビュー欄の初期値には一覧にある直近の結果
          （バーコード・OCRどちらでも可。一覧は新しい順なので先頭 = 直近）の元の読み取り値を
          渡す（無ければ空欄のまま）。 */}
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
            previewSeed={results[0]?.raw ?? null}
            onClose={handleCloseTrimPanel}
          />
        </Suspense>
      )}

      {/* 誤読ガード設定パネル。別チャンクなので、開くまでは読み込まれない。 */}
      {guardPanelOpen && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950">
              <SpinnerIcon className="h-8 w-8 text-slate-400" />
            </div>
          }
        >
          <BarcodeGuardPanel
            rules={barcodeGuardRules}
            onChange={handleChangeBarcodeGuardRules}
            onClose={handleCloseGuardPanel}
          />
        </Suspense>
      )}

    </div>
  )
}
