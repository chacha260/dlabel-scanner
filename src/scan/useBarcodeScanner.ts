// カメラ映像を継続的に監視してバーコードを検出するフレームループ。
// パフォーマンスが最優先: 10fps 上限・処理中フレームのスキップ・
// ref による状態管理（毎フレーム setState しない）を徹底する。
//
// ダウンスケールについて（重要）: 以前は経路によらず毎フレーム 720px 長辺へ
// 縮小してから検出していたが、これは小さい・バーが細いバーコードが
// 判読不能になるほどの劣化だった（例: 1920x1080 → 720px は 2.67 倍の縮小で、
// 2px のバーが 0.75px になり復元不能）。
// ネイティブ実装（BarcodeDetector）は端末のネイティブコードで動くため、
// フル解像度で渡してもコストは小さい。そのため：
//   - ネイティブ経路: <video> をそのまま渡す。canvas 描画もダウンスケールも
//     ImageBitmap 生成も一切行わない（フル解像度 + 前より軽い処理）。
//   - zxing-wasm フォールバック経路（BarcodeDetector 非対応環境のみ）:
//     ImageData 化のため canvas を経由する必要があるが、上限を 1280px に
//     緩め、かつ元映像がそれを超える場合だけ縮小する（computeDownscaledSize）。
//
// 「枠内のみ」ON時のクロップ最適化について（重要、barcode/crop.ts も参照）:
// 6MP級（例: 1836×3264）のカメラでは、フル解像度のまま毎フレーム解析すると
// 端末によっては明確に重い。だが解像度そのものを下げると上のダウンスケール
// 撤廃の効果（細いバーが読めること）を打ち消してしまう。
// 「枠内のみ」がONのとき、バーコードは定義上その枠の中にしかないため、
// 解析対象を「枠が占める範囲だけを切り出した OffscreenCanvas」に絞る
// （drawImage の１回で切り出しと等倍コピーを同時に行う）。これなら
// 画素数は「枠が画面に占める割合」の分だけ減るのに、切り出した範囲は
// 縮小しない（ネイティブ解像度のまま）ので精度は落ちない。
// 唯一、枠を画面のほぼ全体まで広げた場合だけ CROP_PIXEL_BUDGET_PX を
// 超えないよう縮小する（computeCropSize）。切り出し後の検出結果の box は
// 「切り出したcanvas自身」基準のクロップ座標になるため、映像座標のROIフィルタ
// （filterHitsByRoi）を重ねて適用してはいけない（座標系混同で正しいヒットを
// 静かに弾いてしまう）。詳細な理由は crop.ts の resolveBarcodeCropPlan を参照。

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { RawScan } from '../parse/types'
import { createBarcodeReader, filterHitsByRoi, selectNewHits } from './barcode'
import type { BarcodeBackend, BarcodeHit, BarcodeReader, NormalizedRect } from './barcode'
import { computeCropSize, CROP_PIXEL_BUDGET_PX, resolveBarcodeCropPlan } from './barcode/crop'
import { computeDownscaledSize } from './barcode/scale'
// ROI の表示座標→映像座標への変換は geometry.ts の1箇所だけに閉じ込める
// （ocr/index.ts は OCR まわりの諸機能を再エクスポートする集約モジュールのため、
// 型と変換関数だけを直接ファイルから import し、余計な依存をこのフレームループに
// 持ち込まない）。
import { mapCoverRectToVideo } from './ocr/geometry'
import type { RoiRect } from './ocr/types'

