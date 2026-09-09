// バーコード自動除外（結果カードの「バーコードを自動で除外」トグル）のための、
// 検出済みバーコード枠を実ピクセルの縞の帯まで縦方向に縮めるモジュール。
//
// 以前はここに、OCR に渡す画像そのものを作る前処理パイプライン
// （罫線除去・ROI全体の縞マスク・コントラスト正規化・グレースケール化・
// 文字行の高さ基準での拡大縮小）が一式あった。これは tesseract.js の LSTM
// エンジンに合わせて調整したもので、その後 ML Kit へ移った時点で既に
// 「ML Kitには前処理を通していない素の画像を渡すのが既定」という状態になっており、
// 最終的に PaddleOCR 一本に絞った現在も PaddleOCR には常に素の画像を渡している
// （PaddleOCR 自身の前処理は src/scan/ocr/paddle/preprocess.ts が別に持つ）。
// つまりこのファイルの前処理パイプラインは実質使われておらず、比較モード
// （旧 OcrCompareSheet.tsx、削除済み）の比較材料としてのみ存在していたため、
// 利用者の判断で丸ごと削除した（README「OCR まわりの修正履歴」参照）。
// 罫線除去そのもの（lines.ts）も同時に削除している。
//
// 残っているのは、バーコード自動除外（現役の機能）が使う trimBarcodeBoxesToStripes
// だけである。これは「OCR に渡す画像を加工する」処理ではなく「どこを塗りつぶすか
// （検出済みバーコード枠）を実ピクセルで絞り込む」処理なので、前処理パイプラインの
// 削除とは独立に残す。

import type { NormalizedRect } from '../barcode/types'
import { normalizedRectToPixels } from './mask'
import { countRowTransitions, findDenseBand } from './stripes'

function getContext2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    throw new Error('2D context is not available')
  }
  return ctx
}

/**
 * 検出済みバーコード枠（映像座標、0..1）を、実際に縞（バー）が密集している行の帯まで
 * 縦方向にのみ縮める。バーコードのバーは水平走査線上で白黒反転が非常に多く、
 * 隣接する文字やクワイエットゾーンはずっと少ないため、この差で「バーがある行」だけを
 * 残す（stripes.ts の countTransitions / findDenseBand を参照）。
 *
 * - 縮めるだけで、絶対に広げない。findDenseBand が帯を見つけられなければ、
 *   渡された枠をそのまま（マージンなしの検出枠のまま）返す。
 * - 横方向にはトリムしない: 1次元バーコードの垂直走査線（1本のバーの内側）は
 *   ほぼ反転が起きないため、この「反転回数」という尺度は列方向には使えない。
 *   また検出枠が横方向にはみ出すことは実務上ほとんどないため、
 *   縦方向のみのトリムで十分。ここを列方向にも拡張しようとしないこと。
 * - 2次元シンボル（QR・DataMatrix）は上から下までどの行を切っても密なパターンが
 *   出るため、帯は枠の全高を占め、結果として何もトリムされない。これは意図した
 *   挙動（誤って中身を切り欠かない）である。
 *
 * frame は「シャッター押下時に確定させた静止フレーム」そのもの（captureFrame の
 * 戻り値）を渡すこと。ここでは frame から getImageData するだけで、新たにカメラの
 * フレームを読み直したりはしない。
 */
export function trimBarcodeBoxesToStripes(frame: OffscreenCanvas, boxes: NormalizedRect[]): NormalizedRect[] {
  if (boxes.length === 0) return boxes

  let ctx: OffscreenCanvasRenderingContext2D
  try {
    ctx = getContext2d(frame)
  } catch {
    return boxes
  }

  return boxes.map((box) => trimOneBoxToStripeBand(ctx, frame.width, frame.height, box))
}

function trimOneBoxToStripeBand(
  ctx: OffscreenCanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  box: NormalizedRect,
): NormalizedRect {
  const px = normalizedRectToPixels(box, frameWidth, frameHeight)
  if (px.w <= 0 || px.h <= 0) return box

  let data: Uint8ClampedArray
  try {
    // 検出枠の分だけを読む（フレーム全体は読まない = 高速）
    data = ctx.getImageData(px.x, px.y, px.w, px.h).data
  } catch {
    return box
  }

  const rowLuma = new Uint8ClampedArray(px.w)
  const counts: number[] = new Array(px.h)
  for (let y = 0; y < px.h; y++) {
    counts[y] = countRowTransitions(data, y * px.w, px.w, rowLuma)
  }

  const band = findDenseBand(counts)
  if (!band) return box // 密な帯が見つからない場合は縮めず、検出枠のまま返す

  // 帯（パッチ内のローカルな行インデックス）を映像座標（フレーム全体に対する 0..1）へ戻す。
  // x・w は変更しない（横方向はトリムしない）。
  const trimmedTopPx = px.y + band.start
  const trimmedHeightPx = band.end - band.start + 1
  return {
    x: box.x,
    w: box.w,
    y: trimmedTopPx / frameHeight,
    h: trimmedHeightPx / frameHeight,
  }
}
