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

import type { CSSProperties } from 'react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RawScan } from '../parse/types'
import type { NormalizedRect } from '../scan/barcode/types'
import { CAPTURE_QUALITY_OPTIONS, type CaptureQuality } from '../camera/quality'
import { useCamera } from '../camera/useCamera'
import { resolveZoomValue } from '../camera/zoom'
import { useBarcodeScanner } from '../scan/useBarcodeScanner'
import { isAnyOverlayOpen, isBarcodeScanEnabled, type ScanMode } from '../scan/scanGating'
import {
  loadCaptureQuality,
  loadHelpSeen,
  loadRestrictToRoi,
  loadScanMode,
  loadSoundEnabled,
  loadZoom,
  markHelpSeen,
  saveCaptureQuality,
  saveRestrictToRoi,
  saveScanMode,
  saveSoundEnabled,
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

// 「読み取り済み」通知の連打防止だけに使う短い時間窓（ミリ秒）。追加の可否
// （＝一覧に同じ値が既にあるか）には一切関与しない。バーコード検出時の
// ビープ/バイブもこの値を流用する。変更した場合は HelpSheet.tsx の
// 「バーコードを読む」の記載も合わせること。
const NOTIFY_WINDOW_MS = 1500

// 「読み取り済み」表示を出しっぱなしにする時間（ミリ秒）
const DUPLICATE_HINT_VISIBLE_MS = 1200

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

const FILTER_OPTIONS: { value: OcrFilterMode; label: string }[] = [
  { value: 'raw', label: OCR_FILTER_LABELS.raw },
  { value: 'digits', label: OCR_FILTER_LABELS.digits },
  { value: 'alnum', label: OCR_FILTER_LABELS.alnum },
]

// 統一結果リストの1件。バーコード・OCR共通の形。フィールド振り分けは行わない。
type ResultItem = {
  id: number
  source: 'barcode' | 'ocr'
  raw: string // OCRの場合は「エンジンが実際に読んだ生テキスト」。フィルタは表示時に適用する
  format?: string
  at: number
}

// 表示用の値を求める。OCR結果だけ抽出フィルタの対象になる
// （フィルタはここで毎回計算するだけの純粋処理なので、切り替えは即座に反映される）
function displayValueOf(item: ResultItem, filterMode: OcrFilterMode): string {
  if (item.source !== 'ocr') return item.raw
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

export function SimpleScanScreen() {
  // 画質プリセットは起動直後の最初の getUserMedia 要求から効かせたいため、
  // useState の遅延初期化で1度だけ localStorage を読み、useCamera に渡す
  // （loadScanMode 等、他の設定の読み方と同じ流儀）。
  const [initialCaptureQuality] = useState(loadCaptureQuality)
  const camera = useCamera(initialCaptureQuality)

  // 読み取りモード（バーコード / 文字）。前回選んでいたモードを次回起動時も復元する。
  const [mode, setMode] = useState<ScanMode>(loadScanMode)
  const handleChangeMode = useCallback((next: ScanMode) => {
    setMode(next)
    saveScanMode(next)
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
  // 対象はバーコード行のみ。OCR で読んだ文字列がたまたま同じ値でも、
  // バーコードの読み取りを止める理由にはならないため。
  const isDuplicateValue = useCallback(
    (value: string) => resultsRef.current.some((item) => item.source === 'barcode' && item.raw === value),
    [],
  )

  const [manualPaused, setManualPaused] = useState(false)
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible')

  // 使い方（ヘルプ）パネル。初めて開いたときだけ自動表示し、以降は「?」ボタンで
  // 手動で開く。開いている間はカメラがどこを向いているか分からなくなるため、
  // isAnyOverlayOpen 経由でバーコード検出を止める（下の overlaysOpen を参照）。
  const [helpOpen, setHelpOpen] = useState(false)

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
    void preloadOcr((p) => setOcrProgress(p))
  }, [])

  // 画面はこれ1つしかないため、マウント時にカメラを起動しアンマウント時に止めるだけでよい
  useEffect(() => {
    void camera.start()
    return () => camera.stop()
    // camera.start / camera.stop は useCamera 内で useCallback により安定した参照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ブラウザタブ自体の前面/背面をハンドリングする
  useEffect(() => {
    const handleVisibility = () => setPageVisible(document.visibilityState === 'visible')
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

  const appendResult = useCallback((source: ResultItem['source'], raw: string, format?: string) => {
    const id = nextIdRef.current++
    const item: ResultItem = { id, source, raw, format, at: Date.now() }
    // ref を state の反映（effect）まで待たずにここで更新する。
    // 待つと、その間に届いたフレームで同じ値が二重に追加され得るため。
    resultsRef.current = [item, ...resultsRef.current]
    setResults((prev) => [item, ...prev])
  }, [])

  const handleScan = useCallback(
    (scan: RawScan) => {
      appendResult('barcode', scan.value, scan.format)
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

  // この画面に実在するオーバーレイは「OCR結果カード」と「使い方パネル」の2つだけ
  // （一覧・確認ダイアログ・プロファイル選択などはこの画面には存在しない）。
  // isAnyOverlayOpen は汎用の純粋関数のまま流用し、渡すフラグだけを実在するものに絞る。
  // OCR結果カードで止めるのは「認識処理中」だけにする。結果カードはカメラ映像の下に
  // 並ぶだけで視界を塞がないため、表示されている間ずっと検出を止めると
  // 一度 OCR しただけでバーコードが読めなくなってしまう。
  // 使い方パネルは全画面表示でカメラがどこを向いているか分からなくなるため、
  // 開いている間は常にバーコード検出を止める。
  const overlaysOpen = useMemo(() => isAnyOverlayOpen({ ocrResultPanelOpen: ocrBusy, helpOpen }), [ocrBusy, helpOpen])

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
      }),
    [camera.ready, pageVisible, manualPaused, overlaysOpen, mode],
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

  useEffect(() => {
    if (scannerError) showToast(scannerError, 'error')
  }, [scannerError])

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
            appendResult('ocr', result.text)
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
    void detectBoxes(captured.frame).then((boxes) => {
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
      runRecognition(image)
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

  const handleCopyRow = useCallback(async (value: string) => {
    const ok = await copyToClipboard(value)
    showToast(ok ? 'コピーしました' : 'コピーに失敗しました', ok ? 'success' : 'error')
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
            {results.map((item) => {
              const value = displayValueOf(item, filterMode)
              const showRaw = item.source === 'ocr' && value !== item.raw
              return (
                <li key={item.id} className="flex items-start gap-2 p-3">
                  <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${sourceBadgeClass(item.source)}`}>
                    {sourceBadgeLabel(item.source)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <pre className="whitespace-pre-wrap break-all font-mono text-sm text-slate-100">
                      {value === '' ? '(空文字)' : value}
                    </pre>
                    {showRaw && (
                      <p className="mt-0.5 whitespace-pre-wrap break-all text-[11px] text-slate-500">元の読み取り: {item.raw}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCopyRow(value)}
                    aria-label="この行をコピー"
                    className="shrink-0 rounded-lg p-1.5 text-slate-300 active:bg-slate-800"
                  >
                    <CopyIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteRow(item.id)}
                    aria-label="この行を削除"
                    className="shrink-0 rounded-full p-1.5 text-slate-400 active:bg-slate-800"
                  >
                    <CloseIcon className="h-4 w-4" />
                  </button>
                </li>
              )
            })}
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
          <HelpSheet onClose={handleCloseHelp} />
        </Suspense>
      )}
    </div>
  )
}
