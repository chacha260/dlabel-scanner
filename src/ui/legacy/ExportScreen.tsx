// 書き出し画面。範囲・区切り文字・BOM・メタ列の有無を選び、
// プレビューを見てから CSV 保存 / クリップボードコピーを行う。

import { useMemo, useState } from 'react'
import type { ScanRecord } from '../../store/db'
import { buildCsv, buildTsvForClipboard, defaultCsvFilename, downloadCsv } from '../../export/csv'
import { useProfiles, useRecords, useSettings } from '../../store/useStore'
import type { ExportRequest } from './HistoryScreen'
import { Button } from '../components/Button'
import { Switch } from '../components/Controls'
import { BackIcon, CopyIcon, DownloadIcon } from '../components/Icons'
import { showToast } from '../components/toastBus'
import { copyToClipboard, formatDateTime } from '../lib'

type ExportScreenProps = {
  request: ExportRequest
  onBack: () => void
}

type Scope = ExportRequest['initialScope']

function collectPreviewColumns(records: ScanRecord[]): { key: string; label: string }[] {
  const seen = new Map<string, string>()
  for (const rec of records) {
    for (const col of rec.columns) {
      if (!seen.has(col.key)) seen.set(col.key, col.label)
    }
  }
  return Array.from(seen, ([key, label]) => ({ key, label }))
}

