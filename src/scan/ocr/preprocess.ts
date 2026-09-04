// OCR 前処理: 映像から関心領域 (ROI) を切り出し、グレースケール化・
// コントラスト正規化・文字行の高さ基準でのスケーリングを行う。
// 外部ライブラリに依存しない純粋な canvas 処理。
//
// 以前はここでヒストグラムから大津の手法によるしきい値を求めて二値化していたが、
// Tesseract は内部で自前の適応的二値化を行うため、事前にハード二値化した画像より
// 素のグレースケール画像の方が概して認識精度が良い。ROI 帯にバーコードのバーが
// 写り込むと、大津の二値化はそれを大きな黒い塊にしてしまい、むしろ有害だった。
// そのため二値化は行わず、グレースケール化とスケーリングのみを行う。
// コントラスト正規化（normalizeContrast、下記）を追加したのも同じ方針の範囲内で、
// あくまで輝度の線形変換に留めており、しきい値判定で白黒二択に振り分ける
// 二値化とは別物である。

import type { NormalizedRect } from '../barcode/types'
import { normalizedRectToPixels } from './mask'
import { countTransitions, findDenseBand } from './stripes'
import type { RoiRect } from './types'

// ROI の切り出し元。ライブの <video> だけでなく、シャッター押下時に captureFrame() で
// 撮った静止フレーム（OffscreenCanvas）からも同じロジックで切り出せるようにする。
export type FrameSource = HTMLVideoElement | OffscreenCanvas

function frameSize(source: FrameSource): { width: number; height: number } {
  if (source instanceof OffscreenCanvas) {
    return { width: source.width, height: source.height }
  }
  return { width: source.videoWidth, height: source.videoHeight }
}

// OCR に渡す画像の出力画素数の上限。Tesseract は画像が大きいほど時間がかかるため、
// 「文字が判別できる最小限の解像度」に抑えることでレスポンスを大幅に改善する。
//
// 以前は 300,000 だったが、下記の「行の高さ基準」でスケールを決める方式に変えたところ、
// 実機の高解像度カメラ（12MP級）で撮った横長の ROI では、行の高さを満たすだけの
// スケールでも出力の総画素数（幅 × 高さ）がこの値をすぐに超えてしまい、必要以上に
// 縮小されて逆行してしまうことが分かった。Tesseract 1回の認識にかかる時間は
// 手元の検証で数百ms〜1秒程度の幅があり、1,200,000px（例: 1200×1000相当）程度までは
// 実用上許容できる遅さに収まる一方、行の高さ基準で決めた妥当なスケールを
// 極端に狭めてしまわない値として引き上げた。
export const OCR_PIXEL_BUDGET = 1_200_000

// 出力画像の目標の高さ（px）。
//
// Tesseract の LSTM エンジンは、テキスト行の高さがおよそ 30〜40px 程度のときに
// もっとも認識精度が高いとされる（本アプリの既定 PSM である「単一行」を前提とした
// 一般的な目安）。ROI はユーザーが「文字を囲むように」枠を調整して使う運用のため、
// ROI の高さは概ね「文字行の高さ＋上下のわずかな余白」とみなせる。
//
// 96px という値の根拠（1行だけの ROI と、数行分の ROI の両方を想定して決めている）:
// - ROI が1行ぴったりの文字を囲んでいる場合、96px までスケールすると文字本体の
//   高さは余白を差し引いてもおよそ70〜90px程度になる。最適レンジ（30〜40px）より
//   大きいが、小さすぎて潰れるより大きすぎる方が安全側に振れるため許容する。
// - ROI が数行分（2〜3行）の文字をまとめて囲んでいる場合、96px を行数で割ると
//   1行あたりおよそ30〜48pxになり、最適レンジにちょうど収まる。
// つまり「1行だけを囲む」使い方と「数行まとめて囲む」使い方のどちらでも大きく
// 外れない妥協点として 96px を選んでいる。
export const TARGET_ROI_HEIGHT_PX = 96

// 上限4倍: 高さ24px未満のごく小さいROI（バーコードの至近距離撮影など）を
// 96pxまで引き伸ばそうとすると4倍を超えることがあるが、拡大率をこれ以上
// 増やしても新しい情報が生まれるわけではなく、単に処理時間とメモリを
// 浪費するだけなので頭打ちにする。
const MAX_HEIGHT_SCALE = 4

