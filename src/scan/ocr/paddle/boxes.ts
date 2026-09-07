// DBNet（検出モデル）の後処理: 確率マップ → 検出枠の一覧。canvas / ONNX の
// どちらにも依存しない純粋関数だけを置き、Node環境のVitestでテストできるようにする。
//
// 重要な設計判断（軸平行バウンディングボックスで妥協する理由）:
// 本家PaddleOCRのDB後処理は、確率マップを二値化して得た輪郭の「最小面積の
// 回転矩形」を検出枠として使う。傾いた文字列にも強い代わりに、凸包（convex hull）
// の計算と回転キャリパス法（rotating calipers）による最小外接矩形の探索が必要で、
// 実装量・バグの温床になりやすさの両面でコストが大きい。
//
// このアプリは「利用者がROI（関心領域）の枠を画面上で自分で調整し、その枠の中に
// 収まるようにラベルを水平に構えて撮る」という運用を前提にしている
// （src/scan/ocr/roi.ts のROI機構、preprocess.ts の前処理もすべてこの前提で
// 設計されている）。つまり実際に認識対象になるテキストは、ほぼ水平のまま
// 撮影される。この前提のもとでは、回転矩形を導入して得られる精度向上は小さい一方、
// 実装リスクは大きく割に合わない。そのため、ここでは連結成分の**軸平行**
// バウンディングボックスで妥協する。
//
// この判断のトレードオフ（引き継ぎ時に必ず共有すること）:
// 大きく傾いた文字列（本家なら回転矩形で正しく囲える）に対しては、軸平行の
// バウンディングボックスは実際の文字列より無駄に大きな矩形になり、認識精度が
// 落ちる可能性がある。現品票を斜めに撮ってしまった場合などがこれに当たる。

import type { AxisAlignedBox } from './geometry'
import { sortBoxesReadingOrder, unclipBox } from './geometry'

// ============================================================================
// 1. 二値化
// ============================================================================

// 確率マップをこの値以上で「文字あり」とみなす閾値。DB論文・本家PaddleOCRの
// 既定値と同じ0.3を出発点にする。実機で読み取れない／ノイズを拾いすぎる場合の
// 調整対象。
export const DEFAULT_BIN_THRESHOLD = 0.3

/**
 * 確率マップ（0..1の値が並んだ配列）を閾値で二値化する。
 * probMapが空・threshold未指定などでも例外を投げない。
 */
export function binarizeMask(probMap: ArrayLike<number>, threshold: number = DEFAULT_BIN_THRESHOLD): Uint8Array {
  const length = probMap ? probMap.length : 0
  const out = new Uint8Array(length)
  const safeThreshold = Number.isFinite(threshold) ? threshold : DEFAULT_BIN_THRESHOLD
  for (let i = 0; i < length; i++) {
    out[i] = probMap[i] >= safeThreshold ? 1 : 0
  }
  return out
}

// ============================================================================
// 2〜3. 連結成分のラベリング → 軸平行バウンディングボックス
// ============================================================================

export type ComponentBox = { minX: number; minY: number; maxX: number; maxY: number; pixelCount: number }

const NEIGHBORS_4: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]
const NEIGHBORS_8: readonly (readonly [number, number])[] = [
  ...NEIGHBORS_4,
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

/**
 * 二値配列（0/1、幅width・高さheightの画像として並んでいるもの）から連結成分を
 * 求め、成分ごとの軸平行バウンディングボックスを返す。
 *
 * BFS（幅優先探索）で1成分ずつ塗りつぶしていく方式。再帰を使うと大きな塊で
 * スタックオーバーフローしうるため、明示的なスタック配列を使う（実質DFSだが
 * 走査順は結果に影響しない）。
 *
 * connectivity: 4近傍 or 8近傍。既定は8（文字のストロークは斜めにもつながって
 * 見えることが多く、4近傍だと同じ文字が複数の成分に分断されやすいため）。
 *
 * binaryが空、width/heightが0以下、binaryの長さがwidth*heightに満たない、
 * といった退化した入力では空配列を返す（例外を投げない）。
 */
export function labelConnectedComponents(
  binary: ArrayLike<number>,
  width: number,
  height: number,
  connectivity: 4 | 8 = 8,
): ComponentBox[] {
  if (!binary || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return []
  const w = Math.floor(width)
  const h = Math.floor(height)
  if (binary.length < w * h) return []

  const visited = new Uint8Array(w * h)
  const stackX = new Int32Array(w * h)
  const stackY = new Int32Array(w * h)
  const neighbors = connectivity === 4 ? NEIGHBORS_4 : NEIGHBORS_8

  const boxes: ComponentBox[] = []

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const startIdx = y * w + x
      if (binary[startIdx] === 0 || visited[startIdx]) continue

      let sp = 0
      stackX[sp] = x
      stackY[sp] = y
      sp++
      visited[startIdx] = 1

      let minX = x
      let maxX = x
      let minY = y
      let maxY = y
      let count = 0

      while (sp > 0) {
        sp--
        const cx = stackX[sp]
        const cy = stackY[sp]
        count++
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy

        for (const [dx, dy] of neighbors) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
          const nIdx = ny * w + nx
          if (binary[nIdx] === 0 || visited[nIdx]) continue
          visited[nIdx] = 1
          stackX[sp] = nx
          stackY[sp] = ny
          sp++
        }
      }

      boxes.push({ minX, minY, maxX, maxY, pixelCount: count })
    }
  }

  return boxes
}

