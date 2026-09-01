// 画面上の「枠」（表示座標）1つぶんのドラッグ（移動・リサイズ）操作と、その永続化を
// まとめる小さなフック。バーコード枠・OCR枠はそれぞれ独立してこのフックを1回ずつ
// 呼び出すことで、お互いに影響を与えず独立してドラッグ・リサイズ・リセットできる
// （どちらの枠も移動・リサイズの物理はまったく同じで、既定値と localStorage の
// キーだけが違う）。
//
// React/DOM に依存する部分（pointer capture 等）だけをここに閉じ込め、
// 矩形の計算そのものは scan/ocr/roi.ts の純粋関数（moveRoi/resizeRoi）に委譲する。

import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { useCallback, useRef, useState } from 'react'
import { type HandleId, moveRoi, type RoiRect, resizeRoi } from '../scan/ocr'

export type DraggableRoi = {
  roi: RoiRect
  isDragging: boolean
  /** 枠の内側（移動）または縁のハンドル（リサイズ）を掴んだときに呼ぶ */
  beginDrag: (e: ReactPointerEvent<HTMLElement>, handle?: HandleId) => void
  updateDrag: (e: ReactPointerEvent<HTMLElement>) => void
  endDrag: (e: ReactPointerEvent<HTMLElement>) => void
  /** この枠だけを既定値に戻し、永続化する */
  reset: () => void
}

export function useDraggableRoi(
  defaultRoi: RoiRect,
  load: () => RoiRect,
  save: (rect: RoiRect) => void,
  containerRef: RefObject<HTMLElement | null>,
  disabled: boolean,
): DraggableRoi {
  const [roi, setRoi] = useState<RoiRect>(load)
  const [isDragging, setIsDragging] = useState(false)
  // ドラッグ中に確定した最新の矩形を、setState のタイミングに左右されず
  // ポインタアップ時点で即座に読めるようにしておくための ref。
  const latestRoiRef = useRef(roi)
  const dragInfoRef = useRef<{
    startClientX: number
    startClientY: number
    startRoi: RoiRect
    containerW: number
    containerH: number
    handle?: HandleId
  } | null>(null)

  const beginDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>, handle?: HandleId) => {
      if (disabled) return
      const container = containerRef.current
      if (!container) return
      e.stopPropagation()
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragInfoRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startRoi: roi,
        containerW: container.clientWidth,
        containerH: container.clientHeight,
        handle,
      }
      setIsDragging(true)
    },
    [disabled, containerRef, roi],
  )

  const updateDrag = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const info = dragInfoRef.current
    if (!info || info.containerW <= 0 || info.containerH <= 0) return
    e.preventDefault()
    const dx = (e.clientX - info.startClientX) / info.containerW
    const dy = (e.clientY - info.startClientY) / info.containerH
    const next = info.handle ? resizeRoi(info.startRoi, info.handle, dx, dy) : moveRoi(info.startRoi, dx, dy)
    latestRoiRef.current = next
    setRoi(next)
  }, [])

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!dragInfoRef.current) return
      dragInfoRef.current = null
      setIsDragging(false)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      save(latestRoiRef.current)
    },
    [save],
  )

  const reset = useCallback(() => {
    latestRoiRef.current = defaultRoi
    setRoi(defaultRoi)
    save(defaultRoi)
  }, [defaultRoi, save])

  return { roi, isDragging, beginDrag, updateDrag, endDrag, reset }
}