// 下限0.2: 巨大なROI（実機の高解像度カメラ等）でTARGET_ROI_HEIGHT_PXに
// 合わせようとする倍率がどれだけ小さくなっても、5分の1未満まで縮小すると
// 文字のストロークが数画素まで潰れて情報そのものが失われてしまうため、
// これより下には落とさない（この下限を維持したまま画素数予算をオーバーする
// 場合は、後段の画素数予算チェックがこの下限を無視してでも追加で縮小する。
// 「予算を守る」ことを最優先にするための意図的な仕様）。
const MIN_HEIGHT_SCALE = 0.2

// ROI の実サイズ（sw × sh）から、拡大縮小のスケール係数を求める純粋関数。
//
// 以前は「入力ROIの画素数（sw×sh）だけ」からスケールを決めており、実際の文字の
// 大きさを一切見ていなかった。この方式には致命的な欠陥があった: 同じ物理的な
// 大きさの文字を撮っていても、カメラの解像度が高いほど ROI の画素数（sw×sh）は
// 大きくなるため、高解像度カメラ（実機のAPK版、既定は quality.ts の 'max' =
// 3840x2160 ideal）ほど強く縮小され、逆に低解像度カメラ（PCブラウザのWeb版検証、
// 720p程度）ほど強く拡大されるという、実際の文字サイズとは正反対の結果になって
// いた。「PCでは2倍に拡大され精度が良く見えるのに、実機では0.6倍に縮小され
// 精度が落ちて見える」という体感の主因はこれだった。
//
// これを解消するため、まず ROI の「高さ」から倍率を決める（下記 第1段階）。
// ROI の高さは撮影解像度に関わらず「文字行の高さ＋余白」を表しているため、
// 高さ基準でスケールを決めれば、同じ大きさの文字は入力解像度に関係なく
// 常にほぼ同じ出力サイズ・同じ倍率になる。そのうえで、処理時間を守るための
// 画素数予算チェックを第2段階として別に行う（第1段階のクランプ範囲を
// 無視してでも予算内に収める。「予算がクランプに破られて機能しなくなる」
// という以前の不整合を無くすため、意図的に2段構えにしている）。
//
// - sw・sh が 0 以下や NaN であっても、有限の正の値を返し、絶対に例外を投げない
export function computeOcrScale(sw: number, sh: number): number {
  const safeW = Number.isFinite(sw) && sw > 0 ? sw : 1
  const safeH = Number.isFinite(sh) && sh > 0 ? sh : 1

  // 第1段階: 出力の「高さ」が TARGET_ROI_HEIGHT_PX に近づく倍率を第一候補にする。
  let scale = TARGET_ROI_HEIGHT_PX / safeH
  scale = Math.min(MAX_HEIGHT_SCALE, Math.max(MIN_HEIGHT_SCALE, scale))

  // 第2段階: 上記の倍率で出力した場合の画素数が予算を超える場合だけ、
  // 予算にちょうど収まるところまでスケールを下げる（第1段階の下限は無視する）。
  const sourcePixels = safeW * safeH
  const outputPixels = sourcePixels * scale * scale
  if (outputPixels > OCR_PIXEL_BUDGET) {
    // sourcePixels * scale^2 = OCR_PIXEL_BUDGET を満たす scale まで落とす
    scale = Math.sqrt(OCR_PIXEL_BUDGET / sourcePixels)
  }

  if (!Number.isFinite(scale) || scale <= 0) {
    // safeW/safeH が常に 1 以上のため実際にはここに到達しない想定だが、
    // 万一の計算不能ケースに備えた最終防波堤（等倍＝無変換）
    scale = 1
  }

  return scale
}

function getContext2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    throw new Error('2D context is not available')
  }
  return ctx
}

