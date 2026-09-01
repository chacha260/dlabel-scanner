// 背面カメラの起動・停止・トーチ制御・ズーム制御・画面スリープ防止をまとめる React フック。
// Android Chrome 単体をターゲットとし、非対応 API は必ず try/catch で無害化する。

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { CAPTURE_QUALITY_CONSTRAINTS, type CaptureQuality, DEFAULT_CAPTURE_QUALITY } from './quality'
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
  /** 現在の画質プリセット（getUserMedia に要求する解像度） */
  quality: CaptureQuality
  /**
   * 画質プリセットを切り替える。既にストリームが起動中の場合は、新しい制約で
   * ストリームを張り直す（stop → start）。張り直しにより camera.stream の参照が
   * 変わるため、呼び出し側（SimpleScanScreen）がズームの再適用に使っている
   * 「camera.stream 変化を見て保存済みズームを当て直す」既存の仕組みがそのまま働く
   * ＝ ここでズーム再適用を重複して行う必要はない。
   */
  setQuality: (value: CaptureQuality) => Promise<void>
}

function toErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : undefined
  if (name === 'NotAllowedError') return 'カメラの使用が許可されていません'
  if (name === 'NotFoundError') return 'カメラが見つかりません'
  return 'カメラを起動できませんでした'
}

/**
 * @param initialQuality 起動時（最初の start() 呼び出し時）に使う画質プリセット。
 *   呼び出し側で永続化された設定（prefs.ts）を読んで渡すことを想定している
 *   （このフック自身は永続化を一切行わない。他のプリファレンスと同様、
 *   保存・復元は呼び出し側の責務のままにする）。省略時は既定の 'max'。
 */
export function useCamera(initialQuality: CaptureQuality = DEFAULT_CAPTURE_QUALITY): UseCameraResult {
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
  const [quality, setQualityState] = useState<CaptureQuality>(initialQuality)
  // start() は useCallback の外から見える最新値を参照する必要があるため、
  // state とは別に ref でも同じ値を保持する（quality を start の依存配列に
  // 入れると、画質を変えるたびにフレームループ側の再生成が連鎖しかねないため、
  // 他の設定値（roi・restrictToRoi 等）と同様に ref 経由で読む）。
  const qualityRef = useRef<CaptureQuality>(initialQuality)

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
      // ideal は「できれば」の指定であり、端末が対応していなくても失敗しない。
      // 対応端末ではここを引き上げるだけで、小さい・バーの細いバーコードの
      // 読み取りやすさが大きく変わる（詳細は useBarcodeScanner.ts を参照）。
      // 画質プリセット（既定は 'max' = 端末の最大）は qualityRef 経由で読む
      // （setQuality 参照。ここを直接 quality state にすると start 自体が
      // 画質変更のたびに作り直され、呼び出し側の useEffect の依存が複雑になる）。
      const { width, height } = CAPTURE_QUALITY_CONSTRAINTS[qualityRef.current]
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: width },
          height: { ideal: height },
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

  // 画質プリセットの切り替え。まだストリームが無い（起動前）場合は qualityRef を
  // 更新するだけでよく、次の start() 呼び出し時にそのまま反映される。
  // 既にストリームがある場合は、新しい制約で取り直すため一度 stop() してから
  // start() する（同時に2つのカメラハンドルを持たないようにするため）。
  // stop()/start() を経ると camera.stream の参照が変わるので、呼び出し側
  // （SimpleScanScreen）が持つ「camera.stream 変化を見て保存済みズームを当て直す」
  // 既存の仕組みがそのまま働き、ズームの再適用もここで別途行う必要はない。
  const setQuality = useCallback(
    async (value: CaptureQuality) => {
      if (qualityRef.current === value) return
      qualityRef.current = value
      setQualityState(value)
      if (streamRef.current) {
        stop()
        await start()
      }
    },
    [stop, start],
  )

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
    quality,
    setQuality,
  }
}
