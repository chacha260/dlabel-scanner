// アプリのルートコンポーネント。現場の要件がまだ固まっていないため、タブ切り替えも
// 複数画面もなく、最小構成の SimpleScanScreen だけを表示する
// （ラベル定義エディタ・履歴・CSV書き出し・設定は src/ui/legacy に退避済み）。

import { ToastHost } from './ui/components/Toast'
import { UpdateBanner } from './ui/components/UpdateBanner'
import { SimpleScanScreen } from './ui/SimpleScanScreen'

function App() {
  return (
    <div className="fixed inset-0 flex flex-col bg-slate-900 text-slate-100">
      <div className="relative min-h-0 flex-1">
        <SimpleScanScreen />
      </div>
      <ToastHost />
      <UpdateBanner />
    </div>
  )
}

export default App