// ============================================================================
// 4〜7. 全体パイプライン（フィルタ・unclip・スコアリング・元画像スケールへの変換）
// ============================================================================

// 短辺がこの値未満の連結成分は、ノイズ（確率マップの微小な誤検出）とみなして除外する。
export const DEFAULT_MIN_SIDE_PX = 3

// 箱の内部の確率マップ平均値がこの値未満なら、確信度が低いとみなして除外する。
export const DEFAULT_BOX_THRESHOLD = 0.6

export type DetBox = AxisAlignedBox & { score: number }

export type DetPostprocessOptions = {
  binThreshold: number
  boxThreshold: number
  unclipRatio: number
  minSidePx: number
  connectivity: 4 | 8
}

export const DEFAULT_DET_POSTPROCESS_OPTIONS: DetPostprocessOptions = {
  binThreshold: DEFAULT_BIN_THRESHOLD,
  boxThreshold: DEFAULT_BOX_THRESHOLD,
  unclipRatio: 1.5,
  minSidePx: DEFAULT_MIN_SIDE_PX,
  connectivity: 8,
}

/** 箱（マップ座標系、整数境界 [x0,x1) x [y0,y1)）内の確率マップ平均値。 */
function averageProbInBox(probMap: ArrayLike<number>, mapWidth: number, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0
  let count = 0
  for (let y = y0; y < y1; y++) {
    const rowBase = y * mapWidth
    for (let x = x0; x < x1; x++) {
      sum += probMap[rowBase + x]
      count++
    }
  }
  return count > 0 ? sum / count : 0
}

/**
 * DBNet後処理の全体パイプライン。手順は本家PaddleOCR（DB後処理）と同じ順序で行う
 * （二値化 → 連結成分 → 軸平行バウンディングボックス → 小さい箱の除外 →
 * 「拡張前（tight）の箱」でのスコアリング・閾値フィルタ → 通過した箱だけをunclip →
 * 元画像座標への変換）。最後に読み順ソート（geometry.ts）まで行って返す。
 *
 * スコアリングを必ずunclipより前に行う理由は、下のループ内コメント（★印）に
 * 実測値つきで詳しく書いてある。一度この順序を逆にしたことで「boxThresholdの既定値
 * 0.6を数学的に絶対に満たせず、検出が常に0件になる」という致命的な不具合を
 * 起こしたことがあるため、同じ壊し方を二度と繰り返さないための記録として残している。
 *
 * probMap は検出モデル出力（[N,1,H,W] のNとチャンネル次元を除いた H*W の平坦配列）。
 * mapWidth・mapHeight はその H・W（＝検出用にリサイズした入力画像と同じ空間サイズ。
 * 実測により、このモデルの出力はダウンサンプリングされず入力と同じ解像度になる
 * ことを確認済みなので、ここでの座標はスケール補正なしでそのままマップ座標として
 * 扱ってよい）。
 *
 * scale は「マップ座標 × scale = 元画像座標」となる倍率（geometry.tsの
 * computeDetResizeが返すscaleX/scaleYをそのまま渡す想定）。
 *
 * probMapが不正（空・サイズ不足など）な場合は空配列を返す。
 */