export type UseBarcodeScannerOptions = {
  videoRef: RefObject<HTMLVideoElement | null>
  /** フレームループを回すか（一時停止・オーバーレイ表示中は false にする） */
  enabled: boolean
  /**
   * 読み取りバックエンドを保持し続けるか（既定: enabled と同じ）。
   * enabled と分離しておくことで、オーバーレイの開閉のたびに
   * zxing の Worker を破棄・再生成する無駄を避けられる。
   */
  active?: boolean
  /**
   * 追加の可否そのものは isDuplicate（一覧の状態）だけで決まる。この値は
   * 「読み取り済み」通知（onDuplicate）を同じ値について連打しないための、
   * 通知だけに使う短い時間窓（ミリ秒）。
   */
  dedupeMs?: number
  /** 検出時のビープ音を鳴らすか（既定: true） */
  beep?: boolean
  /** 検出時にバイブレーションさせるか（既定: true） */
  vibrate?: boolean
  /**
   * バーコード読み取りの対象を絞る ROI 枠（表示座標 = <video> の CSS ボックスに
   * 対する 0..1 の割合）。restrictToRoi が true のときだけ使われる。
   * ref 経由で読むため、値を変えてもフレームループ自体は張り直されない。
   */
  roi?: RoiRect
  /**
   * true の場合、検出結果のうち box の中心が roi の内側にあるものだけを採用する
   * （既定: false = 従来通りフレーム全体を対象にする）。
   * box を持たない（位置情報を提供しない）ヒットは常に採用する。
   */
  restrictToRoi?: boolean
  /**
   * この値は既に呼び出し側の結果一覧にあるか？ を答える純粋な述語（省略時は常に false
   * ＝一覧の状態によらず全てのヒットを新規扱いする）。フレームごとに新しい関数を渡しても
   * このフック自身は ref 経由で読むだけなので、フレームループ（バックエンド保持を含む）が
   * 張り直されることはない。呼び出し側の結果一覧のコピーはこのフックの中には一切持たない
   * （常に呼び出し側に「今のリストの状態」を尋ねるだけ）。
   */
  isDuplicate?: (value: string) => boolean
  /**
   * isDuplicate が true を返した（＝一覧に既にある）ヒットを検出したときの通知。
   * 一覧には追加されない（onScan は呼ばれない）。連打防止のため、同じ値については
   * dedupeMs 経過するまで再度は呼ばれない（フレームごとに呼び続けることはない）。
   * 「読み取り済み」などの軽いフィードバック表示にだけ使うことを想定している。
   */
  onDuplicate?: (hit: BarcodeHit) => void
  onScan: (scan: RawScan) => void
}

export type UseBarcodeScannerResult = {
  backend: BarcodeBackend | null
  lastHit: BarcodeHit | null
  error: string | null
  /**
   * フレームループが保持しているのと同じバックエンド（ネイティブ / zxing-wasm）で、
   * 与えられた1枚の画像に対してバーコード検出だけを行い、検出できた枠（映像座標）を返す。
   * シャッター押下時の OCR マスキング用。ここで新しい BarcodeDetector や zxing の
   * Worker を作ることは絶対にしない（フレームループが持つ readerRef を再利用する）。
   * 検出に失敗しても例外を投げず、空配列を返す（呼び出し側はマスクなしで続行できる）。
   */
  detectBoxes: (source: OffscreenCanvas) => Promise<NormalizedRect[]>
}

// 10fps 上限。変更した場合は HelpSheet.tsx の「バーコードを読む」の記載も合わせること
const FRAME_INTERVAL_MS = 100
// zxing-wasm フォールバック経路だけに適用するダウンスケール上限（ネイティブ経路は無関係）
const ZXING_LONG_EDGE_PX = 1280

// busyRef が true に固定されたまま戻らなくなる不具合（barcode/index.ts の
// 冒頭コメント参照）に対する最後の安全網。zxing 経路は barcode/index.ts 側で
// 既に1リクエストあたり4秒のタイムアウトを内蔵しており、通常はそちらが
// 先に detect() の Promise を必ず settle させる。この監視はそれでも
// busyRef が戻らなかった場合（例: ネイティブ経路の BarcodeDetector.detect()
// 自体がハングした、finally が実行される前に何らかの理由でイベントループが
// 詰まった、等）のための保険なので、zxing 側の内部タイムアウトより
// 十分大きい余裕を持たせておく（先に内部タイムアウトが機能して自己回復
// できるなら、この監視が発火することはない）。
const BUSY_WATCHDOG_MS = 8000
// ウォッチドッグ発火や zxing の持続的デコード失敗などを利用者に知らせる
// トースト表示の生存時間（showTransientError 参照）
const ERROR_TOAST_DURATION_MS = 5000

// requestVideoFrameCallback の型は DOM 標準にあるが、rVFC 非対応環境向けの
// フォールバック判定用に、存在チェックだけ局所的に行う。
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

