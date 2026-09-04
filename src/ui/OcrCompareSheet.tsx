// 「同じ静止画に対して複数のOCR前処理設定を一括で走らせ、結果を並べて比較する」ための計測パネル。
//
// なぜこれが要るか: このリポジトリにはOCR精度を測る手段が一切ない。現場の実画像も
// 正解データ（ゴールデンデータ）もリポジトリに置けない事情があり、これまでの前処理の
// 改善はすべて「良くなった気がする」という推論ベースで積み重ねてきた。実際に良くなった
// のかを確かめる方法が無いまま調整を重ねるのは危険なので、その場（現場）で実物のラベルに
// 対して複数の設定を並べて見比べ、「どれが正解を出すか」を人間の目で判定できる画面を作る。
// 機能追加ではなく、いわば手動の計測器である。
//
// 以前は tesseract.js の PSM（ページ分割モード）違いと ML Kit を並べて比較していたが、
// tesseract.js を完全に削除して ML Kit 1本にしたため、PSM という軸自体が無くなった。
// 現在ここに残っているのは「ML Kit に、前処理の組み合わせを変えた画像を渡すとどう
// 読み方が変わるか」の比較だけである（罫線除去・縞マスク・コントラスト正規化は
// tesseract.js の LSTM 向けに調整したものだが、罫線除去・縞マスクはエンジンに依らず
// 有効な可能性があるため、比較対象として引き続き残す）。
//
// 重要な前提:
// - シャッター押下時に確定した静止フレーム（frame）に対してのみ処理する。再撮影は
//   絶対に行わない（カメラには一切触れない）。同じ画像に対して設定だけを変えて
//   何度も試せることこそがこの画面の価値であり、途中でフレームが変わってしまうと
//   「設定の違い」なのか「撮り直しによる違い」なのか区別できなくなってしまう。
// - 1件のプリセットが失敗しても比較全体を止めない。try/catchで個別に受け止め、
//   「失敗」の表示にして次のプリセットへ進む。
// - 全プリセットを並列ではなく逐次実行し、1件終わるごとに結果を表示していく
//   （全部終わるまで何も見えない、という体験は現場での確認作業として最悪なので避ける）。
// - このファイルは呼び出し側（SimpleScanScreen.tsx）で React.lazy + Suspense により
//   別チャンクとして遅延読み込みされる前提。エントリーチャンクを太らせない。
//
// 見た目・構造（fixed inset-0 の全画面パネル、上部固定ヘッダ + 閉じるボタン、
// safe-area-inset の考慮、本文スクロール、配色）は HelpSheet.tsx / LicenseSheet.tsx を
// そのまま踏襲する。z-index は z-[80]（LicenseSheetと同じ段）を使う。この画面は
// 結果カードから直接開く想定で、HelpSheet（z-[70]）と同時に表示されることは無い。

import { useEffect, useRef, useState } from 'react'
import { CloseIcon, SpinnerIcon, WarningIcon } from './components/Icons'
import type { NormalizedRect } from '../scan/barcode/types'
import {
  cropVideoSpaceRoi,
  cropVideoSpaceRoiRaw,
  DEFAULT_OCR_PREPROCESS_OPTIONS,
  recognizeCaptured,
  type OcrPreprocessOptions,
  type OcrResult,
  type RoiRect,
} from '../scan/ocr'

type OcrCompareSheetProps = {
  /** シャッター押下時に確定させた静止フレーム（再撮影は絶対にしない） */
  frame: OffscreenCanvas
  /** その時点の ROI（映像座標 0..1） */
  videoRoi: RoiRect
  /** 検出済みバーコード枠（映像座標）。空配列もあり得る */
  maskRects: NormalizedRect[]
  onClose: () => void
  /** 「この設定を使う」を押されたときに、採用された前処理設定を親へ返す */
  onAdopt: (preprocess: OcrPreprocessOptions) => void
}

type Preset = {
  id: string
  /** 何を確かめるためのプリセットかが一目でわかる短いラベル */
  label: string
  /** ラベルだけでは伝わらない狙いの補足説明 */
  description: string
  /** ML Kit へ前処理済みの画像を渡すか。false のときは等倍・カラーの素の切り出しを渡す */
  usePreprocess: boolean
  preprocess: OcrPreprocessOptions
}

const ALL_ON = DEFAULT_OCR_PREPROCESS_OPTIONS
const ALL_OFF: OcrPreprocessOptions = { removeRuledLines: false, maskStripes: false, normalizeContrast: false }

