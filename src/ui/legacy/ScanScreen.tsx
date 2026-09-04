// アプリの主画面。カメラ映像を全画面表示し、バーコードを継続的に読み取りながら
// OCR・手入力を組み合わせて1件のレコードを組み立て、確定して保存する。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FieldValue, ParsedRecord, RawScan } from '../../parse/types'
import { applyProfile } from '../../parse/engine'
import { saveRecord } from '../../store/records'
import { useProfiles, useSettings } from '../../store/useStore'
import {
  clearDraft,
  countDraftScans,
  isDraftNonEmpty,
  loadDraft,
  registerDraftFlush,
  resolveDraftProfile,
  saveDraft,
  type ScanDraft,
} from '../../store/draft'
import { useCamera } from '../../camera/useCamera'
import { useBarcodeScanner } from '../../scan/useBarcodeScanner'
import { isAnyOverlayOpen, isBarcodeScanEnabled } from '../../scan/scanGating'
import { captureRoi, recognizeCaptured, type RoiRect } from '../../scan/ocr'
import { Button } from '../components/Button'
import { Sheet } from '../components/Sheet'
import {
  CheckIcon,
  CloseIcon,
  FlashIcon,
  FlashOffIcon,
  PauseIcon,
  PlayIcon,
  ScanIcon,
  SpinnerIcon,
  WarningIcon,
} from '../components/Icons'
import { showToast } from '../components/toastBus'
import { RecordSheet } from './RecordSheet'
import { RawDataPanel } from './RawDataPanel'

// 下書き保存のデバウンス間隔。連続バーストで IndexedDB を叩きすぎないための猶予。
const DRAFT_SAVE_DEBOUNCE_MS = 400

// ROI: 画面中央よりやや上。下部のパネルと重ならない位置に置く（相対座標 0..1）。
const ROI: RoiRect = { x: 0.1, y: 0.26, w: 0.8, h: 0.18 }

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

type ScanScreenProps = {
  enabled: boolean
}

