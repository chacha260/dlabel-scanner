// 「同じ静止画に対して複数のOCR設定を一括で走らせ、結果を並べて比較する」ための計測パネル。
//
// なぜこれが要るか: このリポジトリにはOCR精度を測る手段が一切ない。現場の実画像も
// 正解データ（ゴールデンデータ）もリポジトリに置けない事情があり、これまでの前処理の
// 改善はすべて「良くなった気がする」という推論ベースで積み重ねてきた。実際に良くなった
// のかを確かめる方法が無いまま調整を重ねるのは危険なので、その場（現場）で実物のラベルに
// 対して複数の設定を並べて見比べ、「どれが正解を出すか」を人間の目で判定できる画面を作る。
// 機能追加ではなく、いわば手動の計測器である。
//
// 重要な前提:
// - シャッター押下時に確定した静止フレーム（frame）に対してのみ処理する。再撮影は
//   絶対に行わない（カメラには一切触れない）。同じ画像に対して設定だけを変えて
//   何度も試せることこそがこの画面の価値であり、途中でフレームが変わってしまうと
//   「設定の違い」なのか「撮り直しによる違い」なのか区別できなくなってしまう。
// - OCRエンジンのワーカーは1個しか無く、同時に複数の認識要求を投げると詰まって
//   却って遅くなる（そもそも比較にならない）。そのため全プリセットを並列ではなく
//   逐次実行し、1件終わるごとに結果を表示していく（全部終わるまで何も見えない、
//   という体験は現場での確認作業として最悪なので避ける）。
// - 1件のプリセットが失敗しても比較全体を止めない。try/catchで個別に受け止め、
//   「失敗」の表示にして次のプリセットへ進む。
// - このファイルは呼び出し側（SimpleScanScreen.tsx）で React.lazy + Suspense により
//   別チャンクとして遅延読み込みされる前提。エントリーチャンクを太らせない。
//
// 見た目・構造（fixed inset-0 の全画面パネル、上部固定ヘッダ + 閉じるボタン、
// safe-area-inset の考慮、本文スクロール、配色）は HelpSheet.tsx / LicenseSheet.tsx を
// そのまま踏襲する。z-index は z-[80]（LicenseSheetと同じ段）を使う。この画面は
// 結果カードから直接開く想定で、HelpSheet（z-[70]）と同時に表示されることは無い。

import { useEffect, useMemo, useRef, useState } from 'react'
import { CloseIcon, SpinnerIcon, WarningIcon } from './components/Icons'
import type { NormalizedRect } from '../scan/barcode/types'
import {
  cropVideoSpaceRoi,
  cropVideoSpaceRoiRaw,
  isMlKitAvailable,
  DEFAULT_OCR_PREPROCESS_OPTIONS,
  recognizeCaptured,
  type OcrEngineId,
  type OcrOptions,
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
  /** 「この設定を使う」を押されたときに、採用された設定を親へ返す */
  onAdopt: (psm: OcrOptions['psm'], preprocess: OcrPreprocessOptions, engine: OcrEngineId) => void
}

// PSM（Tesseractのページ分割モード）の意味は types.ts のコメントに準拠する:
// 7=単一行 / 8=単一語 / 6=ブロック
type Preset = {
  id: string
  /**
   * どのエンジンで認識するか。省略時は 'tesseract'。
   * ML Kit は APK でしか動かないため、isMlKitAvailable() が false の環境
   * （ブラウザ）では該当プリセットを一覧から除外する。
   */
  engine?: OcrEngineId
  /** 何を確かめるためのプリセットかが一目でわかる短いラベル */
  label: string
  /** ラベルだけでは伝わらない狙いの補足説明 */
  description: string
  psm: OcrOptions['psm']
  preprocess: OcrPreprocessOptions
}

const ALL_ON = DEFAULT_OCR_PREPROCESS_OPTIONS
const ALL_OFF: OcrPreprocessOptions = { removeRuledLines: false, maskStripes: false, normalizeContrast: false }

