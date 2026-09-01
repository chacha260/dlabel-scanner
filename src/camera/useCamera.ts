// 背面カメラの起動・停止・トーチ制御・ズーム制御・画面スリープ防止をまとめる React フック。
// Android Chrome 単体をターゲットとし、非対応 API は必ず try/catch で無害化する。

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { ZoomRange } from './zoom'

// torch / focusMode / zoom は標準の DOM 型定義（lib.dom.d.ts）に含まれていないため、
// このファイル内でのみ使う狭い拡張インターフェースを用意する。
// グローバルな型汚染を避けるため `declare global` は使わず、局所的なキャストのみで扱う。
interface ExtendedMediaTrackCapabilities extends MediaTrackCapabilities {
  torch?: boolean
  focusMode?: string[]
  // ズーム非対応端末では capabilities に zoom キー自体が存在しない
  zoom?: { min: number; max: number; step: number }
}
interface ExtendedMediaTrackConstraintSet extends MediaTrackConstraintSet {
  torch?: boolean
  focusMode?: string
  zoom?: number
}
interface ExtendedMediaTrackSettings extends MediaTrackSettings {
  zoom?: number
}

// 実際に許可された解像度（診断表示用）。「要求した値」ではなく「端末が実際に
// 提供している値」であることに意味がある（小さい端末では ideal 通りにならない）。
export type Resolution = { width: number; height: number }

export type UseCameraResult = {
  videoRef: RefObject<HTMLVideoElement | null>
  stream: MediaStream | null
  ready: boolean
  error: string | null
  start: () => Promise<void>
  stop: () => void
  torchSupported: boolean
  torchOn: boolean
  toggleTorch: () => Promise<void>
  /** 実際に許可された映像解像度。取得できるまでは null */
  resolution: Resolution | null
  zoomSupported: boolean
  /** 現在のズーム値（zoomSupported が false のときは null） */
  zoom: number | null
  /** ズームの範囲（zoomSupported が false のときは null） */
  zoomRange: ZoomRange | null
  setZoom: (value: number) => Promise<void>
}

function toErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : undefined
  if (name === 'NotAllowedError') return 'カメラの使用が許可されていません'
  if (name === 'NotFoundError') return 'カメラが見つかりません'
  return 'カメラを起動できませんでした'
}

