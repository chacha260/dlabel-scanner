// 設定画面。読み取り挙動・CSV出力・OCR関連の設定と、
// OCRエンジンの事前ダウンロード、履歴の全削除、アプリ情報を提供する。

import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '../../store/db'
import { clearRecords, countRecords } from '../../store/records'
import { useSettings } from '../../store/useStore'
import { isStoragePersisted, requestStoragePersistence } from '../../store/storagePersistence'
import { isMlKitAvailable } from '../../scan/ocr'
import { Button } from '../components/Button'
import { Field, Select, Switch, TextInput } from '../components/Controls'
import { Sheet } from '../components/Sheet'
import { showToast } from '../components/toastBus'

const APP_VERSION = '0.0.0'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = -1
  do {
    value /= 1024
    unitIndex += 1
  } while (value >= 1024 && unitIndex < units.length - 1)
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

export function SettingsScreen() {
  const { settings, update } = useSettings()

  const [dedupeLocal, setDedupeLocal] = useState(1500)
  const dedupeTimerRef = useRef<number | undefined>(undefined)
  // settings は非同期に読み込まれるため、読み込み完了/更新のタイミングで
  // ローカル表示用の state に反映する（レンダー中に同期する公式パターン。
  // useEffect を使わないことで不要な追加レンダーの警告を避ける）。
  const [syncedSettings, setSyncedSettings] = useState(settings)
  if (settings !== syncedSettings) {
    setSyncedSettings(settings)
    if (settings) setDedupeLocal(settings.dedupeMs)
  }

  const [clearOpen, setClearOpen] = useState(false)
  const [clearConfirmText, setClearConfirmText] = useState('')
  const [clearing, setClearing] = useState(false)
  const [recordCount, setRecordCount] = useState<number | null>(null)

  const [storageInfo, setStorageInfo] = useState<{ usage: number; quota: number } | null>(null)
  const [storagePersisted, setStoragePersisted] = useState<boolean | null>(null)
  const [requestingPersistence, setRequestingPersistence] = useState(false)

  useEffect(() => {
    countRecords()
      .then(setRecordCount)
      .catch(() => setRecordCount(null))
  }, [])

  useEffect(() => {
    if (!('storage' in navigator) || typeof navigator.storage.estimate !== 'function') return
    navigator.storage
      .estimate()
      .then((est) => setStorageInfo({ usage: est.usage ?? 0, quota: est.quota ?? 0 }))
      .catch(() => setStorageInfo(null))
  }, [])

  useEffect(() => {
    isStoragePersisted().then(setStoragePersisted)
  }, [])

  async function handleRequestPersistence() {
    setRequestingPersistence(true)
    try {
      const granted = await requestStoragePersistence()
      setStoragePersisted(granted)
      showToast(granted ? 'ストレージ保護が有効になりました' : '許可されませんでした', granted ? 'success' : 'error')
    } finally {
      setRequestingPersistence(false)
    }
  }

  function persist(patch: Partial<AppSettings>) {
    update(patch).catch(() => showToast('設定の保存に失敗しました', 'error'))
  }

  function handleDedupeChange(v: number) {
    setDedupeLocal(v)
    window.clearTimeout(dedupeTimerRef.current)
    dedupeTimerRef.current = window.setTimeout(() => persist({ dedupeMs: v }), 300)
  }

  // 以前はここに tesseract.js エンジンの事前ダウンロード（handlePreloadOcr）が
  // あったが、tesseract.js の削除に伴い不要になった。ML Kit は端末組み込みの
  // モデルで、ダウンロードという工程自体が無い（下の OCR セクションの表示も参照）。

  async function handleClearAll() {
    setClearing(true)
    try {
      await clearRecords()
      showToast('履歴をすべて削除しました', 'success')
      setRecordCount(0)
      setClearOpen(false)
      setClearConfirmText('')
    } catch {
      showToast('削除に失敗しました', 'error')
    } finally {
      setClearing(false)
    }
  }

  const nativeLikely = typeof window !== 'undefined' && 'BarcodeDetector' in window

  if (!settings) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-900">
        <p className="text-sm text-slate-500">読み込み中…</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-slate-900">
      <div className="border-b border-slate-800 p-3">
        <h1 className="text-lg font-bold text-slate-100">設定</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-1 rounded-xl border border-slate-700 bg-slate-800/60 px-3">
            <h2 className="pt-2 text-xs font-semibold text-slate-400">スキャン</h2>
            <Switch checked={settings.beep} onChange={(v) => persist({ beep: v })} label="読み取り音を鳴らす" />
            <div className="border-t border-slate-700" />
            <Switch checked={settings.vibrate} onChange={(v) => persist({ vibrate: v })} label="振動でフィードバックする" />
            <div className="border-t border-slate-700 pt-3" />
            <div className="pb-3">
              <div className="mb-1 flex items-center justify-between text-sm text-slate-100">
                <span>同一バーコードの再読み取りを無視する時間</span>
                <span className="font-mono text-cyan-300">{dedupeLocal}ms</span>
              </div>
              <input
                type="range"
                min={500}
                max={3000}
                step={100}
                value={dedupeLocal}
                onChange={(e) => handleDedupeChange(Number(e.target.value))}
                className="w-full accent-cyan-500"
              />
            </div>
            <div className="border-t border-slate-700" />
            <Switch
              checked={settings.showRawData}
              onChange={(v) => persist({ showRawData: v })}
              label="スキャン画面に生データを表示する"
              hint="組み立て中パネルに生の読み取り結果を常時表示します"
            />
          </section>

          <section className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-800/60 p-3">
            <h2 className="text-xs font-semibold text-slate-400">CSV書き出し</h2>
            <Field label="区切り文字">
              <Select
                value={settings.csvDelimiter}
                onChange={(e) => persist({ csvDelimiter: e.target.value as ',' | '\t' })}
                options={[
                  { value: ',', label: 'カンマ ( , )' },
                  { value: '\t', label: 'タブ' },
                ]}
              />
            </Field>
            <Switch checked={settings.csvBom} onChange={(v) => persist({ csvBom: v })} label="BOMを付与する" hint="Excelで開く場合はONを推奨" />
          </section>

          <section className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-800/60 p-3">
            <h2 className="text-xs font-semibold text-slate-400">OCR</h2>
            <Field label="ホワイトリスト文字（認識対象の文字）" hint="空欄の場合はエンジンの既定値を使用します">
              <TextInput
                value={settings.ocrWhitelist}
                onChange={(e) => persist({ ocrWhitelist: e.target.value })}
                placeholder="例: 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-./"
                className="font-mono"
              />
            </Field>
            {/* 読み取りモード（PSM）の設定は、tesseract.js 固有の概念だったため
                現在は配線先が無い（ML Kit は PSM という概念自体を持たない）。
                ocrWhitelist と同じ理由で項目自体は残してある: 要件が固まって
                再配線する際に設定値を失わないため。settings.ocrPsm は
                store/db.ts の AppSettings に引き続き存在する。 */}
            <Field label="読み取りモード（PSM）" hint="現在は使用されていません（tesseract.js 固有の設定のため）">
              <Select
                value={settings.ocrPsm}
                onChange={(e) => persist({ ocrPsm: e.target.value as '6' | '7' | '8' })}
                options={[
                  { value: '7', label: '単一行' },
                  { value: '8', label: '単一語' },
                  { value: '6', label: 'ブロック（複数行）' },
                ]}
              />
            </Field>
            <div className="border-t border-slate-700 pt-3">
              <p className="text-xs text-slate-500">
                {/* tesseract.js を削除し、OCRエンジンは ML Kit（Androidアプリに組み込み済み）
                    1本になった。ML Kit は端末組み込みのモデルのため、ダウンロードという
                    工程自体が無く、事前準備ボタンも不要になった。 */}
                {isMlKitAvailable()
                  ? 'OCR（ML Kit）は端末に組み込まれているため、事前ダウンロードは不要です。'
                  : 'OCRはAndroidアプリ版でのみ利用できます。ブラウザでは利用できません。'}
              </p>
            </div>
          </section>

          <section className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-800/60 p-3">
            <h2 className="text-xs font-semibold text-slate-400">データ管理</h2>
            <p className="text-sm text-slate-300">保存件数: {recordCount ?? '—'} 件</p>
            <Button variant="danger" size="lg" onClick={() => setClearOpen(true)}>
              履歴を全削除
            </Button>
          </section>

          <section className="flex flex-col gap-2 rounded-xl border border-slate-700 bg-slate-800/60 p-3">
            <h2 className="text-xs font-semibold text-slate-400">アプリ情報</h2>
            <div className="flex justify-between text-sm text-slate-300">
              <span>バージョン</span>
              <span className="font-mono">{APP_VERSION}</span>
            </div>
            <div className="flex justify-between text-sm text-slate-300">
              <span>バーコード読み取り方式</span>
              <span>{nativeLikely ? 'ネイティブ（推定）' : 'zxing-wasm（推定）'}</span>
            </div>
            {storageInfo && (
              <div className="flex justify-between text-sm text-slate-300">
                <span>ストレージ使用量</span>
                <span>
                  {formatBytes(storageInfo.usage)} / {formatBytes(storageInfo.quota)}
                </span>
              </div>
            )}
            <div className="flex justify-between text-sm text-slate-300">
              <span>ストレージ保護</span>
              <span className={storagePersisted ? 'font-semibold text-emerald-400' : 'font-semibold text-amber-400'}>
                {storagePersisted === null ? '確認中…' : storagePersisted ? '有効' : '無効'}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              端末の空き容量が少なくなると、ブラウザが保存データを黙って消去することがあります。
              「保護」を有効にすると消去されにくくなります（ブラウザが自動で許可することも、
              ホーム画面に追加しないと許可されないこともあります）。
            </p>
            {!storagePersisted && (
              <Button
                variant="secondary"
                size="md"
                loading={requestingPersistence}
                onClick={() => void handleRequestPersistence()}
              >
                ストレージ保護を要求
              </Button>
            )}
            <p className="pt-1 text-xs text-slate-500">完全オフラインで動作します。通信は行いません。</p>
          </section>
        </div>
      </div>

      <Sheet
        open={clearOpen}
        onClose={() => {
          setClearOpen(false)
          setClearConfirmText('')
        }}
        title="履歴を全削除しますか？"
      >
        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-slate-400">
            保存されている {recordCount ?? 0} 件の履歴がすべて削除されます。この操作は取り消せません。
          </p>
          <Field label={'確認のため「削除」と入力してください'}>
            <TextInput value={clearConfirmText} onChange={(e) => setClearConfirmText(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="lg"
              className="flex-1"
              onClick={() => {
                setClearOpen(false)
                setClearConfirmText('')
              }}
            >
              戻る
            </Button>
            <Button
              variant="danger"
              size="lg"
              className="flex-1"
              disabled={clearConfirmText !== '削除'}
              loading={clearing}
              onClick={() => void handleClearAll()}
            >
              全削除する
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  )
}