export function ScanScreen({ enabled }: ScanScreenProps) {
  const { profiles, active, setActive, loading: profilesLoading } = useProfiles()
  const { settings } = useSettings()
  const camera = useCamera()

  const [rawScans, setRawScans] = useState<RawScan[]>([])
  const [fieldOverrides, setFieldOverrides] = useState<Record<string, RawScan>>({})
  const [editingFieldKey, setEditingFieldKey] = useState<string | null>(null)
  const [profilePickerOpen, setProfilePickerOpen] = useState(false)
  const [rawPanelOpen, setRawPanelOpen] = useState(false)
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrBusyKey, setOcrBusyKey] = useState<string | null>(null)
  const [ocrInfo, setOcrInfo] = useState<{ ms: number; confidence: number } | null>(null)
  // シャッターを押した瞬間に確定させた「実際に OCR へ渡す画像」。結果が出たあとも
  // ユーザーが消すか次のシャッターを押すまで表示し続け、同じ画像での再認識にも使う。
  const [capturedImage, setCapturedImage] = useState<ImageData | null>(null)
  const [saving, setSaving] = useState(false)

  // バーコード検出の一時停止（ユーザーが明示的に操作した場合のみ）。
  // オーバーレイの開閉とは独立して保持し、再開ボタンでのみ解除する。
  const [manualPaused, setManualPaused] = useState(false)
  // ブラウザタブ自体が前面表示中か。画面回転やアプリ切り替えでも正しく反映する。
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible')

  // 作業中データの復元バー。起動時に一度だけ下書きの有無を確認して表示する。
  const [draftChecked, setDraftChecked] = useState(false)
  const [pendingDraft, setPendingDraft] = useState<ScanDraft | null>(null)

  // 以前はここに tesseract.js エンジンの事前ダウンロードを済ませておく
  // ensureOcrPreloaded() があったが、tesseract.js の削除に伴い不要になった
  // （ML Kit は端末組み込みのモデルで、事前ダウンロードという概念自体が無い）。

  // enabled が変わったときだけカメラを起動/停止する。ScanScreen 自体は
  // タブ切り替えでアンマウントされないので、組み立て中のバッファは保持される。
  useEffect(() => {
    if (enabled) {
      void camera.start()
    } else {
      camera.stop()
    }
    // camera.start / camera.stop は useCamera 内で useCallback により安定した参照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  // ブラウザタブ自体の前面/背面をハンドリングする（アプリ内タブ切り替えとは別軸）。
  useEffect(() => {
    const handleVisibility = () => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  const handleScan = useCallback((scan: RawScan) => {
    setRawScans((prev) => [...prev, scan])
  }, [])

  // 「データ表示中もバーコードが読み取られ続ける」問題への対処: 生データパネル・
  // フィールド編集・プロファイル選択・OCR結果表示・各種確認ダイアログのいずれかが
  // 開いている間は、カメラは動かしたままバーコード検出だけを止める。
  const overlaysOpen = useMemo(
    () =>
      isAnyOverlayOpen({
        profilePickerOpen,
        rawPanelOpen,
        fieldEditorOpen: editingFieldKey !== null,
        ocrResultPanelOpen: capturedImage !== null,
        forceConfirmOpen,
        clearConfirmOpen,
        draftBannerOpen: pendingDraft !== null,
      }),
    [
      profilePickerOpen,
      rawPanelOpen,
      editingFieldKey,
      capturedImage,
      forceConfirmOpen,
      clearConfirmOpen,
      pendingDraft,
    ],
  )

  const scanEnabled = useMemo(
    () =>
      isBarcodeScanEnabled({
        tabActive: enabled,
        cameraReady: camera.ready,
        pageVisible,
        manualPaused,
        overlaysOpen,
        // このレガシー画面はモード分割前の唯一の画面であり、常にバーコードモード相当
        // （継続的なバーコード検出が既定の唯一の挙動）として扱う。
        mode: 'barcode',
      }),
    [enabled, camera.ready, pageVisible, manualPaused, overlaysOpen],
  )

  const { backend, error: scannerError } = useBarcodeScanner({
    videoRef: camera.videoRef,
    enabled: scanEnabled,
    // バックエンドはタブが有効な間ずっと保持する（オーバーレイ開閉で作り直さない）
    active: enabled && camera.ready,
    dedupeMs: settings?.dedupeMs ?? 1500,
    beep: settings?.beep ?? true,
    vibrate: settings?.vibrate ?? true,
    onScan: handleScan,
  })

  useEffect(() => {
    if (scannerError) showToast(scannerError, 'error')
  }, [scannerError])

  // プロファイルが切り替わったら、別プロファイルのフィールドを指したままの
  // 編集状態を残さないようにする
  useEffect(() => {
    setEditingFieldKey(null)
  }, [active?.id])

  const parsed: ParsedRecord | null = useMemo(() => {
    if (!active) return null
    return applyProfile(rawScans, active)
  }, [rawScans, active])

  const finalValues: Record<string, FieldValue> = useMemo(() => {
    if (!active || !parsed) return {}
    const merged: Record<string, FieldValue> = { ...parsed.values }
    for (const [key, scan] of Object.entries(fieldOverrides)) {
      const rule = active.fields.find((f) => f.key === key)
      if (!rule) continue
      merged[key] = { key: rule.key, label: rule.label, value: scan.value, raw: scan.value, source: scan.source }
    }
    return merged
  }, [active, parsed, fieldOverrides])

  const missingRequired: string[] = useMemo(() => {
    if (!active) return []
    return active.fields.filter((f) => f.required && (!finalValues[f.key] || finalValues[f.key]?.error)).map((f) => f.key)
  }, [active, finalValues])

  const complete = !active || active.completeWhen === 'manual' ? true : missingRequired.length === 0

  const allRawScans = useMemo(
    () => [...rawScans, ...Object.values(fieldOverrides)],
    [rawScans, fieldOverrides],
  )

  // --- 組み立て中バッファの下書き永続化（データ消失対策） ---
  // rawScans / fieldOverrides の最新値を ref に保持し、変更のたびにデバウンスして
  // IndexedDB へ書き出す。タブが裏に回った瞬間（visibilitychange → hidden）と
  // pagehide では、デバウンスを待たずに即座に保存し切る。
  const draftSnapshotRef = useRef<{
    profileId: string
    rawScans: RawScan[]
    fieldOverrides: Record<string, RawScan>
  } | null>(null)
  const draftTimerRef = useRef<number | undefined>(undefined)

  const flushDraftSave = useCallback((): Promise<void> => {
    window.clearTimeout(draftTimerRef.current)
    const snap = draftSnapshotRef.current
    if (!snap || !isDraftNonEmpty(snap)) return Promise.resolve()
    return saveDraft({ ...snap, updatedAt: Date.now() }).catch(() => {
      // 下書き保存の失敗は致命的ではない（次の変更やタイマーで再試行される）
    })
  }, [])

  useEffect(() => {
    if (!active) return
    draftSnapshotRef.current = { profileId: active.id, rawScans, fieldOverrides }
    window.clearTimeout(draftTimerRef.current)
    draftTimerRef.current = window.setTimeout(() => {
      void flushDraftSave()
    }, DRAFT_SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(draftTimerRef.current)
  }, [active, rawScans, fieldOverrides, flushDraftSave])

  // SW更新バナーなど、この画面の外側からも即時保存できるようにしておく
  // （ScanScreen は常時マウントされているため、常に最新の flush 関数が登録される）。
  useEffect(() => {
    registerDraftFlush(flushDraftSave)
    return () => registerDraftFlush(null)
  }, [flushDraftSave])

  // Android にタブを回収されやすい瞬間: 裏に回った直後とページ破棄の直前。
  // デバウンスを待たず、ここで確実に保存し切る。
  useEffect(() => {
    const handleHidden = () => {
      if (document.visibilityState === 'hidden') void flushDraftSave()
    }
    const handlePageHide = () => void flushDraftSave()
    document.addEventListener('visibilitychange', handleHidden)
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      document.removeEventListener('visibilitychange', handleHidden)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [flushDraftSave])

  // 起動時に一度だけ、保存済みの下書きがないか確認する（プロファイル一覧の
  // 読み込みが終わってから: 下書きのプロファイルが現存するか判定するため）。
  useEffect(() => {
    if (draftChecked || profilesLoading) return
    setDraftChecked(true)
    loadDraft()
      .then((draft) => {
        if (draft && isDraftNonEmpty(draft)) setPendingDraft(draft)
      })
      .catch(() => {
        // 下書きの読み込みに失敗しても致命的ではないため無視する
      })
  }, [draftChecked, profilesLoading])

  const pendingDraftProfile = useMemo(
    () => (pendingDraft ? resolveDraftProfile(pendingDraft, profiles) : undefined),
    [pendingDraft, profiles],
  )

  const handleRestoreDraft = useCallback(async () => {
    if (!pendingDraft || !pendingDraftProfile) return
    if (pendingDraftProfile.id !== active?.id) {
      await setActive(pendingDraftProfile.id)
    }
    setRawScans(pendingDraft.rawScans)
    setFieldOverrides(pendingDraft.fieldOverrides)
    setPendingDraft(null)
    showToast('作業中のデータを復元しました', 'success')
  }, [pendingDraft, pendingDraftProfile, active, setActive])

  const handleDiscardDraft = useCallback(() => {
    setPendingDraft(null)
    void clearDraft().catch(() => {})
  }, [])

  const resetBuffer = useCallback(() => {
    window.clearTimeout(draftTimerRef.current)
    draftSnapshotRef.current = null
    setRawScans([])
    setFieldOverrides({})
    setEditingFieldKey(null)
    setOcrInfo(null)
    setCapturedImage(null)
    void clearDraft().catch(() => {})
  }, [])

  // 以前はここで settings.ocrPsm から OcrOptions を組み立てていたが、
  // tesseract.js の削除に伴って OcrOptions 自体（PSMを含む）が無くなったため
  // 不要になった。settings.ocrPsm / settings.ocrWhitelist 自体は
  // SettingsScreen.tsx の設定項目として残っている（配線先が無くなっただけ）。

  const doSave = useCallback(async () => {
    if (!active || !parsed) return
    setSaving(true)
    try {
      const finalParsed: ParsedRecord = {
        profileId: active.id,
        values: finalValues,
        unmatched: parsed.unmatched,
        missingRequired,
        complete,
      }
      await saveRecord({ parsed: finalParsed, profile: active, rawScans: allRawScans })
      showToast('保存しました', 'success')
      resetBuffer()
    } catch {
      showToast('保存に失敗しました', 'error')
    } finally {
      setSaving(false)
      setForceConfirmOpen(false)
    }
  }, [active, parsed, finalValues, missingRequired, complete, allRawScans, resetBuffer])

  const handleConfirmPress = useCallback(() => {
    if (!complete) {
      setForceConfirmOpen(true)
      return
    }
    void doSave()
  }, [complete, doSave])

  const handleClearPress = useCallback(() => {
    if (rawScans.length === 0 && Object.keys(fieldOverrides).length === 0) return
    setClearConfirmOpen(true)
  }, [rawScans.length, fieldOverrides])

  // 実際に認識にかけている ImageData を渡して結果を rawScans に積む共通処理。
  // シャッター押下の初回認識・「同じ画像で再認識」のどちらからも呼ぶ。
  // recognizeCaptured は ML Kit が使えない環境（ブラウザ）では日本語エラーで
  // reject するので、そのメッセージをそのままトーストに出す。
  const runRecognition = useCallback((image: ImageData) => {
    setOcrBusy(true)
    recognizeCaptured(image)
      .then((result) => {
        setOcrInfo({ ms: result.ms, confidence: result.confidence })
        if (result.text.trim().length === 0) {
          showToast('文字を読み取れませんでした', 'error')
        } else {
          setRawScans((prev) => [...prev, { value: result.text, source: 'ocr', at: Date.now() }])
        }
      })
      .catch((err: unknown) => showToast(err instanceof Error ? err.message : 'OCRに失敗しました', 'error'))
      .finally(() => setOcrBusy(false))
  }, [])

  const handleShutterOcr = useCallback(() => {
    const video = camera.videoRef.current
    if (!video || !camera.ready) {
      showToast('カメラの準備ができていません', 'error')
      return
    }
    // シャッターが押された「その瞬間」の映像を、await をまたぐ前に同期的に確定させる。
    // これにより「どのタイミングの画像を読んでいるか」が一意に決まる。
    const image = captureRoi(video, ROI)
    setCapturedImage(image)
    setOcrInfo(null)
    runRecognition(image)
  }, [camera.videoRef, camera.ready, runRecognition])

  // 撮影しなおさず同じ画像を読み直す
  const handleRetrySameImage = useCallback(() => {
    if (!capturedImage) return
    runRecognition(capturedImage)
  }, [capturedImage, runRecognition])

  const handleDismissCapturedImage = useCallback(() => {
    setCapturedImage(null)
    setOcrInfo(null)
  }, [])

  const handleFieldOcr = useCallback(
    (key: string) => {
      const video = camera.videoRef.current
      if (!video || !camera.ready) {
        showToast('カメラの準備ができていません', 'error')
        return
      }
      // こちらもシャッター同様、押した瞬間の映像を同期的に確定させてから認識する
      const image = captureRoi(video, ROI)
      setOcrBusyKey(key)
      recognizeCaptured(image)
        .then((result) => {
          if (result.text.trim().length === 0) {
            showToast('文字を読み取れませんでした', 'error')
            return
          }
          setFieldOverrides((prev) => ({ ...prev, [key]: { value: result.text, source: 'ocr', at: Date.now() } }))
        })
        .catch((err: unknown) => showToast(err instanceof Error ? err.message : 'OCRに失敗しました', 'error'))
        .finally(() => setOcrBusyKey(null))
    },
    [camera.videoRef, camera.ready],
  )

  const handleManualEdit = useCallback((key: string, value: string) => {
    setFieldOverrides((prev) => ({ ...prev, [key]: { value, source: 'manual', at: Date.now() } }))
  }, [])

  const handleClearField = useCallback((key: string) => {
    setFieldOverrides((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const backendLabel = backend === 'native' ? 'ネイティブ' : backend === 'zxing' ? 'zxing' : '起動中'

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-black">
      {/* 作業中データの復元バー: 起動直後に下書きが見つかった場合だけ表示する。
          自動では復元せず、必ずユーザーに選ばせる。 */}
      {pendingDraft && (
        <div
          className="absolute inset-x-0 top-0 z-40 flex flex-col gap-2 bg-amber-400 p-3 text-slate-950 shadow-lg"
          style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.5rem)' }}
        >
          <p className="text-sm font-bold">
            作業中のデータがあります（バーコード{countDraftScans(pendingDraft)}件）
          </p>
          {!pendingDraftProfile && (
            <p className="text-xs font-semibold">
              使用していたラベル定義は削除されているため復元できません
            </p>
          )}
          <div className="flex gap-2">
            {pendingDraftProfile && (
              <Button variant="primary" size="md" className="flex-1" onClick={() => void handleRestoreDraft()}>
                復元
              </Button>
            )}
            <Button variant="secondary" size="md" className="flex-1" onClick={handleDiscardDraft}>
              破棄
            </Button>
          </div>
        </div>
      )}

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
          {/* OCR実行中は、実際に読み取っている静止画をこの枠内に重ねて表示する。
              「今どのタイミングの画像を処理しているか」が一目でわかるようにするための演出。 */}
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
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-slate-950/95 p-6 text-center">
          <WarningIcon className="h-10 w-10 text-amber-400" />
          <p className="text-base font-medium text-slate-100">{camera.error}</p>
          <Button variant="primary" size="lg" onClick={() => void camera.start()}>
            再試行
          </Button>
        </div>
      )}

      {/* 一時停止中は、カメラ映像は動かしたまま「読み取りは止まっている」ことを
          見誤りようがない形で示す。OCRシャッター自体はこのバッジと無関係に使える。 */}
      {manualPaused && !camera.error && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 flex -translate-y-1/2 justify-center px-4">
          <span className="flex items-center gap-2 rounded-full bg-red-600/95 px-4 py-2 text-sm font-bold text-white shadow-xl">
            <PauseIcon className="h-4 w-4" /> 読み取り停止中
          </span>
        </div>
      )}

      {/* 上部バー */}
      <div
        className="relative z-20 flex items-center justify-between gap-2 p-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.5rem)' }}
      >
        <button
          type="button"
          onClick={() => setProfilePickerOpen(true)}
          className="min-h-10 max-w-[60%] truncate rounded-lg bg-slate-900/80 px-3 py-2 text-sm font-bold text-slate-100 active:bg-slate-800"
        >
          {active?.name ?? '読み込み中…'} ▾
        </button>
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-slate-900/80 px-2 py-1.5 text-[11px] font-semibold text-slate-300">
            BC: {backendLabel}
          </span>
          {/* 一時停止/再開トグル: カメラは止めずバーコード検出だけを止める。
              OCRシャッターやフィールド編集は一時停止中でも使える。 */}
          <button
            type="button"
            onClick={() => setManualPaused((p) => !p)}
            aria-pressed={manualPaused}
            className={`flex min-h-10 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold ${
              manualPaused ? 'bg-amber-400 text-slate-950' : 'bg-slate-900/80 text-slate-200'
            }`}
          >
            {manualPaused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
            {manualPaused ? '再開' : '一時停止'}
          </button>
          {camera.torchSupported && (
            <button
              type="button"
              onClick={() => void camera.toggleTorch()}
              aria-label="ライトを切り替える"
              className={`rounded-lg p-2 ${camera.torchOn ? 'bg-amber-400 text-slate-950' : 'bg-slate-900/80 text-slate-200'}`}
            >
              {camera.torchOn ? <FlashIcon className="h-5 w-5" /> : <FlashOffIcon className="h-5 w-5" />}
            </button>
          )}
        </div>
      </div>

      <div className="relative z-10 flex-1" />

      {/* OCR シャッター */}
      <div className="relative z-20 flex flex-col items-center gap-2 px-4 pb-3">
        {/* 以前はここに tesseract.js エンジンの初回ダウンロード案内・進捗表示があったが、
            tesseract.js の削除に伴い不要になった（ML Kit は端末組み込みのモデルで、
            ダウンロードも進捗という概念も無い。ネイティブプラグイン呼び出し1回で
            即座に完結する）。認識中はボタンのスピナー（Button の loading）だけで足りる。 */}

        {/* 直近の読み取り結果: 実際に認識器へ渡した画像そのものを並べて表示する */}
        {!ocrBusy && capturedImage && ocrInfo && (
          <div className="flex w-full max-w-xs items-center gap-2 rounded-lg bg-slate-900/90 p-2">
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
        )}

        <Button variant="primary" size="lg" loading={ocrBusy} onClick={handleShutterOcr} className="shadow-xl">
          {!ocrBusy && <ScanIcon className="h-5 w-5" />} 枠内をOCR
        </Button>
      </div>

      {/* 組み立て中レコードのパネル */}
      <div className="relative z-20 flex max-h-[46vh] flex-col rounded-t-2xl border-t border-slate-700 bg-slate-900/97 backdrop-blur">
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {active ? (
            <RecordSheet
              fields={active.fields}
              values={finalValues}
              missingRequired={missingRequired}
              unmatchedCount={parsed?.unmatched.length ?? 0}
              onShowRaw={() => setRawPanelOpen(true)}
              onManualEdit={handleManualEdit}
              onFieldOcr={handleFieldOcr}
              onClearField={handleClearField}
              ocrBusyKey={ocrBusyKey}
              editingKey={editingFieldKey}
              onEditingKeyChange={setEditingFieldKey}
            />
          ) : (
            <p className="p-4 text-center text-sm text-slate-500">ラベル定義を読み込み中…</p>
          )}
        </div>
        <div
          className="flex shrink-0 items-center gap-2 border-t border-slate-800 p-3"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
        >
          <Button variant="secondary" size="lg" className="flex-1" onClick={handleClearPress}>
            クリア
          </Button>
          <div className="flex flex-[2] flex-col gap-1">
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              disabled={!complete || saving || !active}
              loading={saving}
              onClick={handleConfirmPress}
            >
              <CheckIcon className="h-5 w-5" /> 確定
            </Button>
            {!complete && (
              <button
                type="button"
                onClick={() => setForceConfirmOpen(true)}
                className="text-center text-xs font-medium text-amber-400 underline underline-offset-2"
              >
                不足のまま保存
              </button>
            )}
          </div>
        </div>
      </div>

      {/* プロファイル選択 */}
      <Sheet open={profilePickerOpen} onClose={() => setProfilePickerOpen(false)} title="ラベル定義を選択">
        <ul className="divide-y divide-slate-800">
          {profiles.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => {
                  void setActive(p.id)
                  setProfilePickerOpen(false)
                }}
                className="flex w-full items-center justify-between px-4 py-3 text-left active:bg-slate-800"
              >
                <span className="text-sm font-medium text-slate-100">{p.name}</span>
                {active?.id === p.id && <CheckIcon className="h-5 w-5 text-cyan-400" />}
              </button>
            </li>
          ))}
        </ul>
      </Sheet>

      <RawDataPanel open={rawPanelOpen} onClose={() => setRawPanelOpen(false)} rawScans={allRawScans} />

      {/* 不足のまま保存の確認 */}
      <Sheet open={forceConfirmOpen} onClose={() => setForceConfirmOpen(false)} title="必須項目が未入力です">
        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-slate-300">
            次の項目が未入力です:{' '}
            {missingRequired
              .map((key) => active?.fields.find((f) => f.key === key)?.label ?? key)
              .join('、')}
          </p>
          <p className="text-sm text-slate-400">このまま保存しますか？あとから履歴画面で編集できます。</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="lg" className="flex-1" onClick={() => setForceConfirmOpen(false)}>
              戻る
            </Button>
            <Button variant="danger" size="lg" className="flex-1" loading={saving} onClick={() => void doSave()}>
              不足のまま保存
            </Button>
          </div>
        </div>
      </Sheet>

      {/* クリア確認 */}
      <Sheet open={clearConfirmOpen} onClose={() => setClearConfirmOpen(false)} title="スキャン内容を破棄しますか？">
        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-slate-400">現在組み立て中のデータ（{allRawScans.length}件）はすべて消去されます。</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="lg" className="flex-1" onClick={() => setClearConfirmOpen(false)}>
              戻る
            </Button>
            <Button
              variant="danger"
              size="lg"
              className="flex-1"
              onClick={() => {
                resetBuffer()
                setClearConfirmOpen(false)
              }}
            >
              破棄する
            </Button>
          </div>
        </div>
      </Sheet>

      {!camera.ready && !camera.error && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <SpinnerIcon className="h-8 w-8 text-slate-400" />
        </div>
      )}
    </div>
  )
}
