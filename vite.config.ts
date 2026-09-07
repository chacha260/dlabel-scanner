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

// onnxruntime-web（PaddleOCR の推論エンジン）が内部で使っている
// `new URL("ort-wasm-simd-threaded.wasm", import.meta.url)` という記述を、
// Vite のアセット解決が走る前に無害な式へ書き換えるプラグイン。
//
// 背景: onnxruntime-web/wasm（`node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs`）
// は、wasmPaths が未設定のときに備えたフォールバックとして
// `new URL("ort-wasm-simd-threaded.wasm", import.meta.url).href` を持っている。
// これを Vite は「このモジュールと同じ場所にある静的アセットへの参照」と
// 解釈し、public/vendor/onnxruntime/ort-wasm-simd-threaded.wasm（約14MB）と
// 中身がまったく同じファイルを `dist/assets/ort-wasm-simd-threaded-<hash>.wasm`
// としてもう一部コピーしてしまう。しかも `assets/` 配下にあるため
// workbox.globIgnores の `**/vendor/**` に一致せず、globPatterns の 'wasm' には
// 一致してしまい、14MBが Service Worker の precache に静かに紛れ込む
// （vite.config.ts 内の globIgnores のコメントが警告しているのとまったく同じ
// 事故が、'assets/' というvendor以外の経路から実際に発生していた）。
//
// 一方 src/scan/ocr/paddle/session.ts は起動時に必ず
// `ort.env.wasm.wasmPaths = <BASE_URL>vendor/onnxruntime/` を設定しており、
// onnxruntime-web はこの wasmPaths を最優先で使う。つまり Vite が書き換えた
// この `new URL(...)` のフォールバック経路は実行時には決して通らない、
// 純粋な死重（dead weight）でしかない。ならばビルド成果物にすら残す理由が
// ないので、Vite のアセット解決対象から外してしまうのが最も確実な対策になる。
//
// やり方: `import.meta.url` を使っている限り Vite は静的アセット参照だと
// みなすため、`import.meta.url` を使わない同値の式（`location.href` を
// 基準にした `new URL(...)`）に書き換える。`.href` はこの式の外側に元々
// 続いているので、置換後も文字列全体としては正しく URL オブジェクトの
// `.href` を読む式のまま残る。念のため実行時に評価された場合でも、
// wasmPaths と同じ自前配信先（vendor/onnxruntime/ 以下）を指すようにしておく。
//
// 置換対象のパターンは onnxruntime-web のバージョンアップで変わりうる。
// 1件も置換できなかった場合に黙って通すと、この14MBの二重同梱と
// precache 汚染がバージョンアップのたびに静かに復活しかねないため、
// 置換件数が0件ならビルド自体を失敗させて気付けるようにする。
function patchOnnxruntimeWasmUrlPlugin(): Plugin {
  // onnxruntime-web/wasm（'./dist/ort.wasm.bundle.min.mjs'）にのみ存在する
  // パターン。同パッケージ内には ort-wasm-simd-threaded.jsep.wasm や
  // .asyncify.wasm 向けの同種の記述を持つ他の .mjs もあるが、それらは
  // このアプリのビルド成果物には一切含まれない（インポートしていない）
  // ため意図的に対象にしない。
  const targetPattern = /new URL\("ort-wasm-simd-threaded\.wasm",\s*import\.meta\.url\)/g
  // vendor/onnxruntime/ 以下は session.ts が wasmPaths で指しているのと
  // 同じ配信元。base はビルドごとに固定（GitHub Pages のサブパス配信で
  // BASE_PATH から注入される）なので、実行時に組み立てず設定時に文字列を
  // 確定させてしまう。
  const fallbackUrlExpr = `new URL(${JSON.stringify(
    base + 'vendor/onnxruntime/ort-wasm-simd-threaded.wasm',
  )}, location.href)`
  let replacedCount = 0
  return {
    name: 'patch-onnxruntime-wasm-new-url',
    enforce: 'pre',
    transform(code, id) {
      // onnxruntime-web の dist ファイル以外には一切触れない。
      if (!id.includes('onnxruntime-web') || !id.endsWith('.mjs')) return null
      if (!targetPattern.test(code)) return null
      targetPattern.lastIndex = 0
      const patched = code.replace(targetPattern, () => {
        replacedCount += 1
        return fallbackUrlExpr
      })
      return { code: patched, map: null }
    },
    buildEnd(error) {
      // 他のエラーで既にビルドが失敗している場合はそちらを優先し、
      // 「置換0件」の誤検出でエラーメッセージを上書きしない。
      if (error) return
      if (replacedCount === 0) {
        this.error(
          'onnxruntime-web 内の `new URL("ort-wasm-simd-threaded.wasm", import.meta.url)` を' +
            '1件も置換できませんでした。onnxruntime-web の更新でパターンが変わった可能性が' +
            'あります（vite.config.ts の patchOnnxruntimeWasmUrlPlugin を参照）。このまま' +
            '見過ごすと14MBのwasmがdist/assetsに二重同梱され、precacheにも紛れ込みます。',
        )
      }
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
    globPatterns: ['**/*.{js,css,html,wasm,png,svg}'],
    // public/vendor 以下（PaddleOCR のモデル一式と ONNX Runtime の wasm、合計約35MB）は
    // precache から必ず除外する。除外し忘れると、この35MBが「アプリを開いた瞬間に
    // 全部ダウンロードされる」ことになり、軽さの要件を根本から壊す。
    // 特に ort-wasm-simd-threaded.wasm（約14MB）は globPatterns の 'wasm' に
    // 該当し、maximumFileSizeToCacheInBytes（25MB）にも収まってしまうため、
    // この globIgnores が無いと**静かに**precache に入る。
    //
    // 経緯: 以前 tesseract.js を同梱していた頃も同じ構成（vendor を除外し
    // runtimeCaching で後から取る）にしており、CI にも「precache に vendor が
    // 入っていないこと」を検査するゲートを置いていた。tesseract 削除時に
    // public/vendor 自体が無くなったので両方とも外したが、PaddleOCR の追加で
    // 事情が完全に元通りになったため復活させる。
    globIgnores: ['**/vendor/**'],
    maximumFileSizeToCacheInBytes: 25 * 1024 * 1024,
    runtimeCaching: [
      {
        // PaddleOCR を初めて使ったときにだけ取得し、以降はオフラインで再利用する。
        // APK 版ではアセットが端末内に同梱されているのでそもそも Service Worker は
        // 無効（PACKAGED ビルドでは vite-plugin-pwa ごと外す）だが、Web 版で
        // PaddleOCR を使う場合はこれが効く。
        // なお ML Kit と違い PaddleOCR は onnxruntime-web（WASM）で動くため、
        // ブラウザでも動作する。つまり Web 版でも文字モードが（PaddleOCR に
        // 切り替えれば）使えるようになる。
        urlPattern: /\/vendor\/(paddleocr|onnxruntime)\//,
        handler: 'CacheFirst',
        options: {
          cacheName: 'paddleocr-engine',
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
    // APK 版・Web 版のどちらでも onnxruntime-web を通じてビルドされるため、
    // isPackaged による分岐の外（常時有効）に置く。
    patchOnnxruntimeWasmUrlPlugin(),
    ...(isPackaged ? [stubPwaRegisterPlugin(), packagedCspPlugin()] : [pwaPlugin]),
  ],
  test: {
    environment: 'node',
  },
})
