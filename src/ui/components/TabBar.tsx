// 画面下部の固定タブバー。セーフエリア（ホームインジケータ等）を考慮する。

import { HistoryIcon, ProfileIcon, ScanIcon, SettingsIcon } from './Icons'

export type TabId = 'scan' | 'history' | 'profiles' | 'settings'

const TABS: { id: TabId; label: string; Icon: typeof ScanIcon }[] = [
  { id: 'scan', label: 'スキャン', Icon: ScanIcon },
  { id: 'history', label: '履歴', Icon: HistoryIcon },
  { id: 'profiles', label: '定義', Icon: ProfileIcon },
  { id: 'settings', label: '設定', Icon: SettingsIcon },
]

type TabBarProps = {
  active: TabId
  onChange: (tab: TabId) => void
}

export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-slate-800 bg-slate-900/95 backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {TABS.map(({ id, label, Icon }) => {
        const isActive = active === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium transition-colors touch-manipulation ${
              isActive ? 'text-cyan-400' : 'text-slate-500 active:text-slate-300'
            }`}
          >
            <Icon className="h-6 w-6" />
            {label}
          </button>
        )
      })}
    </nav>
  )
}