// 比較プリセット一覧。軸は「前処理の組み合わせ」のみ（PSMという軸は tesseract.js の
// 削除とともに無くなった）。全組み合わせ（3種のON/OFFフラグ = 8通り）は現場で
// 見比べるには多すぎるため、「これが分かれば十分」という組み合わせに絞ってある。
//
// 選定方針:
// - ML Kit にとって本来の入力である「素の画像」（等倍・カラー、前処理なし）。
//   これが比較の基準点になる。
// - 前処理をすべてONにしたもの（tesseract.js 時代からの既定の組み合わせ）。
//   前処理が ML Kit にとって有害かどうかを想像ではなく実物で確かめるためのもの。
// - 素の画像から1段だけ前処理をONにしたもの（罫線除去だけ／縞マスクだけ）。
//   罫線除去・縞マスクはグレースケール化やスケーリングを伴わない軽い加工であり、
//   コントラスト正規化と違って ML Kit にとっても有害とは限らないため、
//   単独の効果を切り分けられるようにしている。
const ALL_PRESETS: Preset[] = [
  {
    id: 'raw',
    label: '素の画像（前処理なし）',
    description: '切り出しただけの画像（等倍・カラー）をそのまま渡します。ML Kitはこれが本来の使い方です。他のプリセットはすべてこれとの比較のためにあります。',
    usePreprocess: false,
    preprocess: ALL_OFF,
  },
  {
    id: 'all-on',
    label: '前処理すべてON',
    description: '罫線除去・縞マスク・コントラスト正規化・グレースケール化・縮小をすべて行った画像を渡します。前処理がML Kitにとって有害かどうかを確かめるための比較用です。',
    usePreprocess: true,
    preprocess: ALL_ON,
  },
  {
    id: 'ruled-lines-only',
    label: '罫線除去だけON',
    description: '罫線除去だけを行い、コントラスト正規化・縮小は行いません。罫線除去単体の効果を見るためのものです。',
    usePreprocess: true,
    preprocess: { ...ALL_OFF, removeRuledLines: true },
  },
  {
    id: 'stripe-mask-only',
    label: '縞マスクだけON',
    description: 'バーコードの縞マスクだけを行います。ROIにバーコードが写り込んでいる場合の効果を切り分けられます。',
    usePreprocess: true,
    preprocess: { ...ALL_OFF, maskStripes: true },
  },
]

// 1プリセットぶんの実行状態。「未実行」は results に何も無い状態で表す。
type PresetOutcome =
  | { status: 'running' }
  | { status: 'done'; image: ImageData; result: OcrResult }
  // 前処理（crop）の段階で失敗した場合は image を持てないが、認識（recognize）の
  // 段階で失敗した場合はせっかく作った画像を捨てずに表示する
  // （「どんな画像を渡して失敗したか」も比較の手がかりになるため）。
  | { status: 'error'; message: string; image?: ImageData }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// SimpleScanScreen.tsx の同名コンポーネントと同じ役割（ImageDataをそのままcanvasに
// 描画するだけの小物）。あちらは export されていないため、この画面専用にローカルで
// 定義する（役割が単純なため重複は許容する）。
function CapturedImageCanvas({ image, className }: { image: ImageData; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    ctx?.putImageData(image, 0, 0)
  }, [image])

  return <canvas ref={canvasRef} className={className} style={{ imageRendering: 'pixelated' }} />
}