function playBeep(audioCtxRef: { current: AudioContext | null }): void {
  try {
    let ctx = audioCtxRef.current
    if (!ctx) {
      const AudioContextCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextCtor) return
      ctx = new AudioContextCtor()
      audioCtxRef.current = ctx
    }
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = 1200
    gain.gain.value = 0.15
    oscillator.connect(gain)
    gain.connect(ctx.destination)
    const now = ctx.currentTime
    oscillator.start(now)
    oscillator.stop(now + 0.08)
  } catch {
    // 音声再生に失敗しても致命的ではないため無視する
  }
}

function playVibration(): void {
  try {
    navigator.vibrate?.(40)
  } catch {
    // バイブレーション非対応環境では無視する
  }
}

// busyRef のウォッチドッグ発火・zxingワーカーの持続的デコード失敗・
// worker自己回復の上限到達、といった「利用者に一度だけ軽く知らせたい」
// 通知をまとめて扱うヘルパー。playBeep/playVibration と同様、ref を
// 引数で受け取る形にしてあるのは、この関数自体をどこかの依存配列に
// 入れる必要をなくすため。
//
// 同じ文言を setError にセットしっぱなしにすると、React は同一値への
// setState を再レンダーなしに握りつぶすため、SimpleScanScreen 側の
// 「scannerError が変わるたびにトーストを出す」仕組み（useEffect の
// 依存配列に scannerError を積む形）が、2回目以降まったく同じ文言では
// 発火しなくなってしまう。一定時間後に null へ戻すことで、
// 同じ種類の異常が再発したときにも改めて通知できるようにしている。
function showTransientError(
  setError: (value: string | null) => void,
  timerRef: { current: ReturnType<typeof setTimeout> | null },
  message: string,
  durationMs: number,
): void {
  setError(message)
  if (timerRef.current !== null) clearTimeout(timerRef.current)
  timerRef.current = setTimeout(() => {
    setError(null)
    timerRef.current = null
  }, durationMs)
}

