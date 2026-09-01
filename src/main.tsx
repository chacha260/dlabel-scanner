import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { showToast } from './ui/components/toastBus'
import { markNeedRefresh } from './ui/components/updateBus'

// 現在の画面は結果をメモリ上にしか保持しない（意図的にIndexedDBへ永続化しない）ため、
// ストレージ永続化保護（navigator.storage.persist()）を要求する意味がない。
// store/storagePersistence.ts 自体は削除せず、再配線時のために残してある。

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
