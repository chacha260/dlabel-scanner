// 背面カメラの起動・停止・トーチ制御・画面スリープ防止をまとめる React フック。
// Android Chrome 単体をターゲットとし、非対応 API は必ず try/catch で無害化する。

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

// torch / focusMode は標準の DOM 型定義（lib.dom.d.ts）に含まれていないため、
// このファイル内でのみ使う狭い拡張インターフェースを用意する。
// グローバルな型汚染を避けるため `declare global` は使わず、局所的なキャストのみで扱う。
interface ExtendedMediaTrackCapabilities extends MediaTrackCapabilities {
  torch?: boolean
  focusMode?: string[]
}
interface ExtendedMediaTrackConstraintSet extends MediaTrackConstraintSet {
  torch?: boolean
  focusMode?: string
}

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
    releaseWakeLock()
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [releaseWakeLock])

  const start = useCallback(async () => {
    setError(null)
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
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
        } catch {
          setTorchSupported(false)
        }
      }

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream
        try {
          await videoRef.current.play()
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

  return { videoRef, stream, ready, error, start, stop, torchSupported, torchOn, toggleTorch }
}
