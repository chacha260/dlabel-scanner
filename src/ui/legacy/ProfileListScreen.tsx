// ラベル定義の一覧画面。新規作成・複製・削除・JSON入出力の起点になる。
// 行をタップすると ProfileEditor を開く。

import { useState } from 'react'
import type { Profile } from '../../parse/types'
import { newProfileId } from '../../parse/engine'
import { PRESET_PROFILES } from '../../parse/presets'
import { deleteProfile, duplicateProfile, exportProfileJson, importProfileJson, saveProfile } from '../../store/profiles'
import { useProfiles } from '../../store/useStore'
import { Button } from '../components/Button'
import { Textarea } from '../components/Controls'
import { Sheet } from '../components/Sheet'
import { CheckIcon, CopyIcon, DuplicateIcon, PlusIcon, TrashIcon } from '../components/Icons'
import { showToast } from '../components/toastBus'
import { copyToClipboard } from '../lib'
import { ProfileEditor } from './ProfileEditor'

const BLANK_PROFILE_TEMPLATE: Omit<Profile, 'id'> = {
  name: '新しいラベル定義',
  splitMode: 'perBarcode',
  delimiters: [],
  collapseSpaces: false,
  completeWhen: 'allRequired',
  fields: [],
}

export function ProfileListScreen() {
  const { profiles, active, setActive, reload } = useProfiles()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftNewProfile, setDraftNewProfile] = useState<Profile | null>(null)
  const [newSheetOpen, setNewSheetOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null)
  const [exportText, setExportText] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  const editingProfile = profiles.find((p) => p.id === editingId) ?? null

  function startBlank() {
    setDraftNewProfile({ ...BLANK_PROFILE_TEMPLATE, id: newProfileId() })
    setNewSheetOpen(false)
  }

  function startFromPreset(preset: Profile) {
    setDraftNewProfile({ ...preset, id: newProfileId(), name: `${preset.name}（新規）` })
    setNewSheetOpen(false)
  }

  async function handleSaveNew(next: Profile) {
    try {
      await saveProfile(next)
      showToast('作成しました', 'success')
      setDraftNewProfile(null)
      void reload()
    } catch {
      showToast('作成に失敗しました', 'error')
    }
  }

  async function handleSaveExisting(next: Profile) {
    try {
      await saveProfile(next)
      showToast('保存しました', 'success')
      void reload()
    } catch {
      showToast('保存に失敗しました', 'error')
    }
  }

  async function handleDuplicate(id: string) {
    const result = await duplicateProfile(id)
    if ('error' in result) {
      showToast(result.error, 'error')
    } else {
      showToast('複製しました', 'success')
      void reload()
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const result = await deleteProfile(deleteTarget.id)
    if (result.error) {
      showToast(result.error, 'error')
    } else {
      showToast('削除しました', 'success')
      void reload()
    }
    setDeleteTarget(null)
  }

  async function handleExport(id: string) {
    const result = await exportProfileJson(id)
    if (typeof result === 'string') {
      setExportText(result)
    } else {
      showToast(result.error, 'error')
    }
  }

  async function handleImport() {
    setImporting(true)
    setImportError(null)
    try {
      const result = await importProfileJson(importText)
      if ('error' in result) {
        setImportError(result.error)
        return
      }
      showToast('読み込みました', 'success')
      setImportOpen(false)
      setImportText('')
      void reload()
    } finally {
      setImporting(false)
    }
  }

  if (draftNewProfile) {
    return <ProfileEditor profile={draftNewProfile} onSave={handleSaveNew} onCancel={() => setDraftNewProfile(null)} />
  }

  if (editingProfile) {
    return (
      <ProfileEditor
        key={editingProfile.id}
        profile={editingProfile}
        onSave={handleSaveExisting}
        onCancel={() => setEditingId(null)}
        onDelete={() => {
          setDeleteTarget(editingProfile)
          setEditingId(null)
        }}
      />
    )
  }

  return (
    <div className="flex h-full flex-col bg-slate-900">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 p-3">
        <h1 className="text-lg font-bold text-slate-100">定義</h1>
        <div className="flex gap-2">
          <Button size="md" variant="secondary" onClick={() => setImportOpen(true)}>
            JSON読み込み
          </Button>
          <Button size="md" variant="primary" onClick={() => setNewSheetOpen(true)}>
            <PlusIcon className="h-4 w-4" /> 新規作成
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="divide-y divide-slate-800">
          {profiles.map((p) => (
            <li key={p.id} className="p-3">
              <button type="button" onClick={() => setEditingId(p.id)} className="flex w-full items-start justify-between gap-2 text-left">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-bold text-slate-100">{p.name}</span>
                    {active?.id === p.id && (
                      <span className="shrink-0 rounded bg-cyan-400/15 px-1.5 py-0.5 text-[10px] font-bold text-cyan-300">
                        使用中
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">{p.fields.length} 項目</div>
                </div>
              </button>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {active?.id !== p.id && (
                  <button
                    type="button"
                    onClick={() => void setActive(p.id)}
                    className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-300 active:bg-slate-700"
                  >
                    <CheckIcon className="h-3.5 w-3.5" /> 使用中にする
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleDuplicate(p.id)}
                  className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-300 active:bg-slate-700"
                >
                  <DuplicateIcon className="h-3.5 w-3.5" /> 複製
                </button>
                <button
                  type="button"
                  onClick={() => void handleExport(p.id)}
                  className="rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-300 active:bg-slate-700"
                >
                  JSON書き出し
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(p)}
                  className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-red-400 active:bg-slate-700"
                >
                  <TrashIcon className="h-3.5 w-3.5" /> 削除
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <Sheet open={newSheetOpen} onClose={() => setNewSheetOpen(false)} title="新規作成">
        <div className="flex flex-col gap-2 p-4">
          <Button variant="secondary" size="lg" onClick={startBlank}>
            白紙から作成
          </Button>
          <div className="mt-2 text-xs font-semibold text-slate-400">プリセットから作成</div>
          {PRESET_PROFILES.map((preset) => (
            <Button key={preset.id} variant="secondary" size="lg" onClick={() => startFromPreset(preset)}>
              {preset.name}
            </Button>
          ))}
        </div>
      </Sheet>

      <Sheet open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="このラベル定義を削除しますか？">
        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-slate-400">「{deleteTarget?.name}」を削除します。この操作は取り消せません。</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="lg" className="flex-1" onClick={() => setDeleteTarget(null)}>
              戻る
            </Button>
            <Button variant="danger" size="lg" className="flex-1" onClick={() => void handleDelete()}>
              削除する
            </Button>
          </div>
        </div>
      </Sheet>

      <Sheet open={exportText !== null} onClose={() => setExportText(null)} title="JSON書き出し">
        <div className="flex flex-col gap-3 p-4">
          <Textarea value={exportText ?? ''} readOnly rows={14} />
          <Button
            variant="primary"
            size="lg"
            onClick={async () => {
              const ok = await copyToClipboard(exportText ?? '')
              showToast(ok ? 'コピーしました' : 'コピーに失敗しました', ok ? 'success' : 'error')
            }}
          >
            <CopyIcon className="h-4 w-4" /> コピー
          </Button>
        </div>
      </Sheet>

      <Sheet open={importOpen} onClose={() => setImportOpen(false)} title="JSON読み込み">
        <div className="flex flex-col gap-3 p-4">
          <Textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={14}
            placeholder="ここにラベル定義のJSONを貼り付け"
          />
          {importError !== null && <p className="text-sm font-medium text-red-400">{importError}</p>}
          <Button variant="primary" size="lg" loading={importing} disabled={importText.trim().length === 0} onClick={() => void handleImport()}>
            読み込む
          </Button>
        </div>
      </Sheet>
    </div>
  )
}
