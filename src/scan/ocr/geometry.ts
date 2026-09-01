// 画面に表示している ROI 枠と、映像の実解像度上の切り出し範囲との座標変換。
//
// <video> は object-fit: cover で表示しているため、映像は表示枠を覆うように
// 拡大され、はみ出した部分は左右（または上下）が切り落とされる。
// 表示枠に対する割合をそのまま videoWidth / videoHeight に掛けると、
// 切り落とされた分だけ実際の切り出し位置がずれてしまう。
// ここでその cover 変換を逆算し、映像の実解像度に対する割合へ直す。

import type { RoiRect } from './types'

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * 表示枠に対する割合で表された矩形を、映像の実解像度に対する割合へ変換する。
 *
 * @param rect      表示枠（= video 要素の CSS ボックス）に対する 0..1 の矩形
 * @param displayW  表示枠の幅(px)
 * @param displayH  表示枠の高さ(px)
 * @param videoW    映像の実解像度の幅(px)
 * @param videoH    映像の実解像度の高さ(px)
 */
export function mapCoverRectToVideo(
  rect: RoiRect,
  displayW: number,
  displayH: number,
  videoW: number,
  videoH: number,
): RoiRect {
  // 寸法が取れていない場合は変換のしようがないため、そのまま返す
  if (
    !Number.isFinite(displayW) ||
    !Number.isFinite(displayH) ||
    !Number.isFinite(videoW) ||
    !Number.isFinite(videoH) ||
    displayW <= 0 ||
    displayH <= 0 ||
    videoW <= 0 ||
    videoH <= 0
  ) {
    return rect
  }

  // cover は「表示枠を覆う最小の倍率」で拡大する
  const scale = Math.max(displayW / videoW, displayH / videoH)
  const renderedW = videoW * scale
  const renderedH = videoH * scale

  // 拡大後に表示枠からはみ出した分（片側あたり）
  const offsetX = (renderedW - displayW) / 2
  const offsetY = (renderedH - displayH) / 2

  const x = clamp01((rect.x * displayW + offsetX) / renderedW)
  const y = clamp01((rect.y * displayH + offsetY) / renderedH)
  const w = clamp01((rect.w * displayW) / renderedW)
  const h = clamp01((rect.h * displayH) / renderedH)

  // 右端・下端が映像をはみ出さないように詰める
  return {
    x,
    y,
    w: Math.max(0, Math.min(w, 1 - x)),
    h: Math.max(0, Math.min(h, 1 - y)),
  }
}
