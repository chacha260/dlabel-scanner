// フォーム系の小さな共通部品。
//
// 以前はここに、入力の多いプロファイル編集・設定画面向けの `Field` / `TextInput` /
// `Textarea` と、区切り文字チップ用の `Chip` もあったが、それらの画面
// （src/ui/legacy/）を削除したのに伴い呼び出し元が無くなったため削除した
// （必要になれば git 履歴から復元できる）。

import type { SelectHTMLAttributes } from 'react'

const baseInputClass =
  'w-full min-h-11 rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none'

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
