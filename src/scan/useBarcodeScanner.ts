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
import { createBarcodeReader } from './barcode'
import type { BarcodeBackend, BarcodeHit, BarcodeReader, NormalizedRect } from './barcode'
import { computeDownscaledSize } from './barcode/scale'

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
  dedupeMs?: number
  /** 検出時のビープ音を鳴らすか（既定: true） */
  beep?: boolean
  /** 検出時にバイブレーションさせるか（既定: true） */
  vibrate?: boolean
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
  onScan,
}: UseBarcodeScannerOptions): UseBarcodeScannerResult {
  const [backend, setBackend] = useState<BarcodeBackend | null>(null)
  const [lastHit, setLastHit] = useState<BarcodeHit | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onScanRef = useRef(onScan)
  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  // ビープ / バイブの ON-OFF は ref 経由で読む。
  // 依存配列に入れるとトグルのたびにフレームループが張り直しになるため。
  const beepRef = useRef(beep)
  const vibrateRef = useRef(vibrate)
  useEffect(() => {
    beepRef.current = beep
    vibrateRef.current = vibrate
  }, [beep, vibrate])

  const readerRef = useRef<BarcodeReader | null>(null)
  // フレームループの tick() が「ネイティブ経路（video を直接渡す）」と
  // 「zxing 経路（canvas 経由が必須）」のどちらで動くかを判定するために保持する。
  // React state (backend) は再レンダーを起こすため使わず、ref で持つ。
  const backendRef = useRef<BarcodeBackend | null>(null)
  const canvasRef = useRef<OffscreenCanvas | null>(null)
  const ctxRef = useRef<OffscreenCanvasRenderingContext2D | null>(null)
  const busyRef = useRef(false)
  const lastFrameAtRef = useRef(0)
  const lastSeenRef = useRef<Map<string, number>>(new Map())
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

    // 検出結果1件を「新しいヒットか」判定し、必要ならビープ/バイブ/onScan まで行う。
    // ネイティブ・zxing どちらの経路からも同じ後処理をするための共通処理。
    function handleHits(hits: BarcodeHit[]): void {
      if (stoppedRef.current || hits.length === 0) return
      const hit = hits[0]
      const seenAt = lastSeenRef.current.get(hit.value)
      const nowMs = Date.now()
      if (seenAt !== undefined && nowMs - seenAt < dedupeMs) return

      lastSeenRef.current.set(hit.value, nowMs)
      setLastHit(hit)
      if (vibrateRef.current) playVibration()
      if (beepRef.current) playBeep(audioCtxRef)
      onScanRef.current({
        value: hit.value,
        source: 'barcode',
        format: hit.format,
        at: nowMs,
      })
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
          .then(handleHits)
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
        .then(handleHits)
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
