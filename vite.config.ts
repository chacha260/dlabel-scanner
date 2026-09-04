import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages ではリポジトリ名のサブパス配信になるため、
// base をワークフローから BASE_PATH で注入する（未指定ならルート配信）。
const base = process.env.BASE_PATH ?? '/'

// Capacitor で APK にパッケージ化するためのビルドかどうか。
// `pnpm build:apk` からのみ PACKAGED=1 で呼ばれる。通常の `pnpm build`
// （GitHub Pages 向け Web ビルド）には一切影響しない。
// APK では HTML/JS/CSS/wasm/OCRエンジン一式が端末内に同梱されるため、
// Service Worker によるオフラインキャッシュ機構自体が不要であり、
// むしろアプリ更新後に古いキャッシュを配信し続けるリスクになる。
// そのためパッケージビルドでは vite-plugin-pwa を丸ごと無効化する。
const isPackaged = process.env.PACKAGED === '1'

// vite-plugin-pwa を無効化すると、それが提供する仮想モジュール
// 'virtual:pwa-register' も存在しなくなり、src/main.tsx の
// `import { registerSW } from 'virtual:pwa-register'`（静的 import）が
// 解決できずビルドが失敗する。main.tsx 側は import.meta.env.VITE_PACKAGED
// を見て実際に registerSW() を呼ばないようにしているが、import 文自体の
// 解決は必要なため、パッケージビルド時のみ「呼ばれることのないダミー」を
// 返す最小限のスタブモジュールを用意する。
function stubPwaRegisterPlugin(): Plugin {
  const virtualModuleId = 'virtual:pwa-register'
  const resolvedVirtualModuleId = '\0' + virtualModuleId
  return {
    name: 'stub-pwa-register-for-packaged-build',
    resolveId(id) {
      if (id === virtualModuleId) return resolvedVirtualModuleId
    },
    load(id) {
      if (id === resolvedVirtualModuleId) {
        return 'export const registerSW = () => () => {}'
      }
    },
  }
}

// Capacitor の WebView は index.html 配信時に、ブリッジ用スクリプトを
// nonce なしのインライン <script> として <head> 直後に注入する
// （node_modules/@capacitor/android 内 JSInjector#getInjectedStream を確認済み。
// 詳細は docs/apk.md を参照）。Web 版の CSP（index.html）は script-src に
// 'unsafe-inline' を含めておらずこの注入がブロックされるため、
// パッケージビルドの成果物 (dist/index.html) に限り 'unsafe-inline' を
// 追加する。Web 版の CSP 文字列（index.html のソース）自体は一切変更しない。
function packagedCspPlugin(): Plugin {
  return {
    name: 'packaged-csp-for-capacitor-bridge',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        /script-src 'self' 'wasm-unsafe-eval' blob:/,
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
      )
    },
  }
}

// Web版（GitHub Pages）でだけ有効にする vite-plugin-pwa 本体。
// パッケージビルドではこの配列は使わず stubPwaRegisterPlugin / packagedCspPlugin に置き換える。
const pwaPlugin = VitePWA({
  // 'autoUpdate' は無警告でページをリロードしてしまい、スキャン中の作業を
  // 壊す恐れがあるため 'prompt' にする。更新の適用は UpdateBanner から
  // ユーザーが明示的に操作したときのみ行う（main.tsx を参照）。
  registerType: 'prompt',
  includeAssets: ['icons/apple-touch-icon.png'],
  manifest: {
    name: 'Dラベル スキャナ',
    short_name: 'Dラベル',
    description: '現品票・Dラベルのバーコード / OCR スキャナ（完全オフライン）',
    lang: 'ja',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#0f172a',
    background_color: '#0f172a',
    id: base,
    scope: base,
    start_url: base,
    icons: [
      {
        src: 'icons/pwa-192x192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: 'icons/pwa-512x512.png',
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: 'icons/maskable-icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  },
  workbox: {
    // 以前は tesseract.js の学習データ (eng.traineddata) 用に 'traineddata' 拡張子を
    // globPatterns に含め、tesseract 一式（約9MB、public/vendor/tesseract 以下）を
    // globIgnores で precache 対象から除外し、runtimeCaching で初回アクセス時にだけ
    // 取得してオフライン再利用する設定をしていた。tesseract.js を完全に削除し
    // public/vendor 自体が無くなった（OCRエンジンはML Kit、Androidアプリ組み込みの
    // ネイティブモデルで、Web版の Service Worker がキャッシュすべき対象ではない）
    // ため、これらは全て不要になった。
    globPatterns: ['**/*.{js,css,html,wasm,png,svg}'],
    maximumFileSizeToCacheInBytes: 25 * 1024 * 1024,
  },
})

// https://vite.dev/config/
export default defineConfig({
  base,
  define: {
    // main.tsx で「パッケージ版かどうか」を判定するためのビルド時フラグ。
    // 通常の Web ビルドでは常に false になる。
    'import.meta.env.VITE_PACKAGED': JSON.stringify(isPackaged),
  },
  plugins: [
    react(),
    tailwindcss(),
    ...(isPackaged ? [stubPwaRegisterPlugin(), packagedCspPlugin()] : [pwaPlugin]),
  ],
  test: {
    environment: 'node',
  },
})
