// 履歴画面。保存済みレコードを新しい順に表示し、絞り込み・詳細確認・編集・削除・
// 書き出し画面への導線を提供する。

import { useMemo, useState } from 'react'
import type { ScanRecord } from '../store/db'
import type { RecordFilter } from '../store/records'
import { deleteRecord, deleteRecords, updateRecord } from '../store/records'
import { useProfiles, useRecords } from '../store/useStore'
import { Button } from './components/Button'
import { Select, TextInput, Textarea } from './components/Controls'
import { Sheet } from './components/Sheet'
import { EditIcon, FilterIcon, TrashIcon } from './components/Icons'
import { showToast } from './components/toastBus'
import { formatDateTime, formatTime, sourceBadgeClass, sourceBadgeLabel } from './lib'

export type ExportRequest = {
  initialScope: 'all' | 'filtered' | 'selected'
  filter: RecordFilter
  selectedIds: string[]
}

type HistoryScreenProps = {
  onOpenExport: (req: ExportRequest) => void
}

type DetailProps = {
  record: ScanRecord
  onClose: () => void
  onChanged: () => void
}

function RecordDetail({ record, onClose, onChanged }: DetailProps) {
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(record.columns.map((c) => [c.key, record.values[c.key]?.value ?? ''])),
  )
  const [note, setNote] = useState(record.note ?? '')
  const [saving, setSaving] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const nextValues: ScanRecord['values'] = { ...record.values }
      for (const col of record.columns) {
        const prev = nextValues[col.key]
        nextValues[col.key] = {
          key: col.key,
          label: col.label,
          value: values[col.key] ?? '',
          source: prev?.source ?? 'manual',
        }
      }
      await updateRecord({ ...record, values: nextValues, note: note || undefined })
      showToast('更新しました', 'success')
      setEditing(false)
      onChanged()
    } catch {
      showToast('更新に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    try {
      await deleteRecord(record.id)
      showToast('削除しました', 'success')
      onChanged()
      onClose()
    } catch {
      showToast('削除に失敗しました', 'error')
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="text-xs text-slate-500">
        {formatDateTime(record.at)} ・ {record.profileName}
      </div>

      <div className="flex flex-col gap-3">
        {record.columns.map((col) => {
          const fv = record.values[col.key]
          return (
            <div key={col.key}>
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-slate-400">
                {col.label}
                {fv !== undefined && (
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${sourceBadgeClass(fv.source)}`}>
                    {sourceBadgeLabel(fv.source)}
                  </span>
                )}
              </div>
              {editing ? (
                <TextInput value={values[col.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [col.key]: e.target.value }))} />
              ) : (
                <div className="min-h-11 rounded-lg bg-slate-900 px-3 py-2.5 text-sm text-slate-100">
                  {values[col.key] || '—'}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div>
        <div className="mb-1 text-xs font-semibold text-slate-400">メモ</div>
        {editing ? (
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="メモを入力" />
        ) : (
          <div className="min-h-11 rounded-lg bg-slate-900 px-3 py-2.5 text-sm text-slate-300">{note || '（なし）'}</div>
        )}
      </div>

      <details className="rounded-lg border border-slate-700">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-300">
          生データ（{record.rawScans.length}件）
        </summary>
        <ul className="flex flex-col gap-2 border-t border-slate-700 p-3">
          {record.rawScans.map((scan, i) => (
            <li key={i} className="rounded bg-slate-900 p-2">
              <pre className="whitespace-pre-wrap break-all font-mono text-xs text-slate-200">{scan.value}</pre>
              <div className="mt-1 flex gap-2 text-[11px] text-slate-500">
                <span className={`rounded px-1 font-bold ${sourceBadgeClass(scan.source)}`}>{sourceBadgeLabel(scan.source)}</span>
                <span>{formatTime(scan.at)}</span>
              </div>
            </li>
          ))}
        </ul>
      </details>

      <div className="flex gap-2">
        {editing ? (
          <>
            <Button variant="secondary" size="lg" className="flex-1" onClick={() => setEditing(false)}>
              キャンセル
            </Button>
            <Button variant="primary" size="lg" className="flex-1" loading={saving} onClick={() => void handleSave()}>
              保存
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="lg" className="flex-1" onClick={() => setEditing(true)}>
              <EditIcon className="h-4 w-4" /> 編集
            </Button>
            <Button variant="danger" size="lg" className="flex-1" onClick={() => setConfirmDeleteOpen(true)}>
              <TrashIcon className="h-4 w-4" /> 削除
            </Button>
          </>
        )}
      </div>

      <Sheet open={confirmDeleteOpen} onClose={() => setConfirmDeleteOpen(false)} title="このレコードを削除しますか？">
        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-slate-400">この操作は取り消せません。</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="lg" className="flex-1" onClick={() => setConfirmDeleteOpen(false)}>
              戻る
            </Button>
            <Button variant="danger" size="lg" className="flex-1" onClick={() => void handleDelete()}>
              削除する
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  )
}

export function HistoryScreen({ onOpenExport }: HistoryScreenProps) {
  const { profiles } = useProfiles()
  const [profileFilter, setProfileFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [detailId, setDetailId] = useState<string | null>(null)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

  const filter: RecordFilter = useMemo(() => {
    const f: RecordFilter = {}
    if (profileFilter) f.profileId = profileFilter
    if (fromDate) f.from = new Date(`${fromDate}T00:00:00`).getTime()
    if (toDate) f.to = new Date(`${toDate}T23:59:59.999`).getTime()
    return f
  }, [profileFilter, fromDate, toDate])

  const { records, reload, loading } = useRecords(filter)

  const detailRecord = records.find((r) => r.id === detailId) ?? null
  const filterActive = Boolean(profileFilter || fromDate || toDate)

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleBulkDelete() {
    try {
      await deleteRecords(Array.from(selectedIds))
      showToast(`${selectedIds.size}件削除しました`, 'success')
      setSelectedIds(new Set())
      setSelectMode(false)
      void reload()
    } catch {
      showToast('削除に失敗しました', 'error')
    } finally {
      setBulkDeleteOpen(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-slate-900">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 p-3">
        <h1 className="text-lg font-bold text-slate-100">履歴</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFilterOpen(true)}
            className={`flex items-center gap-1 rounded-lg px-3 py-2 text-xs font-semibold ${filterActive ? 'bg-cyan-400/15 text-cyan-300' : 'bg-slate-800 text-slate-300'}`}
          >
            <FilterIcon className="h-4 w-4" /> 絞り込み
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectMode((v) => !v)
              setSelectedIds(new Set())
            }}
            className="rounded-lg bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300"
          >
            {selectMode ? '選択終了' : '選択'}
          </button>
        </div>
      </div>

      {selectMode && (
        <div className="flex items-center justify-between gap-2 border-b border-slate-800 bg-slate-800/60 p-2 px-3">
          <span className="text-xs text-slate-300">{selectedIds.size}件選択中</span>
          <div className="flex gap-2">
            <Button
              size="md"
              variant="secondary"
              disabled={selectedIds.size === 0}
              onClick={() => onOpenExport({ initialScope: 'selected', filter, selectedIds: Array.from(selectedIds) })}
            >
              選択分を書き出し
            </Button>
            <Button size="md" variant="danger" disabled={selectedIds.size === 0} onClick={() => setBulkDeleteOpen(true)}>
              <TrashIcon className="h-4 w-4" /> 削除
            </Button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loading && <p className="p-6 text-center text-sm text-slate-500">読み込み中…</p>}
        {!loading && records.length === 0 && (
          <p className="p-6 text-center text-sm text-slate-500">該当するレコードがありません</p>
        )}
        <ul className="divide-y divide-slate-800">
          {records.map((rec) => {
            const preview = rec.columns
              .slice(0, 3)
              .map((c) => rec.values[c.key]?.value)
              .filter((v) => v !== undefined && v !== '')
              .join(' / ')
            return (
              <li key={rec.id}>
                <button
                  type="button"
                  onClick={() => (selectMode ? toggleSelected(rec.id) : setDetailId(rec.id))}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-800/60"
                >
                  {selectMode && (
                    <input
                      type="checkbox"
                      readOnly
                      checked={selectedIds.has(rec.id)}
                      className="h-5 w-5 shrink-0 accent-cyan-500"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-slate-500">
                      {formatTime(rec.at)} ・ {rec.profileName}
                    </div>
                    <div className="truncate text-sm font-medium text-slate-100">{preview || '（値なし）'}</div>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="border-t border-slate-800 p-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}>
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={() => onOpenExport({ initialScope: filterActive ? 'filtered' : 'all', filter, selectedIds: [] })}
        >
          書き出し
        </Button>
      </div>

      <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="絞り込み">
        <div className="flex flex-col gap-4 p-4">
          <div>
            <div className="mb-1 text-xs font-semibold text-slate-400">ラベル定義</div>
            <Select
              value={profileFilter}
              onChange={(e) => setProfileFilter(e.target.value)}
              options={[{ value: '', label: 'すべて' }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <div className="mb-1 text-xs font-semibold text-slate-400">開始日</div>
              <TextInput type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} max={toDate || undefined} />
            </div>
            <div className="flex-1">
              <div className="mb-1 text-xs font-semibold text-slate-400">終了日</div>
              <TextInput type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} min={fromDate || undefined} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="lg"
              className="flex-1"
              onClick={() => {
                setProfileFilter('')
                setFromDate('')
                setToDate('')
              }}
            >
              条件をクリア
            </Button>
            <Button variant="primary" size="lg" className="flex-1" onClick={() => setFilterOpen(false)}>
              閉じる
            </Button>
          </div>
        </div>
      </Sheet>

      <Sheet open={detailRecord !== null} onClose={() => setDetailId(null)} title="レコード詳細">
        {detailRecord && <RecordDetail record={detailRecord} onClose={() => setDetailId(null)} onChanged={() => void reload()} />}
      </Sheet>

      <Sheet open={bulkDeleteOpen} onClose={() => setBulkDeleteOpen(false)} title={`${selectedIds.size}件を削除しますか？`}>
        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-slate-400">この操作は取り消せません。</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="lg" className="flex-1" onClick={() => setBulkDeleteOpen(false)}>
              戻る
            </Button>
            <Button variant="danger" size="lg" className="flex-1" onClick={() => void handleBulkDelete()}>
              削除する
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  )
}