// 比較プリセット一覧。軸は「PSM」×「前処理の組み合わせ」だが、全組み合わせ
// （3種のON/OFFフラグ×3種のPSM=24通り）は現場で見比べるには多すぎるため、
// 「これが分かれば十分」という組み合わせに絞ってある。
//
// 選定方針:
// - 現状の既定（比較の基準点）
// - 前処理を全部OFFにした素のグレースケール（ベースライン）。これが無いと
//   「前処理がそもそも効いているのか」自体が分からない。
// - 既定から1段だけOFFにしたもの（罫線除去だけ／縞マスクだけ／コントラスト正規化だけ）。
//   既定とベースラインの差が大きかった場合に、「どの段が効いているか」を
//   切り分けるためのもの。
// - PSM違い（8=単語、6=ブロック）はどちらも前処理は既定のままにして、
//   前処理とPSMの効果が混ざらないようにしている。
const ALL_PRESETS: Preset[] = [
  {
    id: 'default',
    label: '既定（PSM7・前処理すべてON）',
    description: 'いま実際にアプリが使っている設定そのもの。他のプリセットはすべてこれとの比較のためにある。',
    psm: '7',
    preprocess: ALL_ON,
  },
  {
    id: 'baseline-off',
    label: 'ベースライン（前処理すべてOFF）',
    description: '罫線除去・縞マスク・コントラスト正規化を全部止めた、素のグレースケール画像。前処理がそもそも効いているかを見るための基準。',
    psm: '7',
    preprocess: ALL_OFF,
  },
  {
    id: 'no-ruled-lines',
    label: '罫線除去だけOFF',
    description: '既定から「罫線除去」だけを外したもの。既定との差が、罫線除去の効果かどうかを切り分けられる。',
    psm: '7',
    preprocess: { ...ALL_ON, removeRuledLines: false },
  },
  {
    id: 'no-stripe-mask',
    label: '縞マスクだけOFF',
    description: '既定から「バーコード縞マスク」だけを外したもの。ROIにバーコードが写り込んでいる場合に効果が分かる。',
    psm: '7',
    preprocess: { ...ALL_ON, maskStripes: false },
  },
  {
    id: 'no-contrast',
    label: 'コントラスト正規化だけOFF',
    description: '既定から「コントラスト正規化」だけを外したもの。照明ムラが強い現場での効果を切り分けられる。',
    psm: '7',
    preprocess: { ...ALL_ON, normalizeContrast: false },
  },
  {
    // ここからが ML Kit（端末内蔵モデル）。Tesseract との直接比較がこの画面の主目的。
    //
    // 素の切り出し（等倍・カラー）を渡すのが ML Kit にとっての本命。前処理の
    // パイプラインは Tesseract の LSTM 向けに調整したもので、特に「文字行の高さ
    // 96px まで縮小する」段は、自然な写真で学習された ML Kit には不利にしか働かない。
    id: 'mlkit-raw',
    engine: 'mlkit',
    label: 'ML Kit（素の画像・前処理なし）',
    description: '端末内蔵のML Kitに、切り出しただけの画像（等倍・カラー）を渡します。ML Kitはこれが本来の使い方です。',
    psm: '7',
    preprocess: ALL_OFF,
  },
  {
    // 「ML Kit に Tesseract 向けの前処理を通した画像を渡すとどうなるか」も
    // 一応見られるようにしておく。前処理が ML Kit にとって有害だという想定が
    // 正しいかどうかを、想像ではなく実物で確かめるため。
    id: 'mlkit-preprocessed',
    engine: 'mlkit',
    label: 'ML Kit（Tesseract向け前処理あり）',
    description: '比較用。前処理がML Kitにとって有害かどうかを確かめるためのもので、通常はこちらを選びません。',
    psm: '7',
    preprocess: ALL_ON,
  },
  {
    id: 'psm8-default',
    label: 'PSM8（単一語）・前処理は既定',
    description: 'ROIに1単語（1かたまりの文字列）だけが写っている場合に強いとされるモード。前処理は既定のまま揃えてPSMの差だけを見る。',
    psm: '8',
    preprocess: ALL_ON,
  },
  {
    id: 'psm6-default',
    label: 'PSM6（ブロック）・前処理は既定',
    description: 'ROIに複数行・複数語がまとまって写っている場合に向くモード。前処理は既定のまま揃えてPSMの差だけを見る。',
    psm: '6',
    preprocess: ALL_ON,
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

/**
 * この実行環境で実際に走らせられるプリセットだけを返す。
 * ML Kit は Capacitor のネイティブプラグイン経由でしか動かないため、
 * ブラウザ（pnpm dev / Web版）では該当プリセットを最初から出さない。
 * 出しておいて実行時に全部失敗させるより、そもそも選択肢に無いほうが分かりやすい。
 */
function usablePresets(): Preset[] {
  const mlkitOk = isMlKitAvailable()
  return ALL_PRESETS.filter((preset) => preset.engine !== 'mlkit' || mlkitOk)
}

export default function OcrCompareSheet({ frame, videoRoi, maskRects, onClose, onAdopt }: OcrCompareSheetProps) {
  // プリセット一覧は実行環境で決まり、コンポーネントの生存中に変わることはない
  const PRESETS = useMemo(() => usablePresets(), [])
  const [results, setResults] = useState<Record<string, PresetOutcome>>({})
  const [running, setRunning] = useState(false)
  // 実行中のプリセットの通し番号（0始まり）。進捗表示「n/m 実行中…」に使う。
  const [runningIndex, setRunningIndex] = useState<number | null>(null)
  const [sortByConfidence, setSortByConfidence] = useState(false)

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

    for (let i = 0; i < PRESETS.length; i++) {
      if (!mountedRef.current) return
      const preset = PRESETS[i]
      setRunningIndex(i)
      setResults((prev) => ({ ...prev, [preset.id]: { status: 'running' } }))

      // 前処理（画像を作る段）と認識（tesseractに渡す段）を別々に try/catch する。
      // こうしておくと、万一 recognizeCaptured 側だけが失敗しても、既に作れていた
      // 画像（＝エンジンに渡した実際の入力）はそのまま表示でき、「何を渡して
      // 失敗したのか」を目で確認できる。
      let image: ImageData
      try {
        const rects = maskRects.length > 0 ? maskRects : undefined
        // ML Kit の「素の画像」プリセットだけは前処理パイプラインを通さず、
        // 等倍・カラーのまま渡す（Preset.engine のコメントを参照）。
        image =
          preset.engine === 'mlkit' && preset.preprocess === ALL_OFF
            ? cropVideoSpaceRoiRaw(frame, videoRoi, rects)
            : cropVideoSpaceRoi(frame, videoRoi, rects, preset.preprocess)
      } catch (err) {
        if (!mountedRef.current) return
        setResults((prev) => ({
          ...prev,
          [preset.id]: { status: 'error', message: `前処理に失敗: ${errorMessage(err)}` },
        }))
        continue
      }

      try {
        const result = await recognizeCaptured(image, { psm: preset.psm, engine: preset.engine ?? 'tesseract' })
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

  // 表示順。既定はプリセット定義順（＝上の切り分けの並び）で、トグルをONにすると
  // 完了済みの結果だけを信頼度の高い順に並べ替える（未実行・実行中・失敗のものは
  // 信頼度を持たないため、常に一番後ろへ回す）。
  //
  // 注意: ML Kit は信頼度を一切返さず、OcrResult.confidence には常に 0 が入る
  // （「信頼度が低い」ではなく「信頼度という情報が無い」の意味。types.ts 参照）。
  // そのため信頼度で並べ替えると、ML Kit がどれだけよく読めていても必ず最下位に
  // 沈む。これは並べ替えの都合であって認識精度とは何の関係もないので、
  // 画面上でもその旨を明示している（下の注記）。
  const orderedPresets = useMemo(() => {
    if (!sortByConfidence) return PRESETS
    const confidenceOf = (preset: Preset): number => {
      const outcome = results[preset.id]
      if (outcome?.status !== 'done') return -Infinity
      // ML Kit の 0 は「情報が無い」なので、比較可能な値として扱わない
      if ((preset.engine ?? 'tesseract') === 'mlkit') return -Infinity
      return outcome.result.confidence
    }
    return [...PRESETS].sort((a, b) => confidenceOf(b) - confidenceOf(a))
  }, [PRESETS, sortByConfidence, results])

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
            に対して、OCRの設定（PSM・前処理の組み合わせ）を変えながら何通りも読み取り直し、結果を並べて比較します。
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
              {runningIndex + 1}/{PRESETS.length} 実行中…
            </span>
          )}

          <label className="ml-auto flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={sortByConfidence}
              onChange={(e) => setSortByConfidence(e.target.checked)}
              className="h-4 w-4 accent-cyan-500"
            />
            信頼度の高い順に並べ替え
          </label>
        </div>

        {sortByConfidence && (
          <p className="border-b border-slate-800 px-5 pb-4 text-xs leading-relaxed text-amber-300">
            ※ ML Kit は信頼度という情報を返さないため、並べ替えでは常に最後になります。
            これは並び順の都合であって、読み取りの良し悪しとは関係ありません。
            ML Kit の結果は<strong className="text-amber-200">読み取れた文字そのものを見て</strong>判断してください。
          </p>
        )}

        <div className="divide-y divide-slate-800">
          {orderedPresets.map((preset) => {
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

                    <p className="text-sm text-slate-400">
                      信頼度 {Math.round(outcome.result.confidence)}% ・ {outcome.result.ms}ms
                    </p>

                    <button
                      type="button"
                      onClick={() => {
                        onAdopt(preset.psm, preset.preprocess, preset.engine ?? 'tesseract')
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
