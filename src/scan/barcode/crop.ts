// 「枠内のみ」ON時に、バーコード検出を枠（映像座標の矩形）へ切り出した
// OffscreenCanvas に対してだけ行うための純粋ロジック。DOM/canvas には一切依存しない
// （実際の canvas 生成・drawImage は useBarcodeScanner.ts のフレームループ側で行う）。
//
// 狙い: 枠は画面の一部でしかないことが多いため、そこだけ切り出せば解析対象の画素数を
// 数分の一〜十数分の一に削減できる。しかも切り出した範囲はダウンスケールせず
// 等倍（ネイティブ解像度）のまま渡せるので、「720pへの一律縮小をやめたことで
// 細いバーが読めるようになった」効果を一切損なわない（フル解像度で全画面を
// 解析するより軽く、かつ縮小して精度を落とすより正確、という両取りができる）。
//
// 唯一の例外は、ユーザーが枠を画面のほぼ全体まで広げた場合: 切り出しても画素数が
// ほとんど減らず、フル解像度そのままでは負荷軽減にならない。そのときだけ
// 予算(CROP_PIXEL_BUDGET_PX)を超えないよう縮小する。小さい枠は常に等倍のまま
// （拡大はしないし、予算内なら縮小もしない）。

import type { NormalizedRect } from './types'

export type CropSize = { width: number; height: number; scale: number }

// 約2.5メガピクセル。OCR_PIXEL_BUDGET（文字認識用、30万px）よりずっと大きく
// 取ってある。バーコードのバーは1px単位の情報量を持つため、文字認識向けの
// 予算のように大きく削ると読めなくなる。10fpsで解析し続けても重くならない
// 範囲で、かつ狭い枠なら等倍のまま収まるよう、この値を選んでいる。
export const CROP_PIXEL_BUDGET_PX = 2_500_000

/**
 * 切り出し元（枠を映像のピクセル単位に直したサイズ）から、実際に検出へ渡す
 * OffscreenCanvas の出力サイズを求める。
 * - 画素数が予算以下ならスケールは常に1（等倍。縮小もしない・拡大もしない）
 * - 予算を超える場合だけ、アスペクト比を保ったまま画素数がちょうど予算に収まる
 *   スケールまで縮小する
 * - sourceWidthPx・sourceHeightPx・budgetPx が 0 以下や NaN であっても、
 *   例外を投げず有限の正の値を返す
 */
export function computeCropSize(
  sourceWidthPx: number,
  sourceHeightPx: number,
  budgetPx: number = CROP_PIXEL_BUDGET_PX,
): CropSize {
  const safeW = Number.isFinite(sourceWidthPx) && sourceWidthPx > 0 ? sourceWidthPx : 1
  const safeH = Number.isFinite(sourceHeightPx) && sourceHeightPx > 0 ? sourceHeightPx : 1
  const safeBudget = Number.isFinite(budgetPx) && budgetPx > 0 ? budgetPx : 1

  const sourcePixels = safeW * safeH
  // 予算内に収まっているなら等倍のまま（= 1未満に拡大はしないし、余裕があっても縮小しない）
  const scale = sourcePixels > safeBudget ? Math.sqrt(safeBudget / sourcePixels) : 1

  const width = Math.max(1, Math.round(safeW * scale))
  const height = Math.max(1, Math.round(safeH * scale))
  return { width, height, scale }
}

export type BarcodeCropPlan = {
  /** 検出対象を切り出す枠（映像座標）。null なら切り出さずフレーム全体を対象にする */
  crop: NormalizedRect | null
  /**
   * 検出結果に対して映像座標のROIフィルタ（filterHitsByRoi）をさらに適用すべきか。
   * crop が非nullのときは常に false（下記コメント参照）。
   */
  applyRoiFilter: boolean
}

/**
 * 「枠内のみ」トグルと枠（映像座標。まだ枠が確定していない場合は undefined）から、
 * バーコード検出をどう行うかを決める純粋関数。
 *
 * - restrictToRoi が true かつ roi があるとき: 検出そのものを roi の範囲だけに
 *   切り出して行う（crop = roi）。切り出した canvas の中身は定義上すべて枠の内側
 *   なので、映像座標のROIフィルタを重ねて適用する必要はない
 *   （applyRoiFilter は false）。
 *   重要: 切り出し後の検出結果の box は「切り出したcanvas自身」の幅・高さを
 *   分母にした座標（＝クロップ座標）になり、映像座標とは分母が異なる。
 *   ここで映像座標のROIと比較する（filterHitsByRoiを呼ぶ）と、座標系の食い違いで
 *   正しいヒットまで静かに弾いてしまう。だからこそ crop を使う経路では
 *   filterHitsByRoi を絶対に呼んではならない（呼び出し側は applyRoiFilter を
 *   必ず確認すること）。
 * - それ以外（restrictToRoi が false、または roi がまだ無い）: 切り出さずフレーム
 *   全体を対象にする（crop = null）。この場合も「枠内のみ」機能自体がOFF
 *   （または枠が未確定）という理由で絞り込みをしないだけなので、
 *   applyRoiFilter は false のままでよい。
 */
export function resolveBarcodeCropPlan(
  restrictToRoi: boolean,
  roi: NormalizedRect | undefined,
): BarcodeCropPlan {
  if (restrictToRoi && roi) {
    return { crop: roi, applyRoiFilter: false }
  }
  return { crop: null, applyRoiFilter: false }
}
