// バーコードの「縞」らしさを、画素の白黒反転回数から判定する純粋モジュール。
//
// 1次元バーコードの水平走査線は、バーとスペースが細かく交互に並ぶため白黒反転が
// 非常に多い。文字（OCR で読みたい部分）の走査線は反転が少なく、クワイエット
// ゾーン（余白）はほぼ反転しない。この差を使い、検出枠のうち「実際に縞が
// 密集している行の帯」だけを求める。canvas / ImageData には一切依存せず、
// 数値配列だけを扱う（テストが Node 環境の Vitest で完結するようにするため）。
//
// 重要: ここでの「行」「列」は常に、検出枠を切り出した小さな画像パッチの中の
// ローカルなインデックスであり、映像座標・表示座標のどちらでもない。
// パッチ座標 → 映像座標への変換は呼び出し側（preprocess.ts）の責務。

/**
 * 1本の走査線に沿った白黒の反転回数を数える。
 *
 * ヒステリシス（2つのしきい値: lowThreshold と highThreshold）を使うことで、
 * フラットな領域に乗るセンサーノイズの微小な上下動を反転として誤検出しない
 * ようにする。単一のしきい値だと、しきい値ちょうど付近で値が微妙に揺れる
 * だけで反転が乱発してしまう。
 *
 * アルゴリズム: 現在の状態（明るい/暗い）を保持する2状態の状態機械として扱う。
 * - 「明るい」状態のとき、値が lowThreshold 以下になったら「暗い」に遷移し、
 *   反転を1回カウントする。
 * - 「暗い」状態のとき、値が highThreshold 以上になったら「明るい」に遷移し、
 *   反転を1回カウントする。
 * - 2つのしきい値の間の値では状態を変えない（ここが不感帯＝ノイズ除去分）。
 *
 * しきい値は呼び出し側が走査線ごとの min/max などから決めて渡す想定
 * （例: 中央値 ± レンジの一定割合）。呼び出し側が何も工夫せず同じ値を
 * 2つとも渡した場合は、不感帯なしの単純な2値化と同じ挙動になる。
 *
 * 空配列・要素数1以下・しきい値の大小が逆（low > high）など、どんな入力でも
 * 例外を投げず、意味の通る値（多くは0）を返す。
 */
export function countTransitions(
  line: Uint8Array | Uint8ClampedArray,
  lowThreshold: number,
  highThreshold: number,
): number {
  if (!line || line.length < 2) return 0

  const a = Number.isFinite(lowThreshold) ? lowThreshold : 0
  const b = Number.isFinite(highThreshold) ? highThreshold : 0
  const low = Math.min(a, b)
  const high = Math.max(a, b)

  // 最初の状態は最初の値がどちら寄りかで決める（high 以上なら「明るい」扱い）
  let isBright = line[0] >= high
  let count = 0

  for (let i = 1; i < line.length; i++) {
    const value = line[i]
    if (isBright) {
      if (value <= low) {
        isBright = false
        count++
      }
    } else if (value >= high) {
      isBright = true
      count++
    }
  }

  return count
}

export type Band = { start: number; end: number }

// 帯の途中で反転回数が一時的に落ち込んでも（アンチエイリアスの掠れた1行など）、
// この行数までの途切れなら同じ帯とみなして分断しない。
const MAX_BAND_GAP = 2

/**
 * 行ごとの反転回数（countTransitions の結果を縦に並べたもの）から、
 * 「反転が密集している行の帯」を1つ見つける。
 *
 * 最大値に対する相対しきい値（既定 0.4 = 最大値の40%）以上の行を「密」とみなし、
 * 密な行が連続する区間（間に MAX_BAND_GAP 行以内の途切れがあっても続ける）のうち、
 * 最も長い区間を返す。見つからなければ null。
 *
 * counts が空、全行0、要素数1などの退化した入力でも例外を投げない。
 */
