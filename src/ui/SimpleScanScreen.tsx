// アプリの唯一の画面。カメラでバーコードを継続的に読み取りつつ、枠内をシャッターで
// OCR にかけ、両方の結果を1つのリストに時系列（新しい順）でため込むだけの
// 最小構成。フィールド振り分け・保存・履歴は一切行わない
// （結果はメモリ上のみに保持し、画面を閉じると消える。これは意図的な仕様）。
//
// 現場の要件がまだ固まっていないため、まずはこの最小読み取りツールを持って行き、
// 実際に何が必要かを確認するためのもの。ラベル定義エディタ・履歴・CSV書き出し・
// 設定画面などの既存機能は src/ui/legacy 以下に退避してあり、削除はしていない。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RawScan } from '../parse/types'
import { useCamera } from '../camera/useCamera'
import { useBarcodeScanner } from '../scan/useBarcodeScanner'
import { isAnyOverlayOpen, isBarcodeScanEnabled } from '../scan/scanGating'
import {
  applyOcrFilter,
  captureRoi,
  DEFAULT_OCR_OPTIONS,
  hasOcrEngineCached,
  OCR_FILTER_LABELS,
  preloadOcr,
  recognizeCaptured,
  type OcrFilterMode,
  type OcrOptions,
  type OcrProgress,
  type RoiRect,
} from '../scan/ocr'
import { Button } from './components/Button'
import { Select } from './components/Controls'
import { CloseIcon, CopyIcon, FlashIcon, FlashOffIcon, PauseIcon, PlayIcon, ScanIcon, SpinnerIcon, WarningIcon } from './components/Icons'
import { showToast } from './components/toastBus'
import { copyToClipboard, sourceBadgeClass, sourceBadgeLabel } from './lib'

// バーコード検出時のビープ/バイブ/連続無視時間。設定画面がないため既定値を固定で使う。
const BEEP_ENABLED = true
const VIBRATE_ENABLED = true
const DEDUPE_MS = 1500

