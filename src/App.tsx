// アプリのルートコンポーネント。ルーターは使わず useState でタブ切り替えを行う。
// スキャン画面は常にマウントしたままにし、非表示時はカメラだけを止める
// （アンマウントするとカメラの再起動が挟まりタブ切り替えがもたつくため）。

import { useState } from 'react'
import { TabBar, type TabId } from './ui/components/TabBar'
import { ToastHost } from './ui/components/Toast'
import { UpdateBanner } from './ui/components/UpdateBanner'
import { ScanScreen } from './ui/ScanScreen'
import { HistoryScreen, type ExportRequest } from './ui/HistoryScreen'
import { ExportScreen } from './ui/ExportScreen'
import { ProfileListScreen } from './ui/ProfileListScreen'
import { SettingsScreen } from './ui/SettingsScreen'

function App() {
  const [tab, setTab] = useState<TabId>('scan')
  const [exportRequest, setExportRequest] = useState<ExportRequest | null>(null)

  const showExport = exportRequest !== null
  const scanVisible = tab === 'scan' && !showExport

  return (
    <div className="fixed inset-0 flex flex-col bg-slate-900 text-slate-100">
      <div className="relative min-h-0 flex-1">
        {/* スキャン画面は常時マウント。表示/非表示は CSS のみで切り替える */}
        <div className="absolute inset-0" style={{ visibility: scanVisible ? 'visible' : 'hidden' }}>
          <ScanScreen enabled={scanVisible} />
        </div>

        {tab === 'history' && !showExport && (
          <div className="absolute inset-0">
            <HistoryScreen onOpenExport={setExportRequest} />
          </div>
        )}

        {tab === 'profiles' && !showExport && (
          <div className="absolute inset-0">
            <ProfileListScreen />
          </div>
        )}

        {tab === 'settings' && !showExport && (
          <div className="absolute inset-0">
            <SettingsScreen />
          </div>
        )}

        {exportRequest && (
          <div className="absolute inset-0">
            <ExportScreen request={exportRequest} onBack={() => setExportRequest(null)} />
          </div>
        )}
      </div>

      {!showExport && <TabBar active={tab} onChange={setTab} />}
      <ToastHost />
      <UpdateBanner />
    </div>
  )
}

export default App
