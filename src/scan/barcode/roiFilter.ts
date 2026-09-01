// バーコード検出結果を ROI 枠（水色の枠）で絞り込む純粋関数。
//
// 採用ルール: box の「中心点」が ROI の内側（境界含む）にあるヒットだけを採用する。
// 「少しでも重なっていれば採用」にすると、隣接する別のバーコード（例: 縦に3本
// 並んだラベルの上下2本）まで拾ってしまい、「枠で狙ったものだけ読みたい」という
// 要望を満たせない。中心点判定はユーザーから見て挙動が予測しやすく、
// 枠を対象のバーコードにきっちり合わせれば確実に1本だけ選べる。
//
// 座標系についての注意: ここで比較する2つの矩形（hit.box と roi）は、どちらも
// 必ず「映像座標」（検出に使われた入力そのものの幅・高さに対する 0..1 の割合）で
// 渡すこと。ROI は画面上では表示座標（<video> の CSS ボックスに対する割合）で
// 管理されているため、呼び出し側が geometry.ts の mapCoverRectToVideo で
// 映像座標へ変換してから渡す（変換はこの関数の責務にしない＝呼び出し側で
// 一箇所に閉じ込める）。
//
// box が undefined のヒット（位置情報を提供しないバックエンド）は判定のしようが
// ないため、除外せず常に採用する。位置情報が無いことを理由に検出結果を
// 丸ごと捨ててしまうと、そのバックエンドではバーコードが一切読めなくなるため。

import type { BarcodeHit, NormalizedRect } from './types'

/** 1件のヒットが ROI（映像座標）の内側かどうかを判定する */
export function isHitInRoi(hit: BarcodeHit, roi: NormalizedRect): boolean {
  const box = hit.box
  if (!box) return true // 位置情報が無い場合は判定できないため採用する
  const centerX = box.x + box.w / 2
  const centerY = box.y + box.h / 2
  return centerX >= roi.x && centerX <= roi.x + roi.w && centerY >= roi.y && centerY <= roi.y + roi.h
}

/** hits のうち ROI（映像座標）の内側にあるものだけを、検出順を保ったまま返す */
export function filterHitsByRoi(hits: BarcodeHit[], roi: NormalizedRect): BarcodeHit[] {
  return hits.filter((hit) => isHitInRoi(hit, roi))
}
