// 生データ表示パネル。バッファ中の RawScan を加工せずそのまま並べる。
// 未知のラベルの構造を調べる手段になるため、省略せずコピーしやすく見せることを優先する。

import type { RawScan } from '../parse/types'
import { Sheet } from './components/Sheet'
import { Button } from './components/Button'
import { CopyIcon } from './components/Icons'
import { copyToClipboard, describeDelimiter, formatDateTime, sourceBadgeClass, sourceBadgeLabel } from './lib'
import { showToast } from './components/toastBus'

type RawDataPanelProps = {
  open: boolean
  onClose: () => void
  rawScans: RawScan[]
}

function scanLine(scan: RawScan): string {
  return `${scan.value}\t${sourceBadgeLabel(scan.source)}\t${scan.format ?? ''}\t${formatDateTime(scan.at)}`
}

async function copyOne(scan: RawScan): Promise<void> {
  const ok = await copyToClipboard(scan.value)
  showToast(ok ? 'コピーしました' : 'コピーに失敗しました', ok ? 'success' : 'error')
}

async function copyAll(rawScans: RawScan[]): Promise<void> {
  const text = rawScans.map(scanLine).join('\n')
  const ok = await copyToClipboard(text)
  showToast(ok ? '全件コピーしました' : 'コピーに失敗しました', ok ? 'success' : 'error')
}

export function RawDataPanel({ open, onClose, rawScans }: RawDataPanelProps) {
  return (
    <Sheet open={open} onClose={onClose} title={`生データ表示（${rawScans.length}件）`}>
      <div className="flex flex-col gap-3 p-4">
        <Button variant="secondary" onClick={() => void copyAll(rawScans)} disabled={rawScans.length === 0}>
          <CopyIcon className="h-4 w-4" /> 全部コピー
        </Button>

        {rawScans.length === 0 && (
          <p className="py-8 text-center text-sm text-slate-500">まだスキャンがありません</p>
        )}

        <ul className="flex flex-col gap-2">
          {rawScans.map((scan, i) => (
            <li key={`${scan.at}-${i}`} className="rounded-lg border border-slate-700 bg-slate-900 p-3">
              <div className="flex items-start justify-between gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-sm text-slate-100">
                  {scan.value === '' ? '(空文字)' : scan.value}
                </pre>
                <button
                  type="button"
                  onClick={() => void copyOne(scan)}
                  aria-label="この行をコピー"
                  className="shrink-0 rounded-lg border border-slate-600 p-2 text-slate-300 active:bg-slate-700"
                >
                  <CopyIcon className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span className={`rounded px-1.5 py-0.5 font-semibold ${sourceBadgeClass(scan.source)}`}>
                  {sourceBadgeLabel(scan.source)}
                </span>
                {scan.format !== undefined && <span>形式: {scan.format}</span>}
                <span>{formatDateTime(scan.at)}</span>
                <span>長さ: {scan.value.length}</span>
              </div>
            </li>
          ))}
        </ul>

        {rawScans.length > 0 && (
          <p className="pb-2 text-xs text-slate-500">
            ヒント: 制御文字や空白は見た目で分かりにくいことがあります。区切り位置が分からない場合は「定義」タブの
            テストパッドに貼り付けて確認してください（例: 区切り文字は {describeDelimiter('\t')} のように表示されます）。
          </p>
        )}
      </div>
    </Sheet>
  )
}
