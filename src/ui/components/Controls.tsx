// フォーム系の小さな共通部品。プロファイル編集・設定画面など入力が多い画面で使い回す。

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { CloseIcon } from './Icons'

type FieldProps = {
  label: string
  hint?: string
  error?: string
  children: ReactNode
  className?: string
}

/** ラベル・入力・補足・エラーをまとめる汎用ラッパー */
export function Field({ label, hint, error, children, className = '' }: FieldProps) {
  return (
    <label className={`block ${className}`}>
      <div className="mb-1 text-xs font-semibold text-slate-400">{label}</div>
      {children}
      {hint !== undefined && <div className="mt-1 text-xs leading-snug text-slate-500">{hint}</div>}
      {error !== undefined && <div className="mt-1 text-xs font-medium text-red-400">{error}</div>}
    </label>
  )
}

const baseInputClass =
  'w-full min-h-11 rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none'

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props
  return <input className={`${baseInputClass} ${className}`} {...rest} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props
  return (
    <textarea
      className={`w-full min-h-24 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none font-mono ${className}`}
      {...rest}
    />
  )
}

type SelectOption = { value: string; label: string }

export function Select(
  props: SelectHTMLAttributes<HTMLSelectElement> & { options: SelectOption[] },
) {
  const { options, className = '', ...rest } = props
  return (
    <select className={`${baseInputClass} ${className}`} {...rest}>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}

type SwitchProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}

/** 設定画面の ON/OFF 用トグルスイッチ */
export function Switch({ checked, onChange, label, hint, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full min-h-12 items-center justify-between gap-3 py-2 text-left touch-manipulation disabled:opacity-50"
    >
      <span>
        <span className="block text-sm font-medium text-slate-100">{label}</span>
        {hint !== undefined && <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>}
      </span>
      <span
        className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-cyan-500' : 'bg-slate-600'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </span>
    </button>
  )
}

type ChipProps = {
  label: string
  onRemove?: () => void
  onClick?: () => void
  active?: boolean
}

/** 削除可能・選択可能な小さなピル型ボタン（区切り文字チップなど） */
export function Chip({ label, onRemove, onClick, active = false }: ChipProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium touch-manipulation ${
        active
          ? 'border-cyan-400 bg-cyan-400/10 text-cyan-300'
          : 'border-slate-600 bg-slate-800 text-slate-200'
      }`}
    >
      {onClick ? (
        <button type="button" onClick={onClick} className="min-h-6">
          {label}
        </button>
      ) : (
        <span>{label}</span>
      )}
      {onRemove !== undefined && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`${label} を削除`}
          className="rounded-full p-0.5 text-slate-400 active:text-red-400"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </span>
  )
}
