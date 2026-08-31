// アプリの主画面。カメラ映像を全画面表示し、バーコードを継続的に読み取りながら
// OCR・手入力を組み合わせて1件のレコードを組み立て、確定して保存する。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FieldValue, ParsedRecord, RawScan } from '../parse/types'
import { applyProfile } from '../parse/engine'
import { saveRecord } from '../store/records'
import { useProfiles, useSettings } from '../store/useStore'
import { useCamera } from '../camera/useCamera'
import { useBarcodeScanner } from '../scan/useBarcodeScanner'
import { preloadOcr, runOcr, type RoiRect } from '../scan/ocr'
import { Button } from './components/Button'
import { Sheet } from './components/Sheet'
import { CheckIcon, FlashIcon, FlashOffIcon, ScanIcon, SpinnerIcon, WarningIcon } from './components/Icons'
import { showToast } from './components/toastBus'
import { RecordSheet } from './RecordSheet'
import { RawDataPanel } from './RawDataPanel'

// ROI: 画面中央よりやや上。下部のパネルと重ならない位置に置く（相対座標 0..1）。
const ROI: RoiRect = { x: 0.1, y: 0.26, w: 0.8, h: 0.18 }

type ScanScreenProps = {
  enabled: boolean
}

export function ScanScreen({ enabled }: ScanScreenProps) {
  const { profiles, active, setActive } = useProfiles()
  const { settings } = useSettings()
  const camera = useCamera()

  const [rawScans, setRawScans] = useState<RawScan[]>([])
  const [fieldOverrides, setFieldOverrides] = useState<Record<string, RawScan>>({})
  const [profilePickerOpen, setProfilePickerOpen] = useState(false)
  const [rawPanelOpen, setRawPanelOpen] = useState(false)
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrBusyKey, setOcrBusyKey] = useState<string | null>(null)
  const [ocrInfo, setOcrInfo] = useState<{ ms: number; confidence: number } | null>(null)
  const [saving, setSaving] = useState(false)

  const preloadTriggeredRef = useRef(false)
  const ensureOcrPreloaded = useCallback(() => {
    if (preloadTriggeredRef.current) return
    preloadTriggeredRef.current = true
    void preloadOcr()
  }, [])

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

  const handleScan = useCallback((scan: RawScan) => {
    setRawScans((prev) => [...prev, scan])
  }, [])

  const { backend, error: scannerError } = useBarcodeScanner({
    videoRef: camera.videoRef,
    enabled: enabled && camera.ready,
    dedupeMs: settings?.dedupeMs ?? 1500,
    beep: settings?.beep ?? true,
    vibrate: settings?.vibrate ?? true,
    onScan: handleScan,
  })

  useEffect(() => {
    if (scannerError) showToast(scannerError, 'error')
  }, [scannerError])

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

  const resetBuffer = useCallback(() => {
    setRawScans([])
    setFieldOverrides({})
    setOcrInfo(null)
  }, [])

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

  const handleShutterOcr = useCallback(async () => {
    const video = camera.videoRef.current
    if (!video || !camera.ready) {
      showToast('カメラの準備ができていません', 'error')
      return
    }
    ensureOcrPreloaded()
    setOcrBusy(true)
    try {
      const result = await runOcr(video, ROI, {
        whitelist: settings?.ocrWhitelist ?? '',
        psm: settings?.ocrPsm ?? '6',
      })
      setOcrInfo({ ms: result.ms, confidence: result.confidence })
      if (result.text.trim().length === 0) {
        showToast('文字を読み取れませんでした', 'error')
      } else {
        setRawScans((prev) => [...prev, { value: result.text, source: 'ocr', at: Date.now() }])
      }
    } catch {
      showToast('OCRに失敗しました', 'error')
    } finally {
      setOcrBusy(false)
    }
  }, [camera.videoRef, camera.ready, ensureOcrPreloaded, settings])

  const handleFieldOcr = useCallback(
    (key: string) => {
      const video = camera.videoRef.current
      if (!video || !camera.ready) {
        showToast('カメラの準備ができていません', 'error')
        return
      }
      ensureOcrPreloaded()
      setOcrBusyKey(key)
      runOcr(video, ROI, { whitelist: settings?.ocrWhitelist ?? '', psm: settings?.ocrPsm ?? '6' })
        .then((result) => {
          if (result.text.trim().length === 0) {
            showToast('文字を読み取れませんでした', 'error')
            return
          }
          setFieldOverrides((prev) => ({ ...prev, [key]: { value: result.text, source: 'ocr', at: Date.now() } }))
        })
        .catch(() => showToast('OCRに失敗しました', 'error'))
        .finally(() => setOcrBusyKey(null))
    },
    [camera.videoRef, camera.ready, ensureOcrPreloaded, settings],
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
      <div className="relative z-20 flex flex-col items-center gap-1 pb-3">
        {ocrInfo && (
          <span className="rounded bg-slate-900/80 px-2 py-0.5 text-[11px] text-slate-400">
            {ocrInfo.ms}ms / 信頼度 {Math.round(ocrInfo.confidence)}%
          </span>
        )}
        <Button variant="primary" size="lg" loading={ocrBusy} onClick={() => void handleShutterOcr()} className="shadow-xl">
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
