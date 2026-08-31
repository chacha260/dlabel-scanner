// 1項目分のルール（FieldRule）を編集するカード。
// マッチ方法（5種類）ごとに必要な入力を出し分け、変換（TransformStep）は
// 順序付きリストとして追加・削除・並べ替えできるようにする。

import { useState } from 'react'
import type { FieldRule, Matcher, TransformStep } from '../parse/types'
import { Field, Select, Switch, TextInput } from './components/Controls'
import { ChevronDownIcon, ChevronUpIcon, TrashIcon } from './components/Icons'
import { MATCHER_EXPLANATIONS, MATCHER_LABELS, TRANSFORM_LABELS } from './lib'

type FieldRuleEditorProps = {
  field: FieldRule
  index: number
  count: number
  onChange: (next: FieldRule) => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}

function suggestKey(label: string): string {
  return label.trim().replace(/\s+/g, '_').replace(/["'`]/g, '')
}

function defaultMatcher(kind: Matcher['kind']): Matcher {
  if (kind === 'prefix') return { kind: 'prefix', value: '', strip: true, caseSensitive: false }
  if (kind === 'index') return { kind: 'index', index: 0 }
  if (kind === 'fixed') return { kind: 'fixed', start: 0, length: 1 }
  if (kind === 'regex') return { kind: 'regex', pattern: '', flags: '', group: 0 }
  return { kind: 'rest' }
}

function defaultTransform(kind: TransformStep['kind']): TransformStep {
  if (kind === 'slice') return { kind: 'slice', start: 0 }
  if (kind === 'replace') return { kind: 'replace', pattern: '', flags: 'g', replacement: '' }
  return { kind }
}

const MATCHER_OPTIONS = (['prefix', 'index', 'fixed', 'regex', 'rest'] as const).map((k) => ({
  value: k,
  label: MATCHER_LABELS[k],
}))

const TRANSFORM_OPTIONS = (['trim', 'upper', 'lower', 'stripLeadingZeros', 'toNumber', 'slice', 'replace'] as const).map(
  (k) => ({ value: k, label: TRANSFORM_LABELS[k] }),
)

function MatcherEditor({ matcher, onChange }: { matcher: Matcher; onChange: (m: Matcher) => void }) {
  if (matcher.kind === 'prefix') {
    return (
      <div className="flex flex-col gap-3">
        <Field label="接頭辞の値">
          <TextInput value={matcher.value} onChange={(e) => onChange({ ...matcher, value: e.target.value })} placeholder="例: P" />
        </Field>
        <Switch checked={matcher.strip} onChange={(v) => onChange({ ...matcher, strip: v })} label="接頭辞を取り除く" />
        <Switch
          checked={matcher.caseSensitive}
          onChange={(v) => onChange({ ...matcher, caseSensitive: v })}
          label="大文字小文字を区別する"
        />
      </div>
    )
  }
  if (matcher.kind === 'index') {
    return (
      <Field label="何番目のセグメントか（1から数えます）">
        <TextInput
          type="number"
          min={1}
          value={matcher.index + 1}
          onChange={(e) => {
            const n = Number(e.target.value)
            onChange({ ...matcher, index: Number.isFinite(n) && n >= 1 ? n - 1 : 0 })
          }}
        />
      </Field>
    )
  }
  if (matcher.kind === 'fixed') {
    return (
      <div className="flex gap-3">
        <Field label="開始位置（0から数えます）" className="flex-1">
          <TextInput
            type="number"
            min={0}
            value={matcher.start}
            onChange={(e) => onChange({ ...matcher, start: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
        <Field label="長さ" className="flex-1">
          <TextInput
            type="number"
            min={0}
            value={matcher.length}
            onChange={(e) => onChange({ ...matcher, length: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
      </div>
    )
  }
  if (matcher.kind === 'regex') {
    return (
      <div className="flex flex-col gap-3">
        <Field label="パターン">
          <TextInput
            value={matcher.pattern}
            onChange={(e) => onChange({ ...matcher, pattern: e.target.value })}
            placeholder="例: ^Q(\\d+)$"
          />
        </Field>
        <div className="flex gap-3">
          <Field label="フラグ" className="flex-1">
            <TextInput value={matcher.flags ?? ''} onChange={(e) => onChange({ ...matcher, flags: e.target.value })} placeholder="例: i" />
          </Field>
          <Field label="グループ番号" className="flex-1">
            <TextInput
              type="number"
              min={0}
              value={matcher.group}
              onChange={(e) => onChange({ ...matcher, group: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>
        </div>
      </div>
    )
  }
  return <p className="text-xs text-slate-500">入力項目はありません。</p>
}

function TransformRow({
  step,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  step: TransformStep
  onChange: (s: TransformStep) => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-900 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-100">{TRANSFORM_LABELS[step.kind]}</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onMoveUp} className="rounded p-1 text-slate-400 active:bg-slate-800">
            <ChevronUpIcon className="h-4 w-4" />
          </button>
          <button type="button" onClick={onMoveDown} className="rounded p-1 text-slate-400 active:bg-slate-800">
            <ChevronDownIcon className="h-4 w-4" />
          </button>
          <button type="button" onClick={onRemove} className="rounded p-1 text-red-400 active:bg-slate-800">
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
      {step.kind === 'slice' && (
        <div className="flex gap-2">
          <TextInput
            type="number"
            value={step.start}
            onChange={(e) => onChange({ ...step, start: Number(e.target.value) || 0 })}
            placeholder="開始"
          />
          <TextInput
            type="number"
            value={step.end ?? ''}
            onChange={(e) => onChange({ ...step, end: e.target.value === '' ? undefined : Number(e.target.value) })}
            placeholder="終了（省略可）"
          />
        </div>
      )}
      {step.kind === 'replace' && (
        <div className="flex flex-col gap-2">
          <TextInput value={step.pattern} onChange={(e) => onChange({ ...step, pattern: e.target.value })} placeholder="正規表現パターン" />
          <div className="flex gap-2">
            <TextInput value={step.flags} onChange={(e) => onChange({ ...step, flags: e.target.value })} placeholder="フラグ 例: g" />
            <TextInput
              value={step.replacement}
              onChange={(e) => onChange({ ...step, replacement: e.target.value })}
              placeholder="置換後の文字列"
            />
          </div>
        </div>
      )}
    </div>
  )
}

export function FieldRuleEditor({ field, index, count, onChange, onRemove, onMoveUp, onMoveDown }: FieldRuleEditorProps) {
  const [expanded, setExpanded] = useState(false)
  const [keyTouched, setKeyTouched] = useState(field.key !== suggestKey(field.label))

  function handleLabelChange(label: string) {
    const next: FieldRule = { ...field, label }
    if (!keyTouched) next.key = suggestKey(label)
    onChange(next)
  }

  const hasValidate = field.validate !== undefined

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/60">
      <div className="flex items-center gap-2 p-3">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {expanded ? (
            <ChevronUpIcon className="h-4 w-4 shrink-0 text-slate-400" />
          ) : (
            <ChevronDownIcon className="h-4 w-4 shrink-0 text-slate-400" />
          )}
          <span className="truncate text-sm font-semibold text-slate-100">
            {field.label || '（無題の項目）'}
            {field.required && <span className="ml-1 text-red-400">*</span>}
          </span>
          <span className="shrink-0 text-xs text-slate-500">{MATCHER_LABELS[field.match.kind]}</span>
        </button>
        <button type="button" onClick={onMoveUp} disabled={index === 0} className="rounded p-1.5 text-slate-400 disabled:opacity-30">
          <ChevronUpIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={index === count - 1}
          className="rounded p-1.5 text-slate-400 disabled:opacity-30"
        >
          <ChevronDownIcon className="h-4 w-4" />
        </button>
        <button type="button" onClick={onRemove} className="rounded p-1.5 text-red-400 active:bg-slate-700">
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>

      {expanded && (
        <div className="flex flex-col gap-4 border-t border-slate-700 p-3">
          <div className="flex gap-3">
            <Field label="表示名" className="flex-1">
              <TextInput value={field.label} onChange={(e) => handleLabelChange(e.target.value)} placeholder="例: 品番" />
            </Field>
            <Field label="CSV列名" className="flex-1">
              <TextInput
                value={field.key}
                onChange={(e) => {
                  setKeyTouched(true)
                  onChange({ ...field, key: e.target.value })
                }}
                placeholder="例: part_no"
              />
            </Field>
          </div>

          <Field label="対象">
            <Select
              value={field.source}
              onChange={(e) => onChange({ ...field, source: e.target.value as FieldRule['source'] })}
              options={[
                { value: 'barcode', label: 'バーコード' },
                { value: 'ocr', label: 'OCR' },
                { value: 'both', label: '両方' },
              ]}
            />
          </Field>

          <Field label="マッチ方法" hint={MATCHER_EXPLANATIONS[field.match.kind]}>
            <Select
              value={field.match.kind}
              onChange={(e) => onChange({ ...field, match: defaultMatcher(e.target.value as Matcher['kind']) })}
              options={MATCHER_OPTIONS}
            />
          </Field>
          <MatcherEditor matcher={field.match} onChange={(m) => onChange({ ...field, match: m })} />

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400">変換（上から順に適用）</span>
              <Select
                className="max-w-[9.5rem] min-h-9 text-xs"
                value=""
                onChange={(e) => {
                  const kind = e.target.value as TransformStep['kind']
                  onChange({ ...field, transforms: [...field.transforms, defaultTransform(kind)] })
                }}
                options={[{ value: '', label: '追加…' }, ...TRANSFORM_OPTIONS]}
              />
            </div>
            {field.transforms.length === 0 ? (
              <p className="text-xs text-slate-500">変換はありません</p>
            ) : (
              <div className="flex flex-col gap-2">
                {field.transforms.map((step, i) => (
                  <TransformRow
                    key={i}
                    step={step}
                    onChange={(s) => {
                      const next = [...field.transforms]
                      next[i] = s
                      onChange({ ...field, transforms: next })
                    }}
                    onRemove={() => onChange({ ...field, transforms: field.transforms.filter((_, j) => j !== i) })}
                    onMoveUp={() => {
                      if (i === 0) return
                      const next = [...field.transforms]
                      ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                      onChange({ ...field, transforms: next })
                    }}
                    onMoveDown={() => {
                      if (i === field.transforms.length - 1) return
                      const next = [...field.transforms]
                      ;[next[i + 1], next[i]] = [next[i], next[i + 1]]
                      onChange({ ...field, transforms: next })
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          <Switch checked={field.required} onChange={(v) => onChange({ ...field, required: v })} label="必須項目にする" />

          <div>
            <Switch
              checked={hasValidate}
              onChange={(v) => onChange({ ...field, validate: v ? {} : undefined })}
              label="検証を有効にする"
              hint="正規表現・文字数の下限/上限を指定できます"
            />
            {hasValidate && (
              <div className="flex flex-col gap-3">
                <Field label="正規表現パターン（値全体に一致する必要があります）">
                  <TextInput
                    value={field.validate?.pattern ?? ''}
                    onChange={(e) => onChange({ ...field, validate: { ...field.validate, pattern: e.target.value || undefined } })}
                  />
                </Field>
                <div className="flex gap-3">
                  <Field label="最小文字数" className="flex-1">
                    <TextInput
                      type="number"
                      min={0}
                      value={field.validate?.minLen ?? ''}
                      onChange={(e) =>
                        onChange({
                          ...field,
                          validate: { ...field.validate, minLen: e.target.value === '' ? undefined : Number(e.target.value) },
                        })
                      }
                    />
                  </Field>
                  <Field label="最大文字数" className="flex-1">
                    <TextInput
                      type="number"
                      min={0}
                      value={field.validate?.maxLen ?? ''}
                      onChange={(e) =>
                        onChange({
                          ...field,
                          validate: { ...field.validate, maxLen: e.target.value === '' ? undefined : Number(e.target.value) },
                        })
                      }
                    />
                  </Field>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