// ROI: 画面中央よりやや上（相対座標 0..1）。ScanScreen.tsx と同じ値を流用する。
const ROI: RoiRect = { x: 0.1, y: 0.26, w: 0.8, h: 0.18 }

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
  const camera = useCamera()

  const [results, setResults] = useState<ResultItem[]>([])
  const nextIdRef = useRef(0)

  const [manualPaused, setManualPaused] = useState(false)
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible')

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

  const appendResult = useCallback((source: ResultItem['source'], raw: string, format?: string) => {
    const id = nextIdRef.current++
    setResults((prev) => [{ id, source, raw, format, at: Date.now() }, ...prev])
  }, [])

  const handleScan = useCallback(
    (scan: RawScan) => {
      appendResult('barcode', scan.value, scan.format)
    },
    [appendResult],
  )

  // この画面に実在するオーバーレイは「OCR結果カード」だけ（一覧・確認ダイアログ・
  // プロファイル選択などはこの画面には存在しない）。isAnyOverlayOpen は汎用の
  // 純粋関数のまま流用し、渡すフラグだけを実在するものに絞る。
  const overlaysOpen = useMemo(
    () => isAnyOverlayOpen({ ocrResultPanelOpen: capturedImage !== null }),
    [capturedImage],
  )

  const scanEnabled = useMemo(
    () =>
      isBarcodeScanEnabled({
        tabActive: true,
        cameraReady: camera.ready,
        pageVisible,
        manualPaused,
        overlaysOpen,
      }),
    [camera.ready, pageVisible, manualPaused, overlaysOpen],
  )

  const { backend, error: scannerError } = useBarcodeScanner({
    videoRef: camera.videoRef,
    enabled: scanEnabled,
    // バックエンドは画面が有効な間ずっと保持する（オーバーレイ開閉で作り直さない）
    active: camera.ready,
    dedupeMs: DEDUPE_MS,
    beep: BEEP_ENABLED,
    vibrate: VIBRATE_ENABLED,
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
    const video = camera.videoRef.current
    if (!video || !camera.ready) {
      showToast('カメラの準備ができていません', 'error')
      return
    }
    // シャッターが押された「その瞬間」の映像を、await をまたぐ前に同期的に確定させる。
    const image = captureRoi(video, ROI)
    setCapturedImage(image)
    setOcrInfo(null)
    setOcrRawText(null)
    ensureOcrPreloaded()
    runRecognition(image)
  }, [camera.videoRef, camera.ready, ensureOcrPreloaded, runRecognition])

  // 撮影しなおさず、現在の PSM で同じ画像を読み直す（再認識のみ。フィルタはここでは無関係）
  const handleRetrySameImage = useCallback(() => {
    if (!capturedImage) return
    runRecognition(capturedImage)
  }, [capturedImage, runRecognition])

  const handleDismissCapturedImage = useCallback(() => {
    setCapturedImage(null)
    setOcrInfo(null)
    setOcrRawText(null)
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

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      {/* カメラ映像（画面上部） */}
      <div className="relative shrink-0 overflow-hidden bg-black" style={{ height: '42vh' }}>
        <video ref={camera.videoRef} autoPlay muted playsInline className="absolute inset-0 h-full w-full object-cover" />

        {!camera.error && (
          <div
            className="pointer-events-none absolute rounded-lg border-2 border-cyan-300/90"
            style={{
              left: `${ROI.x * 100}%`,
              top: `${ROI.y * 100}%`,
              width: `${ROI.w * 100}%`,
              height: `${ROI.h * 100}%`,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
            }}
          >
            {/* OCR実行中は、実際に読み取っている静止画をこの枠内に重ねて表示する */}
            {ocrBusy && capturedImage && (
              <div className="absolute inset-0 overflow-hidden rounded-lg bg-black">
                <CapturedImageCanvas image={capturedImage} className="h-full w-full" />
                <div className="absolute inset-0 flex items-center justify-center gap-2 bg-slate-950/40">
                  <SpinnerIcon className="h-5 w-5 text-cyan-300" />
                  <span className="text-xs font-semibold text-cyan-100">この画像を読み取り中…</span>
                </div>
              </div>
            )}
            <span className="absolute -left-0.5 -top-0.5 h-5 w-5 rounded-tl border-l-4 border-t-4 border-cyan-300" />
            <span className="absolute -right-0.5 -top-0.5 h-5 w-5 rounded-tr border-r-4 border-t-4 border-cyan-300" />
            <span className="absolute -bottom-0.5 -left-0.5 h-5 w-5 rounded-bl border-b-4 border-l-4 border-cyan-300" />
            <span className="absolute -bottom-0.5 -right-0.5 h-5 w-5 rounded-br border-b-4 border-r-4 border-cyan-300" />
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

        {manualPaused && !camera.error && (
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

        <span className="absolute right-2 top-2 rounded-lg bg-slate-900/80 px-2 py-1 text-[10px] font-semibold text-slate-300">
          BC: {backendLabel}
        </span>
      </div>

      {/* コントロール */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-slate-800 bg-slate-900 p-3">
        {showFirstUseHint && !ocrBusy && (
          <p className="text-center text-[11px] text-slate-400">
            初回のみOCRエンジン（約9MB）をダウンロードします。次回からはオフラインで利用できます。
          </p>
        )}

        {ocrBusy && ocrProgress && (
          <div className="flex items-center gap-2 rounded bg-slate-800 px-3 py-1.5 text-[11px] text-cyan-100">
            <SpinnerIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 truncate">{ocrProgress.status}</span>
            <span className="tabular-nums">{Math.round(ocrProgress.progress * 100)}%</span>
          </div>
        )}

        {/* OCR結果カード: 直近の読み取り結果と、このアプリで唯一の設定（PSM・抽出フィルタ） */}
        {!ocrBusy && capturedImage && ocrInfo && (
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
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setManualPaused((p) => !p)}
            aria-pressed={manualPaused}
            className={`flex min-h-14 items-center gap-1.5 rounded-xl px-3 text-xs font-bold ${
              manualPaused ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-slate-200'
            }`}
          >
            {manualPaused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
            {manualPaused ? '再開' : '一時停止'}
          </button>

          <Button variant="primary" size="lg" loading={ocrBusy} onClick={handleShutterOcr} className="flex-1 shadow-xl">
            {!ocrBusy && <ScanIcon className="h-5 w-5" />} 枠内をOCR
          </Button>

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
    </div>
  )
}