export function findDenseBand(counts: number[], relativeThreshold = 0.4): Band | null {
  if (!counts || counts.length === 0) return null

  let maxCount = 0
  for (const c of counts) {
    if (c > maxCount) maxCount = c
  }
  if (maxCount <= 0) return null

  const ratio = Number.isFinite(relativeThreshold) && relativeThreshold > 0 ? relativeThreshold : 0.4
  const threshold = maxCount * ratio

  let bestStart = -1
  let bestEnd = -1
  let bestLength = 0

  let curStart = -1
  let lastDenseIndex = -1

  for (let i = 0; i < counts.length; i++) {
    if (counts[i] >= threshold) {
      if (curStart === -1) {
        curStart = i
      } else if (i - lastDenseIndex - 1 > MAX_BAND_GAP) {
        // 途切れが大きすぎたので、ここまでの帯を候補として確定し、新しい帯を開始する
        const length = lastDenseIndex - curStart + 1
        if (length > bestLength) {
          bestLength = length
          bestStart = curStart
          bestEnd = lastDenseIndex
        }
        curStart = i
      }
      lastDenseIndex = i
    }
  }

  if (curStart !== -1) {
    const length = lastDenseIndex - curStart + 1
    if (length > bestLength) {
      bestLength = length
      bestStart = curStart
      bestEnd = lastDenseIndex
    }
  }

  if (bestStart === -1) return null
  return { start: bestStart, end: bestEnd }
}

// ============================================================================
// countRowTransitions（trimBarcodeBoxesToStripes を支える走査線ヘルパー）
// ============================================================================
//
// 以下は元々 preprocess.ts にあった「検出済みバーコード枠の内側だけを見て縦方向に
// 縮める」ロジック（trimOneBoxToStripeBand、上記参照）を下支えする countRowTransitions
// を切り出したもの。
//
// 以前はここに、ROI全体・縦横両方向に検索範囲を広げた detectStripeRegion（と
// それが使う countColTransitions・型 StripeRegion）もあった。これは
// trimBarcodeBoxesToStripes と違い「BarcodeDetector がデコードできた枠」に
// 依存せず、ROI の画素そのものから縞の密集領域を探す機能で、OCR前処理
// パイプラインの「縞マスク」オプション（削除済み）だけが呼び出していた。
// その呼び出し元が無くなり、自分自身のユニットテストからしか呼ばれない
// 状態になったため、利用者の判断で削除した（必要になれば git 履歴から
// 復元できる）。

// 走査線ごとのヒステリシスしきい値を、その行/列自身の輝度レンジから求めるための係数。
// 中央値 ±（レンジの10%）を「不感帯」とする。値が大きいほどノイズに強くなる代わりに、
// コントラストの低いかすれたバーを見逃しやすくなる。
const HYSTERESIS_BAND_RATIO = 0.1

/** crop 内の輝度（luma）を返す小さなヘルパー。RGBA の1画素分のオフセットを渡す。 */
export function luma(data: Uint8ClampedArray, offset: number): number {
  return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2]
}

/**
 * 1行分の輝度（luma）を取り出し、その場でヒステリシス反転回数を数える。
 * 行ごとに min/max からしきい値を作り直すのは、ROI 内の明るさムラ（影・照明）に
 * 左右されず、どの行でも「その行なりのコントラスト」で判定するため。
 *
 * rowLuma は呼び出し側が使い回す作業用バッファ（幅 w 以上）。ホットパスで
 * 行ごとに新しい配列を確保しないための最適化。
 */
export function countRowTransitions(data: Uint8ClampedArray, rowOffsetPx: number, w: number, rowLuma: Uint8ClampedArray): number {
  let min = 255
  let max = 0
  for (let x = 0; x < w; x++) {
    const o = (rowOffsetPx + x) * 4
    const v = luma(data, o)
    rowLuma[x] = v
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = max - min
  // 行が完全にフラット（min === max）な場合、mid ± span*係数 は low === high === mid に
  // 潰れる。この状態で countTransitions に渡すと、境界条件（<= low と >= high）が
  // 同じ値でともに真になり、同じ値が並んでいるだけなのに1画素ごとに「明→暗→明→…」と
  // 誤って反転しまくる（本来ゼロであるべき反転回数が要素数近くまで跳ね上がる）。
  // フラットな行に反転は存在しないので、ここで先に0を返して回避する。
  if (span <= 0) return 0
  const mid = (min + max) / 2
  const low = mid - span * HYSTERESIS_BAND_RATIO
  const high = mid + span * HYSTERESIS_BAND_RATIO
  return countTransitions(rowLuma, low, high)
}

