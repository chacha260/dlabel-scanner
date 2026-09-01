// ラベル定義（プロファイル）の編集画面。全体設定（分割方法・区切り文字など）と
// 項目リスト、そして常時表示のテストパッドで構成する。

import { useState } from 'react'
import type { FieldRule, Profile } from '../../parse/types'
import { newFieldId } from '../../parse/engine'
import { Button } from '../components/Button'
import { Chip, Field, Switch, TextInput } from '../components/Controls'
import { BackIcon, PlusIcon, TrashIcon } from '../components/Icons'
import { DELIMITER_PRESETS, describeDelimiter } from '../lib'
import { FieldRuleEditor } from './FieldRuleEditor'
import { TestPad } from './TestPad'

type ProfileEditorProps = {
  profile: Profile
  onSave: (next: Profile) => Promise<void>
  onCancel: () => void
  onDelete?: () => void
}

function newField(): FieldRule {
  return {
    id: newFieldId(),
    label: '新しい項目',
    key: `field_${Math.floor(Math.random() * 100000)}`,
    source: 'both',
    match: { kind: 'rest' },
    transforms: [{ kind: 'trim' }],
    required: false,
  }
}

export function ProfileEditor({ profile, onSave, onCancel, onDelete }: ProfileEditorProps) {
  const [draft, setDraft] = useState<Profile>(profile)
  const [customDelimiter, setCustomDelimiter] = useState('')
  const [saving, setSaving] = useState(false)

  function updateField(index: number, next: FieldRule) {
    const fields = [...draft.fields]
    fields[index] = next
    setDraft({ ...draft, fields })
  }

  function removeField(index: number) {
    setDraft({ ...draft, fields: draft.fields.filter((_, i) => i !== index) })
  }

  function moveField(index: number, dir: -1 | 1) {
    const target = index + dir
    if (target < 0 || target >= draft.fields.length) return
    const fields = [...draft.fields]
    ;[fields[index], fields[target]] = [fields[target], fields[index]]
    setDraft({ ...draft, fields })
  }

  function addDelimiter(value: string) {
    if (value.length === 0 || draft.delimiters.includes(value)) return
    setDraft({ ...draft, delimiters: [...draft.delimiters, value] })
  }

  function removeDelimiter(value: string) {
    setDraft({ ...draft, delimiters: draft.delimiters.filter((d) => d !== value) })
  }

  async function handleSave() {
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  const unusedPresets = DELIMITER_PRESETS.filter((p) => !draft.delimiters.includes(p.value))

  return (
    <div className="flex h-full flex-col bg-slate-900">
      <div className="flex items-center gap-2 border-b border-slate-800 p-3">
        <button type="button" onClick={onCancel} aria-label="戻る" className="rounded-lg p-2 text-slate-300 active:bg-slate-800">
          <BackIcon className="h-5 w-5" />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-slate-100">{draft.name || 'ラベル定義の編集'}</h1>
        <Button variant="primary" size="md" loading={saving} onClick={() => void handleSave()}>
          保存
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-5">
          <Field label="名前">
            <TextInput value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>

          <div>
            <div className="mb-2 text-xs font-semibold text-slate-400">読み取り方式</div>
            <div className="flex flex-col gap-2">
              <label className="flex min-h-11 items-start gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2.5">
                <input
                  type="radio"
                  className="mt-1 accent-cyan-500"
                  checked={draft.splitMode === 'perBarcode'}
                  onChange={() => setDraft({ ...draft, splitMode: 'perBarcode' })}
                />
                <span className="text-sm text-slate-100">バーコード1本＝1項目（接頭辞で判別）</span>
              </label>
              <label className="flex min-h-11 items-start gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2.5">
                <input
                  type="radio"
                  className="mt-1 accent-cyan-500"
                  checked={draft.splitMode === 'splitOne'}
                  onChange={() => setDraft({ ...draft, splitMode: 'splitOne' })}
                />
                <span className="text-sm text-slate-100">1本を区切って複数項目に分解</span>
              </label>
            </div>
          </div>

          {draft.splitMode === 'splitOne' && (
            <div>
              <div className="mb-2 text-xs font-semibold text-slate-400">区切り文字</div>
              <div className="flex flex-wrap gap-2">
                {draft.delimiters.map((d) => (
                  <Chip key={d} label={describeDelimiter(d)} onRemove={() => removeDelimiter(d)} />
                ))}
                {draft.delimiters.length === 0 && <span className="text-xs text-slate-500">未設定</span>}
              </div>
              {unusedPresets.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {unusedPresets.map((p) => (
                    <Chip key={p.value} label={`+ ${p.label}`} onClick={() => addDelimiter(p.value)} />
                  ))}
                </div>
              )}
              <div className="mt-2 flex gap-2">
                <TextInput
                  value={customDelimiter}
                  onChange={(e) => setCustomDelimiter(e.target.value)}
                  placeholder="任意の区切り文字を入力"
                  className="flex-1"
                />
                <Button
                  variant="secondary"
                  onClick={() => {
                    addDelimiter(customDelimiter)
                    setCustomDelimiter('')
                  }}
                >
                  <PlusIcon className="h-4 w-4" /> 追加
                </Button>
              </div>
              <div className="mt-3">
                <Switch
                  checked={draft.collapseSpaces}
                  onChange={(v) => setDraft({ ...draft, collapseSpaces: v })}
                  label="連続する空白をまとめる"
                  hint="分割前に連続した空白文字を1個にまとめます"
                />
              </div>
            </div>
          )}

          <div>
            <div className="mb-2 text-xs font-semibold text-slate-400">完了の判定</div>
            <div className="flex flex-col gap-2">
              <label className="flex min-h-11 items-start gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2.5">
                <input
                  type="radio"
                  className="mt-1 accent-cyan-500"
                  checked={draft.completeWhen === 'allRequired'}
                  onChange={() => setDraft({ ...draft, completeWhen: 'allRequired' })}
                />
                <span className="text-sm text-slate-100">必須項目がすべて埋まったら完了とする</span>
              </label>
              <label className="flex min-h-11 items-start gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2.5">
                <input
                  type="radio"
                  className="mt-1 accent-cyan-500"
                  checked={draft.completeWhen === 'manual'}
                  onChange={() => setDraft({ ...draft, completeWhen: 'manual' })}
                />
                <span className="text-sm text-slate-100">完了判定をしない（いつでも確定できる）</span>
              </label>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400">項目（{draft.fields.length}）</span>
              <Button size="md" variant="secondary" onClick={() => setDraft({ ...draft, fields: [...draft.fields, newField()] })}>
                <PlusIcon className="h-4 w-4" /> 項目を追加
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              {draft.fields.map((field, i) => (
                <FieldRuleEditor
                  key={field.id}
                  field={field}
                  index={i}
                  count={draft.fields.length}
                  onChange={(next) => updateField(i, next)}
                  onRemove={() => removeField(i)}
                  onMoveUp={() => moveField(i, -1)}
                  onMoveDown={() => moveField(i, 1)}
                />
              ))}
              {draft.fields.length === 0 && <p className="text-sm text-slate-500">項目がありません。追加してください。</p>}
            </div>
          </div>

          <TestPad profile={draft} />

          {onDelete && (
            <Button variant="danger" size="lg" onClick={onDelete}>
              <TrashIcon className="h-4 w-4" /> このラベル定義を削除
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
