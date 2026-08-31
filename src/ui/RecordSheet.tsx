// スキャン画面に常駐する「組み立て中レコード」表示パネル。
// プロファイルの各フィールドを1行ずつ表示し、タップで手入力/部分OCR/クリアができる。

import { useState } from 'react'
import type { FieldRule, FieldValue } from '../parse/types'
import { Button } from './components/Button'
import { TextInput } from './components/Controls'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, WarningIcon } from './components/Icons'
import { sourceBadgeClass, sourceBadgeLabel } from './lib'

type RecordSheetProps = {
  fields: FieldRule[]
  values: Record<string, FieldValue>
  missingRequired: string[]
  unmatchedCount: number
  onShowRaw: () => void
  onManualEdit: (key: string, value: string) => void
  onFieldOcr: (key: string) => void
  onClearField: (key: string) => void
  ocrBusyKey: string | null
}

type RowEditorProps = {
  field: FieldRule
  current: string
  ocrBusy: boolean
  onManualEdit: (value: string) => void
  onFieldOcr: () => void
  onClearField: () => void
  onClose: () => void
}

function RowEditor({ field, current, ocrBusy, onManualEdit, onFieldOcr, onClearField, onClose }: RowEditorProps) {
  const [text, setText] = useState(current)

  return (
    <div className="flex flex-col gap-2 border-t border-slate-700 bg-slate-950/60 p-3">
      <TextInput
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`${field.label} を手入力`}
        autoFocus
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="md"
          variant="primary"
          onClick={() => {
            onManualEdit(text)
            onClose()
          }}
        >
          <CheckIcon className="h-4 w-4" /> この内容で確定
        </Button>
        <Button size="md" variant="secondary" loading={ocrBusy} onClick={onFieldOcr}>
          この項目をOCRで読む
        </Button>
        <Button
          size="md"
          variant="danger"
          onClick={() => {
            onClearField()
            onClose()
          }}
        >
          クリア
        </Button>
      </div>
    </div>
  )
}

export function RecordSheet({
  fields,
  values,
  missingRequired,
  unmatchedCount,
  onShowRaw,
  onManualEdit,
  onFieldOcr,
  onClearField,
  ocrBusyKey,
}: RecordSheetProps) {
  const [editingKey, setEditingKey] = useState<string | null>(null)

  if (fields.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-slate-500">
        このラベル定義には項目がありません。「定義」タブで項目を追加してください。
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <ul className="divide-y divide-slate-800">
        {fields.map((field) => {
          const fv = values[field.key]
          const isMissing = missingRequired.includes(field.key)
          const isEditing = editingKey === field.key
          const displayValue = fv?.value ?? ''

          return (
            <li key={field.id}>
              <button
                type="button"
                onClick={() => setEditingKey(isEditing ? null : field.key)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left active:bg-slate-800/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 text-[11px] text-slate-400">
                    {field.label}
                    {field.required && <span className="text-red-400">*</span>}
                  </div>
                  {isMissing ? (
                    <div className="flex items-center gap-1 text-sm font-semibold text-red-400">
                      <WarningIcon className="h-4 w-4" /> 未入力
                    </div>
                  ) : fv?.error !== undefined ? (
                    <div className="text-sm font-semibold text-red-400">{fv.error}</div>
                  ) : (
                    <div className="truncate text-sm font-semibold text-slate-100">
                      {displayValue || '—'}
                    </div>
                  )}
                </div>
                {fv !== undefined && (
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${sourceBadgeClass(fv.source)}`}>
                    {sourceBadgeLabel(fv.source)}
                  </span>
                )}
                {isEditing ? (
                  <ChevronUpIcon className="h-4 w-4 shrink-0 text-slate-500" />
                ) : (
                  <ChevronDownIcon className="h-4 w-4 shrink-0 text-slate-500" />
                )}
              </button>

              {isEditing && (
                <RowEditor
                  key={field.key}
                  field={field}
                  current={displayValue}
                  ocrBusy={ocrBusyKey === field.key}
                  onManualEdit={(value) => onManualEdit(field.key, value)}
                  onFieldOcr={() => onFieldOcr(field.key)}
                  onClearField={() => onClearField(field.key)}
                  onClose={() => setEditingKey(null)}
                />
              )}
            </li>
          )
        })}
      </ul>

      <button
        type="button"
        onClick={onShowRaw}
        className="flex items-center justify-between px-3 py-2.5 text-sm text-slate-400 active:bg-slate-800/60"
      >
        <span>未振り分けの生データ</span>
        <span className={unmatchedCount > 0 ? 'font-bold text-amber-400' : 'text-slate-500'}>
          {unmatchedCount} 件 ›
        </span>
      </button>
    </div>
  )
}