export function ExportScreen({ request, onBack }: ExportScreenProps) {
  const { settings } = useSettings()
  const { profiles } = useProfiles()
  const { records: allRecords, loading } = useRecords()

  const [scope, setScope] = useState<Scope>(request.initialScope)
  const [delimiter, setDelimiter] = useState<',' | '\t'>(settings?.csvDelimiter ?? ',')
  const [bom, setBom] = useState(settings?.csvBom ?? true)
  const [includeMeta, setIncludeMeta] = useState(true)
  const [saving, setSaving] = useState(false)
  const [copying, setCopying] = useState(false)

  const scopedRecords = useMemo(() => {
    if (scope === 'all') return allRecords
    if (scope === 'selected') {
      const idSet = new Set(request.selectedIds)
      return allRecords.filter((r) => idSet.has(r.id))
    }
    const { profileId, from, to } = request.filter
    return allRecords.filter((r) => {
      if (profileId && r.profileId !== profileId) return false
      if (from !== undefined && r.at < from) return false
      if (to !== undefined && r.at > to) return false
      return true
    })
  }, [allRecords, scope, request])

  const previewRecords = scopedRecords.slice(0, 5)
  const previewColumns = collectPreviewColumns(previewRecords)

  const filterProfileName = request.filter.profileId
    ? profiles.find((p) => p.id === request.filter.profileId)?.name
    : undefined

  function handleSaveCsv() {
    setSaving(true)
    try {
      const csv = buildCsv(scopedRecords, { delimiter, bom, includeMeta })
      downloadCsv(csv, defaultCsvFilename(scope === 'filtered' ? filterProfileName : undefined))
      showToast('CSVを保存しました', 'success')
    } catch {
      showToast('CSVの生成に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleCopy() {
    setCopying(true)
    try {
      const tsv = buildTsvForClipboard(scopedRecords)
      const ok = await copyToClipboard(tsv)
      showToast(ok ? 'クリップボードにコピーしました' : 'コピーに失敗しました', ok ? 'success' : 'error')
    } catch {
      showToast('コピーに失敗しました', 'error')
    } finally {
      setCopying(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-slate-900">
      <div className="flex items-center gap-2 border-b border-slate-800 p-3">
        <button type="button" onClick={onBack} aria-label="戻る" className="rounded-lg p-2 text-slate-300 active:bg-slate-800">
          <BackIcon className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-bold text-slate-100">書き出し</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-5">
          <div>
            <div className="mb-2 text-xs font-semibold text-slate-400">範囲</div>
            <div className="flex flex-col gap-2">
              {(
                [
                  { id: 'all', label: `全件（${allRecords.length}件）` },
                  { id: 'filtered', label: `現在のフィルタ（${filterCount(allRecords, request)}件）` },
                  { id: 'selected', label: `選択分（${request.selectedIds.length}件）` },
                ] as { id: Scope; label: string }[]
              ).map((opt) => (
                <label
                  key={opt.id}
                  className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-3"
                >
                  <input
                    type="radio"
                    name="scope"
                    checked={scope === opt.id}
                    onChange={() => setScope(opt.id)}
                    className="h-4 w-4 accent-cyan-500"
                  />
                  <span className="text-sm text-slate-100">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold text-slate-400">区切り文字</div>
            <div className="flex gap-2">
              <label className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60">
                <input type="radio" checked={delimiter === ','} onChange={() => setDelimiter(',')} className="accent-cyan-500" />
                <span className="text-sm text-slate-100">カンマ ( , )</span>
              </label>
              <label className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60">
                <input type="radio" checked={delimiter === '\t'} onChange={() => setDelimiter('\t')} className="accent-cyan-500" />
                <span className="text-sm text-slate-100">タブ</span>
              </label>
            </div>
          </div>

          <div className="rounded-lg border border-slate-700 bg-slate-800/60 px-3">
            <Switch checked={bom} onChange={setBom} label="BOMを付与する" hint="Excelで開く場合はONを推奨" />
            <div className="border-t border-slate-700" />
            <Switch checked={includeMeta} onChange={setIncludeMeta} label="日時・定義名を含める" />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400">プレビュー（先頭5件）</span>
              <span className="text-xs text-slate-500">{scopedRecords.length}件中</span>
            </div>
            <div className="overflow-x-auto rounded-lg border border-slate-700">
              <table className="min-w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-800 text-slate-300">
                    {includeMeta && (
                      <>
                        <th className="whitespace-nowrap px-2 py-2 text-left font-semibold">日時</th>
                        <th className="whitespace-nowrap px-2 py-2 text-left font-semibold">ラベル定義</th>
                      </>
                    )}
                    {previewColumns.map((c) => (
                      <th key={c.key} className="whitespace-nowrap px-2 py-2 text-left font-semibold">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRecords.map((rec) => (
                    <tr key={rec.id} className="border-t border-slate-800 text-slate-200">
                      {includeMeta && (
                        <>
                          <td className="whitespace-nowrap px-2 py-2">{formatDateTime(rec.at)}</td>
                          <td className="whitespace-nowrap px-2 py-2">{rec.profileName}</td>
                        </>
                      )}
                      {previewColumns.map((c) => (
                        <td key={c.key} className="whitespace-nowrap px-2 py-2">
                          {rec.values[c.key]?.value ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {previewRecords.length === 0 && (
                    <tr>
                      <td className="px-2 py-4 text-center text-slate-500" colSpan={Math.max(1, previewColumns.length + (includeMeta ? 2 : 0))}>
                        {loading ? '読み込み中…' : '対象のレコードがありません'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div
        className="flex gap-2 border-t border-slate-800 p-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
      >
        <Button
          variant="secondary"
          size="lg"
          className="flex-1"
          loading={copying}
          disabled={scopedRecords.length === 0}
          onClick={() => void handleCopy()}
        >
          <CopyIcon className="h-4 w-4" /> コピー
        </Button>
        <Button
          variant="primary"
          size="lg"
          className="flex-1"
          loading={saving}
          disabled={scopedRecords.length === 0}
          onClick={handleSaveCsv}
        >
          <DownloadIcon className="h-4 w-4" /> CSVを保存
        </Button>
      </div>
    </div>
  )
}

function filterCount(records: ScanRecord[], request: ExportRequest): number {
  const { profileId, from, to } = request.filter
  return records.filter((r) => {
    if (profileId && r.profileId !== profileId) return false
    if (from !== undefined && r.at < from) return false
    if (to !== undefined && r.at > to) return false
    return true
  }).length
}
