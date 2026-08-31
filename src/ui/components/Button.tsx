// アプリ全体で使う共通ボタン。片手操作の倉庫現場を想定し、タップ領域を大きめに取る。

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { SpinnerIcon } from './Icons'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'
type Size = 'md' | 'lg'

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  variant?: Variant
  size?: Size
  loading?: boolean
  children: ReactNode
}

const variantClass: Record<Variant, string> = {
  primary: 'bg-cyan-500 text-slate-950 active:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500',
  secondary: 'bg-slate-700 text-slate-100 active:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500',
  danger: 'bg-red-600 text-white active:bg-red-500 disabled:bg-slate-800 disabled:text-slate-500',
  ghost: 'bg-transparent text-slate-200 active:bg-slate-800 disabled:text-slate-600',
}

const sizeClass: Record<Size, string> = {
  md: 'min-h-11 px-4 text-sm',
  lg: 'min-h-14 px-6 text-base',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold tracking-wide transition-colors select-none touch-manipulation ${variantClass[variant]} ${sizeClass[size]} ${className}`}
      {...rest}
    >
      {loading && <SpinnerIcon className="w-4 h-4" />}
      {children}
    </button>
  )
}
