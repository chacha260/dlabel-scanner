// アプリのルートコンポーネント。現場の要件がまだ固まっていないため、タブ切り替えも
// 複数画面もなく、最小構成の SimpleScanScreen だけを表示する。
// 以前はここに「要件が固まったら再配線する」前提でラベル定義エディタ・履歴・
// CSV書き出し・設定画面一式（src/ui/legacy/）を退避させていたが、利用者の判断で
// 削除した（必要になれば git 履歴から復元できる。README「削除した機能」参照）。

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