export default function OcrCompareSheet({ frame, videoRoi, maskRects, onClose, onAdopt }: OcrCompareSheetProps) {
  const [results, setResults] = useState<Record<string, PresetOutcome>>({})
  const [running, setRunning] = useState(false)
  // 実行中のプリセットの通し番号（0始まり）。進捗表示「n/m 実行中…」に使う。
  const [runningIndex, setRunningIndex] = useState<number | null>(null)

  // パネルが閉じられた（アンマウントされた）後に非同期処理の続きが setState を
  // 呼んでしまうのを防ぐガード。逐次実行の途中で onClose が呼ばれても、
  // 「もう存在しない画面の状態を更新しようとして警告が出る」事故を避ける。
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function runComparison() {
    if (running) return
    setRunning(true)
    setResults({})

    for (let i = 0; i < ALL_PRESETS.length; i++) {
      if (!mountedRef.current) return
      const preset = ALL_PRESETS[i]
      setRunningIndex(i)
      setResults((prev) => ({ ...prev, [preset.id]: { status: 'running' } }))

      // 前処理（画像を作る段）と認識（ML Kitに渡す段）を別々に try/catch する。
      // こうしておくと、万一 recognizeCaptured 側だけが失敗しても、既に作れていた
      // 画像（＝エンジンに渡した実際の入力）はそのまま表示でき、「何を渡して
      // 失敗したのか」を目で確認できる。
      let image: ImageData
      try {
        const rects = maskRects.length > 0 ? maskRects : undefined
        image = preset.usePreprocess
          ? cropVideoSpaceRoi(frame, videoRoi, rects, preset.preprocess)
          : cropVideoSpaceRoiRaw(frame, videoRoi, rects)
      } catch (err) {
        if (!mountedRef.current) return
        setResults((prev) => ({
          ...prev,
          [preset.id]: { status: 'error', message: `前処理に失敗: ${errorMessage(err)}` },
        }))
        continue
      }

      try {
        const result = await recognizeCaptured(image)
        if (!mountedRef.current) return
        setResults((prev) => ({ ...prev, [preset.id]: { status: 'done', image, result } }))
      } catch (err) {
        if (!mountedRef.current) return
        setResults((prev) => ({
          ...prev,
          [preset.id]: { status: 'error', message: `認識に失敗: ${errorMessage(err)}`, image },
        }))
      }
    }

    if (mountedRef.current) {
      setRunning(false)
      setRunningIndex(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-slate-950 text-slate-100">
      {/* 上部バー: タイトルと閉じるボタン（×）。常に見える位置に固定する */}
      <div
        className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <h1 className="text-xl font-bold text-slate-100">OCR設定の比較</h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="OCR設定の比較を閉じる"
          className="rounded-full p-2 text-slate-300 active:bg-slate-800"
        >
          <CloseIcon className="h-7 w-7" />
        </button>
      </div>

      {/* 本文（スクロール） */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-3 border-b border-slate-800 px-5 py-6 text-base leading-relaxed text-slate-200">
          <p>
            いま撮った<strong className="text-slate-100">同じ1枚の画像</strong>
            に対して、前処理（罫線除去・縞マスク・コントラスト正規化）の組み合わせを変えながら何通りも読み取り直し、結果を並べて比較します。
            撮り直しは行いません。
          </p>
          <p>
            <strong className="text-amber-300">
              どれが「正解」かはこのアプリには判定できません。正解が分かるのは、実物のラベルを見ている人間だけです。
            </strong>
            下に並ぶ結果を見比べて、一番よく読めている設定の
            <strong className="text-slate-100">「この設定を使う」</strong>
            を押してください。押した設定がこの後の読み取りで使われるようになります。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-4">
          <button
            type="button"
            onClick={() => void runComparison()}
            disabled={running}
            className="flex min-h-12 items-center gap-2 rounded-xl bg-cyan-500 px-5 text-base font-bold text-slate-950 active:bg-cyan-400 disabled:opacity-50"
          >
            {running && <SpinnerIcon className="h-5 w-5" />}
            {running ? '比較を実行中…' : Object.keys(results).length > 0 ? 'もう一度比較を実行' : '比較を実行'}
          </button>

          {running && runningIndex !== null && (
            <span className="text-sm text-slate-300">
              {runningIndex + 1}/{ALL_PRESETS.length} 実行中…
            </span>
          )}
        </div>

        <div className="divide-y divide-slate-800">
          {ALL_PRESETS.map((preset) => {
            const outcome = results[preset.id]
            return (
              <div key={preset.id} className="px-5 py-5">
                <div className="mb-3">
                  <p className="text-base font-bold text-cyan-300">{preset.label}</p>
                  <p className="mt-0.5 text-sm text-slate-400">{preset.description}</p>
                </div>

                {!outcome && <p className="text-sm text-slate-500">未実行（「比較を実行」を押すとここに結果が出ます）</p>}

                {outcome?.status === 'running' && (
                  <div className="flex items-center gap-2 text-sm text-slate-300">
                    <SpinnerIcon className="h-4 w-4 text-cyan-300" />
                    認識中…
                  </div>
                )}

                {outcome?.status === 'error' && (
                  <div className="space-y-2">
                    {outcome.image && (
                      <CapturedImageCanvas image={outcome.image} className="h-16 max-w-full object-contain" />
                    )}
                    <div className="flex items-start gap-2 rounded-lg border border-red-700 bg-red-950/40 p-3 text-sm text-red-300">
                      <WarningIcon className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="break-all">失敗: {outcome.message}</span>
                    </div>
                  </div>
                )}

                {outcome?.status === 'done' && (
                  <div className="space-y-3">
                    <div>
                      <p className="mb-1 text-xs text-slate-500">実際にエンジンへ渡した画像</p>
                      <div className="inline-block rounded border border-slate-700 bg-slate-900 p-1">
                        <CapturedImageCanvas image={outcome.image} className="max-h-40 max-w-full object-contain" />
                      </div>
                    </div>

                    <div>
                      <p className="mb-1 text-xs text-slate-500">認識テキスト</p>
                      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-slate-700 bg-slate-900 p-3 font-mono text-sm text-slate-100">
                        {outcome.result.text.trim().length > 0 ? outcome.result.text : '(読み取れず)'}
                      </pre>
                    </div>

                    <p className="text-sm text-slate-400">{outcome.result.ms}ms</p>

                    <button
                      type="button"
                      onClick={() => {
                        onAdopt(preset.preprocess)
                        onClose()
                      }}
                      className="flex min-h-12 w-full items-center justify-center rounded-xl bg-cyan-500 text-base font-bold text-slate-950 active:bg-cyan-400 sm:w-auto sm:px-6"
                    >
                      この設定を使う
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* スクロールを戻さなくても閉じられるよう、末尾にも閉じるボタンを置く */}
        <div className="px-5 py-7" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.75rem)' }}>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-14 w-full items-center justify-center rounded-xl bg-slate-800 text-base font-bold text-slate-100 active:bg-slate-700"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
