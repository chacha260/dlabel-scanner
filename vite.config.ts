import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages ではリポジトリ名のサブパス配信になるため、
// base をワークフローから BASE_PATH で注入する（未指定ならルート配信）。
const base = process.env.BASE_PATH ?? '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
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
        globPatterns: ['**/*.{js,css,html,wasm,png,svg,traineddata,gz}'],
        // tesseract の巨大なエンジン一式（約9MB）は初回インストール時に
        // 巻き込まないよう precache 対象から除外する（軽量さの要件のため）。
        globIgnores: ['**/vendor/**'],
        maximumFileSizeToCacheInBytes: 25 * 1024 * 1024,
        runtimeCaching: [
          {
            // OCR を初めて使ったときにだけ取得し、以降はオフラインで再利用できるようにする
            urlPattern: /\/vendor\/tesseract\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tesseract-engine',
              expiration: {
                maxEntries: 16,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'node',
  },
})
