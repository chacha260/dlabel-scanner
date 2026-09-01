import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { requestStoragePersistence } from './store/storagePersistence'
import { showToast } from './ui/components/toastBus'
import { markNeedRefresh } from './ui/components/updateBus'

// Android は空き容量が少ないと確認なしに IndexedDB を丸ごと消去することがあるため、
// 起動時に一度だけ永続化保護を要求しておく。対応状況・許可状況は設定画面で確認できる。
void requestStoragePersistence()

// オフライン利用のため Service Worker を登録する。
// registerType: 'prompt'（vite.config.ts）のため、新しいバージョンが見つかっても
// 即座にはリロードしない。ユーザーが更新バナーの「更新」を押したときだけ
// updateSW(true) を呼ぶ（スキャン中に無警告でリロードされて作業中のデータを
// 失うことを防ぐため）。
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    markNeedRefresh(updateSW)
  },
  onOfflineReady() {
    showToast('オフラインで使えます', 'info')
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