export function useBarcodeScanner({
  videoRef,
  enabled,
  active,
  dedupeMs = 1500,
  beep = true,
  vibrate = true,
  roi,
  restrictToRoi = false,
  isDuplicate,
  onDuplicate,
  onScan,
}: UseBarcodeScannerOptions): UseBarcodeScannerResult {
  const [backend, setBackend] = useState<BarcodeBackend | null>(null)
  const [lastHit, setLastHit] = useState<BarcodeHit | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onScanRef = useRef(onScan)
  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  // isDuplicate・onDuplicate も ref 経由で読む。呼び出し側（SimpleScanScreen）は
  // 「現在の結果一覧」を毎回クロージャに閉じ込めた新しい関数を渡してくることが
  // あり得るため、依存配列に入れるとその都度フレームループが張り直しになってしまう。
  // ここでは常に最新の関数を ref で保持し、フレームループ自体は張り直さない。
  const isDuplicateRef = useRef(isDuplicate)
  const onDuplicateRef = useRef(onDuplicate)
  useEffect(() => {
    isDuplicateRef.current = isDuplicate
    onDuplicateRef.current = onDuplicate
  }, [isDuplicate, onDuplicate])

  // ビープ / バイブの ON-OFF は ref 経由で読む。
  // 依存配列に入れるとトグルのたびにフレームループが張り直しになるため。
  const beepRef = useRef(beep)
  const vibrateRef = useRef(vibrate)
  useEffect(() => {
    beepRef.current = beep
    vibrateRef.current = vibrate
  }, [beep, vibrate])

  // ROI 絞り込みの ON/OFF・枠の位置も ref 経由で読む。
  // 依存配列に入れるとドラッグ中や枠内のみトグルのたびにフレームループ
  // （＝バックエンド保持を含む）が張り直しになるため。
  const roiRef = useRef(roi)
  const restrictToRoiRef = useRef(restrictToRoi)
  useEffect(() => {
    roiRef.current = roi
    restrictToRoiRef.current = restrictToRoi
  }, [roi, restrictToRoi])

  const readerRef = useRef<BarcodeReader | null>(null)
  // フレームループの tick() が「ネイティブ経路（video を直接渡す）」と
  // 「zxing 経路（canvas 経由が必須）」のどちらで動くかを判定するために保持する。
  // React state (backend) は再レンダーを起こすため使わず、ref で持つ。
  const backendRef = useRef<BarcodeBackend | null>(null)
  const canvasRef = useRef<OffscreenCanvas | null>(null)
  const ctxRef = useRef<OffscreenCanvasRenderingContext2D | null>(null)
  // 「枠内のみ」ON時（クロップ経路）専用の使い回しcanvas。zxing経路が使う
  // canvasRef/ctxRef（フル フレーム用）とは別に持つ。restrictToRoiの
  // ON/OFF切り替えのたびに毎回作り直さずに済むようにするため。
  const cropCanvasRef = useRef<OffscreenCanvas | null>(null)
  const cropCtxRef = useRef<OffscreenCanvasRenderingContext2D | null>(null)
  const busyRef = useRef(false)
  // busyRef.current を true にした時刻（performance.now() 基準）。
  // BUSY_WATCHDOG_MS を参照。
  const busyStartedAtRef = useRef(0)
  // showTransientError が使う「一定時間後に error を null へ戻す」タイマー
  const errorResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFrameAtRef = useRef(0)
  // 「読み取り済み」通知（onDuplicate）を同じ値について連打しないための、
  // 通知だけに使う直近通知時刻。追加の可否（isDuplicate）には一切関与しない。
  const lastDuplicateNotifyRef = useRef<Map<string, number>>(new Map())
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rvfcHandleRef = useRef<number | null>(null)
  const rafHandleRef = useRef<number | null>(null)
  const stoppedRef = useRef(false)
  // 直近でコールバック登録に使った video 要素を覚えておく
  // （クリーンアップ時に videoRef.current を直接読むと、登録時と別要素になり得るため）
  const registeredVideoRef = useRef<VideoWithFrameCallback | null>(null)

  // バックエンド（ネイティブ / zxing-wasm）の準備。
  // 一時停止やオーバーレイ表示で enabled が落ちても保持し続け、再開を即座にする。
  const readerActive = active ?? enabled
  useEffect(() => {
    if (!readerActive) return
    let cancelled = false

    createBarcodeReader({
      // zxing-wasm 経路でデコードが持続的に失敗し続けている（＝1フレームの
      // 偶発的な失敗ではない）と判定されたときの通知。この時点で
      // barcode/index.ts 側は既にリーダーを作り直し済み（自己回復）なので、
      // ここでは「起きたことを利用者に伝える」以上のことはしない。
      onPersistentDecodeFailure: () => {
        if (cancelled) return
        showTransientError(
          setError,
          errorResetTimerRef,
          'バーコードの読み取りが連続して失敗したため、読み取り処理を再起動しました',
          ERROR_TOAST_DURATION_MS,
        )
      },
      // barcode/index.ts が定める自己回復の上限回数（MAX_ZXING_WORKER_REGENERATIONS）
      // に達し、これ以上の自動復旧を諦めたときの通知。以後 detect() は
      // 常に空配列を返すだけになるため、これだけは自動で消さずに出し続ける
      // （利用者の操作＝アプリの再読み込みが必要な、根本的に直らない状態のため）。
      onWorkerExhausted: () => {
        if (cancelled) return
        setError('バーコード読み取り機能が繰り返し停止したため、自動復旧を諦めました。アプリを再読み込みしてください')
      },
    })
      .then(({ reader, backend: activeBackend }) => {
        if (cancelled) {
          reader.close()
          return
        }
        readerRef.current = reader
        backendRef.current = activeBackend
        setBackend(activeBackend)
        setError(null)
      })
      .catch(() => {
        if (!cancelled) {
          setError('バーコード読み取り機能を初期化できませんでした')
        }
      })

    return () => {
      cancelled = true
      readerRef.current?.close()
      readerRef.current = null
      backendRef.current = null
      setBackend(null)
    }
  }, [readerActive])

  // フレームループ本体。setState は「新しい値が確定したとき」だけ呼ぶ。
  useEffect(() => {
    if (!enabled) return
    stoppedRef.current = false
    // 有効化された直後の1フレーム目は、FRAME_INTERVAL_MS の間引きに引っかからず
    // 必ず解析させる。「長押し中だけ」モード（scanGating.ts の BarcodeTriggerMode）
    // では enabled がボタンの押下ごとに false→true と切り替わるため、前回停止直前の
    // 時刻がそのまま残っていると、短くタップしただけの操作が1フレームも解析されないまま
    // 終わってしまう（＝押しても読めない）ことがある。
    lastFrameAtRef.current = 0

    function scheduleNext(): void {
      if (stoppedRef.current) return
      const video = videoRef.current as VideoWithFrameCallback | null
      registeredVideoRef.current = video
      if (video?.requestVideoFrameCallback) {
        rvfcHandleRef.current = video.requestVideoFrameCallback(() => {
          tick()
          scheduleNext()
        })
      } else {
        rafHandleRef.current = requestAnimationFrame(() => {
          tick()
          scheduleNext()
        })
      }
    }

    // 1フレーム分の検出結果（複数件ありうる）を処理する。
    // ネイティブ・zxing どちらの経路からも、クロップ経路・フル フレーム経路の
    // どちらからも同じ後処理をするための共通処理。
    //
    // roiFilterTarget: 映像座標のROIでヒットをさらに絞り込みたいときだけその矩形を渡す。
    // null なら絞り込みをしない。「枠内のみ」がONでも、検出そのものを枠へ切り出して
    // 行った場合（クロップ経路）は必ず null になる（resolveBarcodeCropPlan 参照）。
    // 理由: クロップ後の hit.box は「切り出したcanvas自身」基準のクロップ座標であり、
    // 映像座標のROIとは分母が異なる。ここで比較すると座標系の食い違いにより、
    // 正しいヒットまで静かに弾いてしまう（クロップ結果は定義上すでに枠の内側なので、
    // そもそも絞り込みも不要）。
    //
    // 以前は hits[0] だけを見ており、それがデデュープ対象なら残り全部を
    // 無条件に捨てていた（縦に並んだ複数バーコードのうち真ん中が読めない
    // 不具合の原因）。今は selectNewHits でヒットごとに独立して判定し、
    // 追加すべきと判定された分だけまとめて処理する。
    function handleHits(hits: BarcodeHit[], roiFilterTarget: NormalizedRect | null): void {
      if (stoppedRef.current || hits.length === 0) return

      const candidates = roiFilterTarget ? filterHitsByRoi(hits, roiFilterTarget) : hits
      if (candidates.length === 0) return

      // 追加の可否は「今その値が呼び出し側の結果一覧に既にあるか」だけで決める
      // （isDuplicate 未指定時は常に false ＝一覧の状態によらず全て新規扱い）。
      // 時間はここでは一切関係ない。
      const isDuplicate = isDuplicateRef.current ?? (() => false)
      const newHits = selectNewHits(candidates, isDuplicate)
      const nowMs = Date.now()

      // 追加はされなかったが、その理由が「一覧に既にある」ことであるヒットにだけ、
      // 「読み取り済み」の合図を出す。連打防止のため、同じ値については
      // 直近 dedupeMs 以内に通知済みなら再通知しない（フレームごとに毎回
      // 光らせるとうるさいだけで、追加の可否にはそもそも関与しない）。
      // ビープ/バイブと同様、フレームにつき通知は最大1回に留める。
      const addedValues = new Set(newHits.map((h) => h.value))
      for (const hit of candidates) {
        if (addedValues.has(hit.value) || !isDuplicate(hit.value)) continue
        const lastNotified = lastDuplicateNotifyRef.current.get(hit.value)
        if (lastNotified !== undefined && nowMs - lastNotified < dedupeMs) continue
        lastDuplicateNotifyRef.current.set(hit.value, nowMs)
        onDuplicateRef.current?.(hit)
        break
      }

      if (newHits.length === 0) return
      setLastHit(newHits[newHits.length - 1])

      // ビープ/バイブは「このフレームで新規ヒットが1件以上あったか」でのみ判定する。
      // ヒット件数ぶん鳴らすとバーストになるため、フレームにつき最大1回に留める。
      if (vibrateRef.current) playVibration()
      if (beepRef.current) playBeep(audioCtxRef)

      for (const hit of newHits) {
        onScanRef.current({
          value: hit.value,
          source: 'barcode',
          format: hit.format,
          at: nowMs,
        })
      }
    }

    function tick(): void {
      const now = performance.now()
      if (now - lastFrameAtRef.current < FRAME_INTERVAL_MS) return
      if (busyRef.current) {
        // ウォッチドッグ: 欠陥1（zxingリーダーのPromiseが永久に解決されない
        // 経路）に対する最後の安全網。BUSY_WATCHDOG_MS の定義コメント参照。
        // ここで強制的に戻さないと、busyRef が true のまま固定され、
        // カメラ映像自体は流れ続けているのに以後すべてのフレームが
        // このガードで永久にスキップされ続ける（＝現場からは
        // 「アプリが落ちた/固まった」ように見える不具合そのもの）。
        if (now - busyStartedAtRef.current > BUSY_WATCHDOG_MS) {
          busyRef.current = false
          showTransientError(
            setError,
            errorResetTimerRef,
            'バーコード読み取り処理の応答が長時間なかったため、読み取りを再開しました',
            ERROR_TOAST_DURATION_MS,
          )
          // ここでは return せず、このフレームでそのまま検出を再開する
          // （次のtickまで待つより早く復旧できる）。以降は通常どおりの処理に続く。
        } else {
          return
        }
      }

      const reader = readerRef.current
      const video = videoRef.current
      if (!reader || !video) return
      if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return

      lastFrameAtRef.current = now
      busyRef.current = true
      busyStartedAtRef.current = now

      // 「枠内のみ」の枠は表示座標で保持しているため、使う直前に必ずここで
      // mapCoverRectToVideo を通して映像座標へ変換する（フレームループ全体で
      // 変換はこの1箇所だけに閉じ込め、他のどこでも変換しない）。
      const currentRoi = roiRef.current
      const videoRoi =
        restrictToRoiRef.current && currentRoi
          ? mapCoverRectToVideo(currentRoi, video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight)
          : undefined
      const cropPlan = resolveBarcodeCropPlan(restrictToRoiRef.current, videoRoi)

      // cropPlan.applyRoiFilter は常に false になる設計だが（crop.ts 参照）、
      // 呼び出し側はここで決めた値をそのまま使い、tick() の外で再判定しない。
      const finishFrame = (hits: BarcodeHit[]) => {
        handleHits(hits, cropPlan.applyRoiFilter ? (videoRoi ?? null) : null)
      }

      if (cropPlan.crop) {
        // 「枠内のみ」ON: video 全体ではなく、枠の範囲だけを OffscreenCanvas に
        // 切り出し、そこに対して検出する（ネイティブ・zxing どちらのバックエンドでも
        // 同じ切り出しを使う）。既定では等倍のまま（縮小しない）で、枠を広げすぎた
        // ときだけ CROP_PIXEL_BUDGET_PX に収まるよう computeCropSize が縮小する。
        const crop = cropPlan.crop
        const sx = Math.round(crop.x * video.videoWidth)
        const sy = Math.round(crop.y * video.videoHeight)
        const sw = Math.max(1, Math.round(crop.w * video.videoWidth))
        const sh = Math.max(1, Math.round(crop.h * video.videoHeight))
        const { width: dw, height: dh } = computeCropSize(sw, sh, CROP_PIXEL_BUDGET_PX)

        if (!cropCanvasRef.current) {
          cropCanvasRef.current = new OffscreenCanvas(dw, dh)
          cropCtxRef.current = cropCanvasRef.current.getContext('2d', {
            willReadFrequently: true,
          }) as OffscreenCanvasRenderingContext2D | null
        }
        const cropCanvas = cropCanvasRef.current
        if (cropCanvas.width !== dw || cropCanvas.height !== dh) {
          cropCanvas.width = dw
          cropCanvas.height = dh
        }
        const cropCtx = cropCtxRef.current
        if (!cropCtx) {
          busyRef.current = false
          return
        }
        // 切り出し（sx,sy,sw,sh は映像座標系のピクセル範囲）と等倍コピーを
        // drawImage 1回で行う。検出結果の box はこの canvas 自身の dw×dh を
        // 分母にした「クロップ座標」になる（=映像座標ではない。上のコメント参照）。
        cropCtx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh)

        reader
          .detect(cropCanvas)
          .then(finishFrame)
          .catch(() => {
            // 1 フレームの検出失敗はループを止めずに無視する
          })
          .finally(() => {
            busyRef.current = false
          })
        return
      }

      if (backendRef.current === 'native') {
        // ネイティブ経路・「枠内のみ」OFF: <video> をそのまま渡す。canvas 描画・
        // ダウンスケール・ImageBitmap 生成のいずれも行わない（このフレームでは
        // per-frame の createImageBitmap は一切発生しない）。boundingBox の正規化は
        // native.ts 側が videoWidth/videoHeight（= 映像の実解像度）で行う。
        reader
          .detect(video)
          .then(finishFrame)
          .catch(() => {
            // 1 フレームの検出失敗はループを止めずに無視する
          })
          .finally(() => {
            busyRef.current = false
          })
        return
      }

      // zxing-wasm フォールバック経路・「枠内のみ」OFF: ImageData 化のため canvas
      // 経由が必須。長辺 1280px を超える場合だけ縮小する（超えていなければ等倍のまま）。
      const { width, height } = computeDownscaledSize(video.videoWidth, video.videoHeight, ZXING_LONG_EDGE_PX)

      if (!canvasRef.current) {
        canvasRef.current = new OffscreenCanvas(width, height)
        ctxRef.current = canvasRef.current.getContext('2d', {
          willReadFrequently: true,
        }) as OffscreenCanvasRenderingContext2D | null
      }
      const canvas = canvasRef.current
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      const context = ctxRef.current
      if (!context) {
        busyRef.current = false
        return
      }
      context.drawImage(video, 0, 0, width, height)

      // canvas の ImageBitmap 化は zxing 側の detect() 実装内で行う
      // （ワーカーへ転送する必要があるのは zxing 経路だけのため）。
      reader
        .detect(canvas)
        .then(finishFrame)
        .catch(() => {
          // 1 フレームの検出失敗はループを止めずに無視する
        })
        .finally(() => {
          busyRef.current = false
        })
    }

    scheduleNext()

    return () => {
      stoppedRef.current = true
      // コールバック登録時と同じ要素に対して確実にキャンセルする
      const video = registeredVideoRef.current
      if (rvfcHandleRef.current !== null) {
        video?.cancelVideoFrameCallback?.(rvfcHandleRef.current)
        rvfcHandleRef.current = null
      }
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current)
        rafHandleRef.current = null
      }
    }
  }, [enabled, videoRef, dedupeMs])

  // アンマウント・無効化時の完全なクリーンアップ
  useEffect(() => {
    return () => {
      const ctx = audioCtxRef.current
      audioCtxRef.current = null
      if (ctx) {
        ctx.close().catch(() => {
          // クローズ失敗は無視してよい
        })
      }
      if (errorResetTimerRef.current !== null) {
        clearTimeout(errorResetTimerRef.current)
        errorResetTimerRef.current = null
      }
    }
  }, [])

  // シャッター押下時の1回限りの検出。フレームループと同じ readerRef を使い回す
  // （新しいバックエンドを作らない）。失敗しても投げずに空配列を返す。
  // source は常に「シャッター押下時点の静止フレーム」を焼き込んだ OffscreenCanvas
  // （= 映像の実解像度、captureFrame() 参照）で、ダウンスケールされていない。
  // これをバックエンドを問わず reader.detect にそのまま渡す（ネイティブ経路は
  // そのまま使い、zxing 経路は内部で ImageBitmap 化する）ため、ここでも
  // createImageBitmap は呼ばない。返る box はこの canvas の width/height を
  // 分母にした映像座標であり、boxesToMask に渡す videoRoi と同じ座標系になる。
  const detectBoxes = useCallback(async (source: OffscreenCanvas): Promise<NormalizedRect[]> => {
    const reader = readerRef.current
    if (!reader) return []
    try {
      const hits = await reader.detect(source)
      return hits.flatMap((hit) => (hit.box ? [hit.box] : []))
    } catch {
      return []
    }
  }, [])

  return { backend, lastHit, error, detectBoxes }
}