export function useCamera(): UseCameraResult {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)

  const [stream, setStream] = useState<MediaStream | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [torchSupported, setTorchSupported] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [resolution, setResolution] = useState<Resolution | null>(null)
  const [zoomSupported, setZoomSupported] = useState(false)
  const [zoom, setZoomState] = useState<number | null>(null)
  const [zoomRange, setZoomRange] = useState<ZoomRange | null>(null)

  // start() 中に登録した loadedmetadata ハンドラを、次回開始時・停止時に
  // 確実に取り外すために覚えておく（video 要素自体は使い回されるため）。
  const loadedMetadataHandlerRef = useRef<(() => void) | null>(null)

  const releaseWakeLock = useCallback(() => {
    const lock = wakeLockRef.current
    wakeLockRef.current = null
    if (lock) {
      lock.release().catch(() => {
        // 解放に失敗しても表示上問題ないため無視する
      })
    }
  }, [])

  const acquireWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen')
      }
    } catch {
      // Wake Lock API 非対応・拒否時は無視する（画面が消えるだけで機能自体は動く）
    }
  }, [])

  const stop = useCallback(() => {
    const current = streamRef.current
    if (current) {
      for (const track of current.getTracks()) {
        track.stop()
      }
    }
    streamRef.current = null
    setStream(null)
    setReady(false)
    setTorchSupported(false)
    setTorchOn(false)
    setResolution(null)
    setZoomSupported(false)
    setZoomState(null)
    setZoomRange(null)
    const video = videoRef.current
    if (video) {
      if (loadedMetadataHandlerRef.current) {
        video.removeEventListener('loadedmetadata', loadedMetadataHandlerRef.current)
        loadedMetadataHandlerRef.current = null
      }
      video.srcObject = null
    }
    releaseWakeLock()
  }, [releaseWakeLock])

  const start = useCallback(async () => {
    setError(null)
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          // ideal は「できれば」の指定であり、端末が対応していなくても失敗しない。
          // 対応端末ではここを引き上げるだけで、小さい・バーの細いバーコードの
          // 読み取りやすさが大きく変わる（詳細は useBarcodeScanner.ts を参照）。
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
        audio: false,
      })
      streamRef.current = mediaStream
      setStream(mediaStream)

      const [track] = mediaStream.getVideoTracks()
      if (track) {
        try {
          const focusConstraint: ExtendedMediaTrackConstraintSet = { focusMode: 'continuous' }
          await track.applyConstraints({ advanced: [focusConstraint] })
        } catch {
          // 連続オートフォーカス非対応環境では無視する
        }

        try {
          const capabilities = track.getCapabilities() as ExtendedMediaTrackCapabilities
          setTorchSupported(Boolean(capabilities.torch))

          const zoomCap = capabilities.zoom
          if (
            zoomCap &&
            Number.isFinite(zoomCap.min) &&
            Number.isFinite(zoomCap.max) &&
            zoomCap.max > zoomCap.min
          ) {
            const range: ZoomRange = {
              min: zoomCap.min,
              max: zoomCap.max,
              step: Number.isFinite(zoomCap.step) && zoomCap.step > 0 ? zoomCap.step : 0,
            }
            const settings = track.getSettings() as ExtendedMediaTrackSettings
            setZoomSupported(true)
            setZoomRange(range)
            setZoomState(typeof settings.zoom === 'number' ? settings.zoom : range.min)
          } else {
            setZoomSupported(false)
            setZoomRange(null)
            setZoomState(null)
          }
        } catch {
          setTorchSupported(false)
          setZoomSupported(false)
          setZoomRange(null)
          setZoomState(null)
        }

        // 「実際に許可された」解像度（診断表示用）。ideal はあくまで希望値なので、
        // 端末が実際に何を提供しているかは getSettings() で確認する必要がある。
        try {
          const settings = track.getSettings()
          if (settings.width && settings.height) {
            setResolution({ width: settings.width, height: settings.height })
          }
        } catch {
          // 取得できなくても video 側の loadedmetadata で補えるため無視する
        }
      }

      if (videoRef.current) {
        const video = videoRef.current
        video.srcObject = mediaStream

        // getSettings() が取れない・0 を返す端末向けのフォールバック。
        // メタデータ確定後の videoWidth/videoHeight を「実際の解像度」として使う。
        const handleLoadedMetadata = () => {
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            setResolution((prev) => prev ?? { width: video.videoWidth, height: video.videoHeight })
          }
        }
        if (loadedMetadataHandlerRef.current) {
          video.removeEventListener('loadedmetadata', loadedMetadataHandlerRef.current)
        }
        loadedMetadataHandlerRef.current = handleLoadedMetadata
        video.addEventListener('loadedmetadata', handleLoadedMetadata)

        try {
          await video.play()
        } catch {
          // 自動再生に失敗してもストリーム自体は有効なので無視する
        }
      }

      setReady(true)
      await acquireWakeLock()
    } catch (err) {
      streamRef.current = null
      setStream(null)
      setReady(false)
      setError(toErrorMessage(err))
    }
  }, [acquireWakeLock])

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    const next = !torchOn
    try {
      const torchConstraint: ExtendedMediaTrackConstraintSet = { torch: next }
      await track.applyConstraints({ advanced: [torchConstraint] })
      setTorchOn(next)
    } catch {
      // トーチ制御に失敗しても致命的ではないため無視する
    }
  }, [torchOn])

  // ズームは対応端末のみ有効（capabilities.zoom が無い場合は zoomSupported が false のまま）。
  // 失敗しても投げない（呼び出し側は resolveZoomValue で事前に範囲チェック済みの値を渡す想定だが、
  // 念のためここでも try/catch で無害化する）。
  const setZoom = useCallback(async (value: number) => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try {
      const zoomConstraint: ExtendedMediaTrackConstraintSet = { zoom: value }
      await track.applyConstraints({ advanced: [zoomConstraint] })
      setZoomState(value)
    } catch {
      // ズーム制御に失敗しても致命的ではないため無視する
    }
  }, [])

  // タブが再度前面に来たときに Wake Lock を再取得する
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && streamRef.current) {
        void acquireWakeLock()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [acquireWakeLock])

  // アンマウント時に必ずカメラとロックを解放する
  useEffect(() => {
    return () => {
      stop()
    }
  }, [stop])

  return {
    videoRef,
    stream,
    ready,
    error,
    start,
    stop,
    torchSupported,
    torchOn,
    toggleTorch,
    resolution,
    zoomSupported,
    zoom,
    zoomRange,
    setZoom,
  }
}
