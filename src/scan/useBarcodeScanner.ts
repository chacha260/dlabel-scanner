// カメラ映像を継続的に監視してバーコードを検出するフレームループ。
// パフォーマンスが最優先: 10fps 上限・処理中フレームのスキップ・
// 720px へのダウンスケール・ref による状態管理（毎フレーム setState しない）を徹底する。

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { RawScan } from '../parse/types'
import { createBarcodeReader } from './barcode'
import type { BarcodeBackend, BarcodeHit, BarcodeReader, NormalizedRect } from './barcode'

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

const FRAME_INTERVAL_MS = 100 // 10fps 上限
const LONG_EDGE_PX = 720

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

      const longEdge = Math.max(video.videoWidth, video.videoHeight)
      const scale = longEdge > LONG_EDGE_PX ? LONG_EDGE_PX / longEdge : 1
      const width = Math.max(1, Math.round(video.videoWidth * scale))
      const height = Math.max(1, Math.round(video.videoHeight * scale))

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

      createImageBitmap(canvas)
        .then((bitmap) => reader.detect(bitmap))
        .then((hits) => {
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
        })
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
  const detectBoxes = useCallback(async (source: OffscreenCanvas): Promise<NormalizedRect[]> => {
    const reader = readerRef.current
    if (!reader) return []
    try {
      const bitmap = await createImageBitmap(source)
      const hits = await reader.detect(bitmap)
      return hits.flatMap((hit) => (hit.box ? [hit.box] : []))
    } catch {
      return []
    }
  }, [])

  return { backend, lastHit, error, detectBoxes }
}