// scale >= 1: 双線形補間（bilinear）で拡大する（グレースケールのまま。二値化はしない）。
//
// 以前はニアレストネイバー（最も近い1画素の値をそのまま使う）で拡大していたが、
// これは文字のエッジをブロック状のジャギーにしてしまい、LSTM ベースの Tesseract
// にとってストロークの向きや太さを読み取りにくくする方向に働く。双線形補間は
// 周囲4画素を距離に応じた重みで混ぜ合わせるため、エッジがなめらかになり、
// 特に本アプリのように倍率が2〜4倍と大きくなりがちな構成では効果が大きい。
// 縮小側（resampleDownscale）は逆にボックスフィルタ（平均化）のままにしている。
// 縮小はエイリアシング対策として「複数の元画素を平均する」ことが本質的に重要で、
// 双線形補間のような「周囲数画素だけを見る」方式では間引かれる画素の情報が
// 平均に反映されず、縮小には不向きなため、拡大と縮小で意図的に別のアルゴリズムを
// 使い分けている。
function resampleUpscale(gray: Uint8ClampedArray, sw: number, sh: number, scale: number): ImageData {
  const outW = Math.max(1, Math.round(sw * scale))
  const outH = Math.max(1, Math.round(sh * scale))
  const out = new ImageData(outW, outH)
  const outData = out.data

  // 出力画素の中心が入力画像のどの座標に対応するかを、両端の画素中心が
  // ぴったり揃うように計算する（"half pixel center" 方式）。sw/sh が1の場合は
  // 0除算を避けるためスケールをそのまま使う。
  const scaleX = outW > 1 ? (sw - 1) / (outW - 1) : 0
  const scaleY = outH > 1 ? (sh - 1) / (outH - 1) : 0

  for (let y = 0; y < outH; y++) {
    const srcYf = outH > 1 ? y * scaleY : 0
    const srcY0 = Math.min(sh - 1, Math.floor(srcYf))
    const srcY1 = Math.min(sh - 1, srcY0 + 1)
    const wy = srcYf - srcY0

    for (let x = 0; x < outW; x++) {
      const srcXf = outW > 1 ? x * scaleX : 0
      const srcX0 = Math.min(sw - 1, Math.floor(srcXf))
      const srcX1 = Math.min(sw - 1, srcX0 + 1)
      const wx = srcXf - srcX0

      // 周囲4画素（左上・右上・左下・右下）を距離の重みで線形補間する
      const topLeft = gray[srcY0 * sw + srcX0]
      const topRight = gray[srcY0 * sw + srcX1]
      const bottomLeft = gray[srcY1 * sw + srcX0]
      const bottomRight = gray[srcY1 * sw + srcX1]
      const top = topLeft + (topRight - topLeft) * wx
      const bottom = bottomLeft + (bottomRight - bottomLeft) * wx
      const value = Math.round(top + (bottom - top) * wy)

      const o = (y * outW + x) * 4
      outData[o] = value
      outData[o + 1] = value
      outData[o + 2] = value
      outData[o + 3] = 255
    }
  }

  return out
}

// scale < 1: ニアレストネイバーはエイリアシング（文字のかすれ・欠け）が目立つため、
// 出力1画素あたりの元画素を平均するボックスフィルタで縮小する（グレースケールのまま）。
function resampleDownscale(gray: Uint8ClampedArray, sw: number, sh: number, scale: number): ImageData {
  const outW = Math.max(1, Math.round(sw * scale))
  const outH = Math.max(1, Math.round(sh * scale))
  const out = new ImageData(outW, outH)
  const outData = out.data

  for (let y = 0; y < outH; y++) {
    const srcY0 = Math.floor((y * sh) / outH)
    const srcY1 = Math.max(srcY0 + 1, Math.floor(((y + 1) * sh) / outH))
    for (let x = 0; x < outW; x++) {
      const srcX0 = Math.floor((x * sw) / outW)
      const srcX1 = Math.max(srcX0 + 1, Math.floor(((x + 1) * sw) / outW))

      let sum = 0
      let count = 0
      for (let sy = srcY0; sy < srcY1 && sy < sh; sy++) {
        const rowOffset = sy * sw
        for (let sx = srcX0; sx < srcX1 && sx < sw; sx++) {
          sum += gray[rowOffset + sx]
          count++
        }
      }
      const value = count > 0 ? Math.round(sum / count) : 0
      const o = (y * outW + x) * 4
      outData[o] = value
      outData[o + 1] = value
      outData[o + 2] = value
      outData[o + 3] = 255
    }
  }

  return out
}

// パーセンタイルによるコントラストストレッチ（ヒストグラム正規化）に使う下位/上位の割合。
// 2%ずつ切り捨てることで、ごく少数の極端に明るい/暗い外れ値（照明の反射・影の一角など）
// にレンジ全体が引っ張られてしまうのを防ぐ。
const CONTRAST_STRETCH_PERCENTILE = 0.02

// 下位/上位パーセンタイルの輝度差（レンジ）がこの値未満（＝ほぼ単色）の場合は
// ストレッチを行わない。ROI がほぼ均一な明るさしか持たない場合（無地の背景だけを
// 囲んでしまった、あるいは階調差がノイズしかない場合）、狭いレンジを 0..255 いっぱいに
// 引き伸ばすと、文字と背景の差ではなくノイズだけが何倍にも増幅されてしまい、
// かえって認識を悪化させるため。256階調のうち16という値は、量子化ノイズや
// センサーノイズによる数階調程度のゆらぎでは発火せず、実際に文字が写っている
// 場合に生じる輝度差（数十階調以上が普通）でだけ発火するように選んだ経験的な閾値。
const CONTRAST_STRETCH_MIN_RANGE = 16

