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

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { RawScan } from '../parse/types'
import { createBarcodeReader, filterHitsByRoi, selectNewHits } from './barcode'
import type { BarcodeBackend, BarcodeHit, BarcodeReader, NormalizedRect } from './barcode'
import { computeDownscaledSize } from './barcode/scale'
// ROI の表示座標→映像座標への変換は geometry.ts の1箇所だけに閉じ込める
// （ocr/index.ts は tesseract 一式を含む重いモジュールのため、型と変換関数だけを
// 直接ファイルから import し、余計な依存をこのフレームループに持ち込まない）。
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
  const busyRef = useRef(false)
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

    createBarcodeReader()
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
    // ネイティブ・zxing どちらの経路からも同じ後処理をするための共通処理。
    //
    // 以前は hits[0] だけを見ており、それがデデュープ対象なら残り全部を
    // 無条件に捨てていた（縦に並んだ複数バーコードのうち真ん中が読めない
    // 不具合の原因）。今は selectNewHits でヒットごとに独立して判定し、
    // 追加すべきと判定された分だけまとめて処理する。
    function handleHits(hits: BarcodeHit[], video: HTMLVideoElement): void {
      if (stoppedRef.current || hits.length === 0) return

      // 「枠内のみ」有効時は、box の中心が ROI（映像座標）の内側にあるヒットだけに絞る。
      // ROI は表示座標で保持しているため、比較の直前に必ずここで映像座標へ変換する
      // （変換をこの1箇所に閉じ込め、他ではやらない）。box を持たないヒットは
      // filterHitsByRoi 内で常に採用される。
      const currentRoi = roiRef.current
      const candidates =
        restrictToRoiRef.current && currentRoi
          ? filterHitsByRoi(hits, mapCoverRectToVideo(currentRoi, video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight))
          : hits
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
      if (busyRef.current) return

      const reader = readerRef.current
      const video = videoRef.current
      if (!reader || !video) return
      if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return

      lastFrameAtRef.current = now
      busyRef.current = true

      if (backendRef.current === 'native') {
        // ネイティブ経路: <video> をそのまま渡す。canvas 描画・ダウンスケール・
        // ImageBitmap 生成のいずれも行わない（このフレームでは per-frame の
        // createImageBitmap は一切発生しない）。boundingBox の正規化は
        // native.ts 側が videoWidth/videoHeight（= 映像の実解像度）で行う。
        reader
          .detect(video)
          .then((hits) => handleHits(hits, video))
          .catch(() => {
            // 1 フレームの検出失敗はループを止めずに無視する
          })
          .finally(() => {
            busyRef.current = false
          })
        return
      }

      // zxing-wasm フォールバック経路: ImageData 化のため canvas 経由が必須。
      // 長辺 1280px を超える場合だけ縮小する（超えていなければ等倍のまま）。
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
        .then((hits) => handleHits(hits, video))
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
