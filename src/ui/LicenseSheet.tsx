// 「利用パッケージ類のライセンス情報を同梱すること」向けの、アプリ内ライセンス表示パネル。
// このアプリは完全オフライン・端末内完結（APK版は INTERNET 権限すら持たない）が
// 前提のため、サードパーティ製ライブラリのライセンス表記も外部サイトへのリンクではなく、
// ビルド成果物に静的に同梱し、オフラインのままアプリ内から閲覧できる必要がある。
//
// 一覧の中身（パッケージ名・バージョン・SPDX識別子・著作権者・ライセンス本文）は
// src/licenses/generated.ts（`pnpm run licenses` による自動生成物、詳細は
// docs/licenses.md）から普通に import する。ライセンス本文は全部で数十件・
// 合計するとかなりの文字数になるが、このファイルは HelpSheet.tsx と同様に
// SimpleScanScreen.tsx 側で React.lazy + Suspense を使って別チャンクとして
// 遅延読み込みされる前提のため、エントリーチャンクを太らせる心配はしていない。
//
// 見た目・構造（fixed inset-0 の全画面パネル、上部固定ヘッダ + 閉じるボタン、
// safe-area-inset の考慮、本文スクロール）は HelpSheet.tsx をそのまま踏襲する。
//
// z-index だけは HelpSheet（z-[70]）より1段高い z-[80] にしてある。このパネルは
// 使い方パネルの中のボタンから開く（＝ヘルプを開いたまま重ねて表示する）ため、
// 同じ z-[70] だと DOM の並び順に依存して前後関係が決まってしまい、
// SimpleScanScreen.tsx 側の JSX の順番を入れ替えただけで静かに背面へ回る
// （ヘルプに隠れて操作できなくなる）事故につながる。

import { useState } from 'react'
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from './components/Icons'
import { LICENSES } from '../licenses/generated'

type LicenseSheetProps = {
  onClose: () => void
}

// 各行はタップで開閉するアコーディオン。ライセンス本文は長いので、
// 一覧が縦に間延びしないよう既定では閉じた状態にする。
function LicenseRow({ name, version, spdx, author, homepage, licenseText }: (typeof LICENSES)[number]) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border-b border-slate-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left active:bg-slate-900"
      >
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-slate-100">{name}</p>
          <p className="mt-0.5 text-sm text-slate-400">
            v{version} ・ <span className="font-mono">{spdx}</span>
          </p>
        </div>
        {open ? (
          <ChevronUpIcon className="h-5 w-5 shrink-0 text-slate-400" />
        ) : (
          <ChevronDownIcon className="h-5 w-5 shrink-0 text-slate-400" />
        )}
      </button>

      {open && (
        <div className="space-y-3 px-5 pb-5">
          {author && <p className="text-sm text-slate-300">著作権者: {author}</p>}
          {homepage && <p className="break-all text-sm text-slate-400">配布元: {homepage}</p>}
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-slate-700 bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-300">
            {licenseText}
          </pre>
        </div>
      )}
    </div>
  )
}

export default function LicenseSheet({ onClose }: LicenseSheetProps) {
  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-slate-950 text-slate-100">
      {/* 上部バー: タイトルと閉じるボタン（×）。常に見える位置に固定する */}
      <div
        className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <h1 className="text-xl font-bold text-slate-100">ライセンス情報</h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="ライセンス情報を閉じる"
          className="rounded-full p-2 text-slate-300 active:bg-slate-800"
        >
          <CloseIcon className="h-7 w-7" />
        </button>
      </div>

      {/* 本文（スクロール） */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-3 border-b border-slate-800 px-5 py-6 text-base leading-relaxed text-slate-200">
          <p>
            このアプリは、下の一覧に挙げるオープンソースソフトウェア（OCRエンジンの tesseract.js、
            バーコード読み取りの zxing-wasm、React など）を利用して作られています。各行をタップすると、
            そのソフトウェアのライセンス本文を開閉できます。
          </p>
          <p className="rounded-lg border border-amber-500/50 bg-amber-950/40 p-3.5 text-sm font-semibold text-amber-200">
            ライセンス本文は翻訳・改変を行わず、配布されている原文（英語）のまま掲載しています。
          </p>
        </div>

        <div>
          {LICENSES.map((entry) => (
            <LicenseRow key={`${entry.name}@${entry.version}`} {...entry} />
          ))}
        </div>

        {/* スクロールを戻さなくても閉じられるよう、末尾にも閉じるボタンを置く */}
        <div className="px-5 py-7" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.75rem)' }}>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-14 w-full items-center justify-center rounded-xl bg-cyan-500 text-base font-bold text-slate-950 active:bg-cyan-400"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