/**
 * グレースケール画像に対して、パーセンタイルベースの線形コントラストストレッチ
 * （contrast stretching / percentile normalization）を行う純粋関数。
 *
 * 「二値化はしない」という本ファイル冒頭の方針とは矛盾しない。ここで行うのは
 * あくまで元の輝度の大小関係を保ったままの線形変換
 * （v' = (v - lo) / (hi - lo) * 255）であり、しきい値で白か黒かの二択に
 * 振り分ける処理（＝二値化）ではない。倉庫・工場フロアの照明ムラでコントラストが
 * 低くなりがちな ROI（全体が薄暗いグレーに寄っている等）でも、文字と背景の
 * 輝度差を Tesseract の内部処理が拾いやすい範囲まで引き伸ばす狙い。
 *
 * 入力配列は書き換えず、新しい配列を返す（他のヘルパーと同様の純粋関数にする）。
 * レンジが狭すぎる場合は CONTRAST_STRETCH_MIN_RANGE のコメントの通りストレッチを
 * 行わず、入力をそのまま返す。
 */
export function normalizeContrast(gray: Uint8ClampedArray): Uint8ClampedArray {
  const n = gray.length
  if (n === 0) return gray

  const histogram = new Uint32Array(256)
  for (let i = 0; i < n; i++) histogram[gray[i]]++

  // 下位側: 累積度数が「全画素数 × パーセンタイル」を超えた最初の階調を lo とする
  const loBudget = Math.floor(n * CONTRAST_STRETCH_PERCENTILE)
  let lo = 0
  let accLo = 0
  for (; lo < 255; lo++) {
    accLo += histogram[lo]
    if (accLo > loBudget) break
  }

  // 上位側: 同様に、明るい方から累積して超えた最初の階調を hi とする
  const hiBudget = Math.floor(n * CONTRAST_STRETCH_PERCENTILE)
  let hi = 255
  let accHi = 0
  for (; hi > 0; hi--) {
    accHi += histogram[hi]
    if (accHi > hiBudget) break
  }

  if (hi - lo < CONTRAST_STRETCH_MIN_RANGE) {
    return gray
  }

  const range = hi - lo
  const out = new Uint8ClampedArray(n)
  for (let i = 0; i < n; i++) {
    // Uint8ClampedArray への代入時に 0..255 の範囲外は自動的にクランプされるため、
    // lo 未満・hi 超過の値についてここで個別にクランプする必要はない。
    out[i] = Math.round(((gray[i] - lo) / range) * 255)
  }
  return out
}

// crop 内の輝度（luma）を返す（マスクの塗りつぶし色をサンプリングするための小さなヘルパー）
function luma(data: Uint8ClampedArray, offset: number): number {
  return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2]
}

// ROI 切り出し画像の外周（=ラベルの地の色である可能性が高い部分）をサンプリングして、
// バーコード枠を塗りつぶすためのグレー値を求める。純粋な黒・白で塗ると Tesseract に
// とって不自然に強いエッジになりかねないため、周囲に馴染む中間的な明るさを使う。
// 大きな crop でも計算量が増えすぎないよう、辺に沿って一定間隔で間引いてサンプルする。
function sampleFillGray(data: Uint8ClampedArray, w: number, h: number): number {
  if (w <= 0 || h <= 0) return 128
  let sum = 0
  let count = 0
  const step = Math.max(1, Math.floor(Math.min(w, h) / 32))
  for (let x = 0; x < w; x += step) {
    sum += luma(data, (x) * 4)
    sum += luma(data, ((h - 1) * w + x) * 4)
    count += 2
  }
  for (let y = 0; y < h; y += step) {
    sum += luma(data, (y * w) * 4)
    sum += luma(data, (y * w + (w - 1)) * 4)
    count += 2
  }
  return count > 0 ? Math.round(sum / count) : 128
}

