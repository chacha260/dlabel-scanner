// OCR の ROI 枠（表示座標、0..1）に関する純粋なロジック（移動・リサイズ・クランプ・
// 永続化）をまとめる。DOM/React には依存しない（SimpleScanScreen.tsx はここの関数を
// ポインタイベントから呼び出すだけにする）。
//
// 注意: ここで扱う矩形は常に表示座標（<video> の CSS ボックスに対する割合）。
// 映像座標へは geometry.ts の mapCoverRectToVideo を通じてのみ変換する。

import type { RoiRect } from './types'

// 既定の ROI（画面中央よりやや上）。ScanScreen.tsx と同じ値を流用する。
export const DEFAULT_ROI: RoiRect = { x: 0.1, y: 0.26, w: 0.8, h: 0.18 }

// ROI の最小サイズ（表示枠に対する割合）。これより小さくはリサイズさせない。
export const MIN_ROI_W = 0.08
export const MIN_ROI_H = 0.05

const ROI_STORAGE_KEY = 'dlabel-scanner:ocrRoi'

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (max < min) return min // 範囲が壊れている場合は安全側（最小値）に倒す
  return Math.min(max, Math.max(min, value))
}

/** ROI が表示枠内に収まり、最小サイズを下回らないようにクランプする */
export function clampRoi(rect: RoiRect): RoiRect {
  const w = clampNumber(rect.w, MIN_ROI_W, 1)
  const h = clampNumber(rect.h, MIN_ROI_H, 1)
  const x = clampNumber(rect.x, 0, 1 - w)
  const y = clampNumber(rect.y, 0, 1 - h)
  return { x, y, w, h }
}

/** ROI 全体を dx, dy（表示枠に対する割合）だけ平行移動する（枠内にクランプ済み） */
export function moveRoi(base: RoiRect, dx: number, dy: number): RoiRect {
  return clampRoi({ x: base.x + dx, y: base.y + dy, w: base.w, h: base.h })
}

export type HandleId = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

const HANDLE_EDGES: Record<HandleId, { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean }> = {
  n: { top: true },
  s: { bottom: true },
  e: { right: true },
  w: { left: true },
  nw: { top: true, left: true },
  ne: { top: true, right: true },
  sw: { bottom: true, left: true },
  se: { bottom: true, right: true },
}

/**
 * ハンドル handle をつまんで dx, dy（表示枠に対する割合）だけ動かした結果の ROI を返す。
 * つまんでいない側の辺は固定したまま、動かした側の辺だけを移動する。
 * 最小サイズを下回りそうな場合は、固定辺は動かさず可動辺側で吸収する。
 */
export function resizeRoi(base: RoiRect, handle: HandleId, dx: number, dy: number): RoiRect {
  const edges = HANDLE_EDGES[handle]
  let left = base.x
  let top = base.y
  let right = base.x + base.w
  let bottom = base.y + base.h

  if (edges.left) left += dx
  if (edges.right) right += dx
  if (edges.top) top += dy
  if (edges.bottom) bottom += dy

  // 可動辺が固定辺を追い越して矩形が反転しないよう、最小サイズを保つ
  if (edges.left) left = Math.min(left, right - MIN_ROI_W)
  if (edges.right) right = Math.max(right, left + MIN_ROI_W)
  if (edges.top) top = Math.min(top, bottom - MIN_ROI_H)
  if (edges.bottom) bottom = Math.max(bottom, top + MIN_ROI_H)

  // 表示枠(0..1)の範囲内にクランプする
  left = Math.max(0, left)
  top = Math.max(0, top)
  right = Math.min(1, right)
  bottom = Math.min(1, bottom)

  // クランプの結果、最小サイズを割ってしまう場合は可動辺側でさらに吸収する
  if (right - left < MIN_ROI_W) {
    if (edges.left) left = right - MIN_ROI_W
    else right = left + MIN_ROI_W
  }
  if (bottom - top < MIN_ROI_H) {
    if (edges.top) top = bottom - MIN_ROI_H
    else bottom = top + MIN_ROI_H
  }

  return clampRoi({ x: left, y: top, w: right - left, h: bottom - top })
}

/** 永続化された値として妥当な ROI 矩形かどうかを検証する（型・範囲・最小サイズをチェック） */
export function isValidRoiRect(value: unknown): value is RoiRect {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  const keys: (keyof RoiRect)[] = ['x', 'y', 'w', 'h']
  for (const key of keys) {
    const v = r[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) return false
  }
  const rect = r as unknown as RoiRect
  const EPS = 1e-6
  if (rect.w < MIN_ROI_W - EPS || rect.h < MIN_ROI_H - EPS) return false
  if (rect.x < -EPS || rect.y < -EPS) return false
  if (rect.x + rect.w > 1 + EPS || rect.y + rect.h > 1 + EPS) return false
  return true
}

/**
 * localStorage から永続化済みの ROI を読み込む。読めない・壊れている・
 * 範囲外などいかなる場合も例外を投げず、既定値にフォールバックする。
 * ROI 矩形だけを保存対象とする（スキャン結果はこれまで通りメモリ上のみ）。
 */
export function loadPersistedRoi(): RoiRect {
  try {
    const raw = localStorage.getItem(ROI_STORAGE_KEY)
    if (!raw) return DEFAULT_ROI
    const parsed: unknown = JSON.parse(raw)
    return isValidRoiRect(parsed) ? parsed : DEFAULT_ROI
  } catch {
    return DEFAULT_ROI
  }
}

/** ROI 矩形を localStorage に保存する。保存に失敗しても致命的ではないため無視する */
export function savePersistedRoi(rect: RoiRect): void {
  try {
    localStorage.setItem(ROI_STORAGE_KEY, JSON.stringify(rect))
  } catch {
    // プライベートブラウジング等で保存できなくても、UI 上は既定動作のまま続行できる
  }
}