export function postprocessDetection(
  probMap: ArrayLike<number>,
  mapWidth: number,
  mapHeight: number,
  scale: { scaleX: number; scaleY: number },
  options: Partial<DetPostprocessOptions> = {},
): DetBox[] {
  const opt: DetPostprocessOptions = { ...DEFAULT_DET_POSTPROCESS_OPTIONS, ...options }

  if (!probMap || !Number.isFinite(mapWidth) || !Number.isFinite(mapHeight) || mapWidth <= 0 || mapHeight <= 0) {
    return []
  }
  const w = Math.floor(mapWidth)
  const h = Math.floor(mapHeight)
  if (probMap.length < w * h) return []

  // 1. 二値化
  const binary = binarizeMask(probMap, opt.binThreshold)
  // 2〜3. 連結成分 → 軸平行バウンディングボックス
  const components = labelConnectedComponents(binary, w, h, opt.connectivity)

  const boxes: DetBox[] = []
  for (const comp of components) {
    const boxW = comp.maxX - comp.minX + 1
    const boxH = comp.maxY - comp.minY + 1

    // 4. 小さすぎる箱を除外
    if (Math.min(boxW, boxH) < opt.minSidePx) continue

    // 5. スコアリング・閾値フィルタ（★ここが本家との対応で最重要。必ずunclipより先に行う★）
    //
    // なぜ「unclipの前」でなければならないか（一度この順序を逆にして全滅を出した教訓）:
    // 本家PaddleOCR（DB後処理のbox_score_fast）は、確率マップを二値化して得た輪郭の
    // 「拡張前（tight）の内側」で確率平均を取り、box_threshと比較する。ここを通過した
    // 輪郭だけをunclipで外側へ広げる。この順序を逆にする（＝unclipした後の矩形で
    // スコアを取る）と、数学的にbox_threshを満たす箱が一切存在しなくなる。
    //
    // unclipBox は distance = 面積×unclipRatio / 周長 だけ各辺を外側に広げる
    // （geometry.ts参照）。unclipRatio=1.5のとき、拡張後の面積は元の面積のおよそ
    // 2.5〜3倍になる。したがって、たとえ元の箱の内部が確率1.0で完全に埋まっていても、
    // 拡張後の矩形全体で平均を取れば「元の面積 / 拡張後の面積」＝せいぜい0.33〜0.40
    // （正方形に近いほど0.33に近づき、極端に細長いほど0.40に漸近するが、それを超えることは
    // 原理的にあり得ない）にしかならない。ところが DEFAULT_BOX_THRESHOLD は 0.6。
    // つまり「unclip後にスコアを取る」実装は、画像に何が写っていようと絶対にこの閾値を
    // 満たせず、detectTextBoxes は常に空配列、recognizeWithPaddle は常に空文字を返し、
    // UIは毎回「文字を読み取れませんでした」になる（実測: 内部0.95・外部0.02の理想的な
    // 確率マップでも、240x26/120x20/400x40/60x16のいずれもunclip後スコアは0.34〜0.37に
    // 留まり、0.6を一度も超えなかった）。
    //
    // このバグが長く見過ごされた理由: 純粋関数のユニットテスト（boxes.test.ts）が
    // すべて boxThreshold を 0.2 まで明示的に下げて渡しており、しかも期待値そのものが
    // 「拡張後の面積で割った値」を正解としてハードコードしていたため、既定値（0.6）の
    // 経路が一度もテストされていなかった。テストが不具合を追認してしまっていた。
    // このため、tightスコアの回帰テストを別途 boxes.test.ts に追加してある（そちらの
    // コメントも参照）。
    const tightScore = averageProbInBox(probMap, w, comp.minX, comp.minY, comp.maxX + 1, comp.maxY + 1)
    if (tightScore < opt.boxThreshold) continue

    // 6. unclip（外側へ拡張）。ここに来るのは5を通過した箱だけ。
    const expanded = unclipBox({ x: comp.minX, y: comp.minY, w: boxW, h: boxH }, opt.unclipRatio)

    // マップの範囲外を参照しない・座標変換の両方のため、マップ境界にクランプする
    const x0 = Math.max(0, Math.floor(expanded.x))
    const y0 = Math.max(0, Math.floor(expanded.y))
    const x1 = Math.min(w, Math.ceil(expanded.x + expanded.w))
    const y1 = Math.min(h, Math.ceil(expanded.y + expanded.h))
    if (x1 <= x0 || y1 <= y0) continue

    // 7. 元画像座標へ変換。score には実際に判定へ使ったtightスコアをそのまま入れる
    // （unclip後の値を入れ直すと「何を根拠に採用したか」と表示される値が食い違うため）。
    boxes.push({
      x: x0 * scale.scaleX,
      y: y0 * scale.scaleY,
      w: (x1 - x0) * scale.scaleX,
      h: (y1 - y0) * scale.scaleY,
      score: tightScore,
    })
  }

  return sortBoxesReadingOrder(boxes)
}