// maskRects（映像座標、フレーム全体に対する 0..1）を、ROI crop（frameWidth×frameHeight の
// フレームから (cropX, cropY) を起点に cropW×cropH だけ切り出したもの）のローカル
// ピクセル座標に変換して、周囲の色で塗りつぶす。
//
// 「映像座標→フレーム全体のピクセル座標」への変換は必ず frameWidth/frameHeight
// （crop 前のフレーム全体のサイズ）を使って行い、その後で crop の原点を引く。
// crop 後のサイズ（sw/sh）を使って正規化してしまうと、ROI 以外の場所にある
// バーコードの割合まで ROI 内の割合として扱うことになり、表示座標と映像座標を
// 混同するのと同種の事故（枠のずれ）につながるため、ここは特に注意する。
function applyMaskFill(
  data: Uint8ClampedArray,
  sw: number,
  sh: number,
  maskRects: NormalizedRect[],
  frameWidth: number,
  frameHeight: number,
  cropX: number,
  cropY: number,
): void {
  const fill = sampleFillGray(data, sw, sh)
  for (const rect of maskRects) {
    const framePx = normalizedRectToPixels(rect, frameWidth, frameHeight)
    const x0 = Math.max(0, framePx.x - cropX)
    const y0 = Math.max(0, framePx.y - cropY)
    const x1 = Math.min(sw, framePx.x + framePx.w - cropX)
    const y1 = Math.min(sh, framePx.y + framePx.h - cropY)
    if (x1 <= x0 || y1 <= y0) continue // ROI と交差しない枠は何もしない

    for (let y = y0; y < y1; y++) {
      const rowOffset = (y * sw) * 4
      for (let x = x0; x < x1; x++) {
        const o = rowOffset + x * 4
        data[o] = fill
        data[o + 1] = fill
        data[o + 2] = fill
        // アルファはそのまま（常に不透明で描画しているため 255 のまま）
      }
    }
  }
}

// 走査線ごとのヒステリシスしきい値を、その行自身の輝度レンジから求めるための係数。
// 中央値 ±（レンジの10%）を「不感帯」とする。値が大きいほどノイズに強くなる代わりに、
// コントラストの低いかすれたバーを見逃しやすくなる。
const HYSTERESIS_BAND_RATIO = 0.1

// 1行分の輝度（luma）を取り出し、その場でヒステリシス反転回数を数える。
// 行ごとに min/max からしきい値を作り直すのは、ROI 内の明るさムラ（影・照明）に
// 左右されず、どの行でも「その行なりのコントラスト」で判定するため。
function countRowTransitions(data: Uint8ClampedArray, rowOffsetPx: number, w: number, rowLuma: Uint8ClampedArray): number {
  let min = 255
  let max = 0
  for (let x = 0; x < w; x++) {
    const o = (rowOffsetPx + x) * 4
    const v = luma(data, o)
    rowLuma[x] = v
    if (v < min) min = v
    if (v > max) max = v
  }
  const mid = (min + max) / 2
  const span = max - min
  const low = mid - span * HYSTERESIS_BAND_RATIO
  const high = mid + span * HYSTERESIS_BAND_RATIO
  return countTransitions(rowLuma, low, high)
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

/**
 * ROI（映像座標、0..1）を source から切り出し、グレースケール化・スケーリングまで行う。
 *
 * maskRects を渡すと、切り出し前にそれらの矩形（映像座標、フレーム全体に対する割合）を
 * 周囲の色で塗りつぶしてからグレースケール化する。バーコードのストライプが ROI に
 * 写り込んで OCR の邪魔になるのを防ぐための仕組み（呼び出し側は mask.ts の
 * boxesToMask で ROI と重なる検出済みバーコード枠だけに絞り込んでから渡す）。
 */
export function preprocessRoi(source: FrameSource, roi: RoiRect, maskRects?: NormalizedRect[]): ImageData {
  const { width: frameWidth, height: frameHeight } = frameSize(source)

  const sx = Math.max(0, Math.round(roi.x * frameWidth))
  const sy = Math.max(0, Math.round(roi.y * frameHeight))
  const sw = Math.max(1, Math.min(frameWidth - sx, Math.round(roi.w * frameWidth)))
  const sh = Math.max(1, Math.min(frameHeight - sy, Math.round(roi.h * frameHeight)))

  const cropCanvas = new OffscreenCanvas(sw, sh)
  const cropCtx = getContext2d(cropCanvas)
  cropCtx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)
  const { data } = cropCtx.getImageData(0, 0, sw, sh)

  if (maskRects && maskRects.length > 0) {
    applyMaskFill(data, sw, sh, maskRects, frameWidth, frameHeight, sx, sy)
  }

  // グレースケール化（輝度＝ luma）。二値化はしない。
  const pixelCount = sw * sh
  const gray = new Uint8ClampedArray(pixelCount)
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4
    gray[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2])
  }

  // コントラスト正規化はグレースケール化の後・スケーリングの前に行う。
  // スケーリング後（特に拡大の双線形補間後）に行うと、補間によってなまった
  // エッジの輝度差がストレッチの対象になってしまい、ROI 本来のコントラストを
  // 正しく評価できなくなるため、必ず元の解像度のグレースケール画像に対して行う。
  const normalized = normalizeContrast(gray)

  const scale = computeOcrScale(sw, sh)

  return scale >= 1
    ? resampleUpscale(normalized, sw, sh, scale)
    : resampleDownscale(normalized, sw, sh, scale)
}
