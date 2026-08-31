// テストパッド。サンプルのバーコード文字列を1行ずつ貼り付けると、
// 編集中のプロファイルでリアルタイムに解析結果を確認できる。
// 未知のラベルの構造を調べるための主要な手段になる画面なので、常に見える位置に置く。

import { useMemo, useState } from 'react'
import type { Profile, RawScan } from '../parse/types'
import { applyProfile } from '../parse/engine'
import { listRecords } from '../store/records'
import { Button } from './components/Button'
import { Textarea } from './components/Controls'
import { showToast } from './components/toastBus'

type TestPadProps = {
  profile: Profile
}

export function TestPad({ profile }: TestPadProps) {
  const [text, setText] = useState('')
  const [loadingHistory, setLoadingHistory] = useState(false)

  const scans: RawScan[] = useMemo(() => {
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((value, i) => ({ value, source: 'barcode' as const, at: i }))
  }, [text])

  const parsed = useMemo(() => applyProfile(scans, profile), [scans, profile])

  async function pasteFromHistory() {
    setLoadingHistory(true)
    try {
      const records = await listRecords({ limit: 1 })
      const record = records[0]
      if (!record || record.rawScans.length === 0) {
        showToast('参照できるスキャン履歴がありません', 'error')
        return
      }
      setText(record.rawScans.map((s) => s.value).join('\n'))
    } catch {
      showToast('履歴の取得に失敗しました', 'error')
    } finally {
      setLoadingHistory(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-800/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-100">テストパッド</h3>
        <Button size="md" variant="secondary" loading={loadingHistory} onClick={() => void pasteFromHistory()}>
          スキャン履歴の生データから貼り付け
        </Button>
      </div>
      <p className="text-xs text-slate-500">1行 = 1本のバーコードとして扱います。貼り付けるたびに即座に解析します。</p>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder={'P12345\nQ10\n1TABC123'}
      />

      {scans.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg bg-slate-900 p-3">
          <div className="text-xs font-semibold text-slate-400">解析結果</div>
          <div className="flex flex-col gap-1.5">
            {profile.fields.map((f) => {
              const fv = parsed.values[f.key]
              const missing = parsed.missingRequired.includes(f.key)
              return (
                <div key={f.id} className="flex items-center gap-2 text-sm">
                  <span className="w-24 shrink-0 truncate text-slate-400">{f.label}</span>
                  {missing ? (
                    <span className="font-semibold text-red-400">未入力</span>
                  ) : fv?.error !== undefined ? (
                    <span className="font-semibold text-red-400">{fv.error}</span>
                  ) : fv !== undefined ? (
                    <span className="font-mono font-semibold text-emerald-400">{fv.value || '(空文字)'}</span>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </div>
              )
            })}
          </div>
          {parsed.unmatched.length > 0 && (
            <div className="border-t border-slate-800 pt-2 text-xs text-slate-500">
              未振り分け: {parsed.unmatched.map((u) => `「${u.value}」`).join('、')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
