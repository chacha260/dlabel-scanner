// CTC (Connectionist Temporal Classification) の greedy デコード。canvas / ONNX の
// どちらにも依存しない純粋関数だけを置き、Node環境のVitestでテストできるようにする。
//
// PP-OCRv5 認識モデルの出力は [N, T, C]（T=タイムステップ数、C=クラス数=18385）。
// C の内訳は、実物のONNXを確認したうえでコーディネーターが onnxruntime-node で
// 実測して確定させたとおり:
//   index 0            = blank（CTCの空白トークン。「ここでは何も出力しない」を表す）
//   index 1..18383     = 辞書ファイル（ppocrv5_dict.txt）の 1..18383 行目
//   index 18384        = 半角スペース
// （1(blank) + 18383(辞書) + 1(space) = 18385 が実測のクラス数と一致）

// モデル出力をそのまま確率として扱う方針にした理由:
// 本家 PaddleOCR の CTCLabelDecode（rec の後処理）は、モデル出力に対して
// softmax を再適用せず、そのまま argmax / max値を確率として使っている。
// これは PP-OCR の認識ヘッド（CTCHead）が推論エクスポート時点で既に
// softmax込みのグラフになっているため。コーディネーターが実機で検証した
// 「一様なグレー画像を入力したとき t0 の argmax は index 0(blank) で確率0.77」
// という値も、生の logits にしては小さすぎず、確率として妥当な値であり、
// この前提を裏付けている。そのためここでも同じ方針（softmaxの再適用をしない）
// を採用する。もし将来、実機で「モデル出力の総和が1に近くない」ことが
// 判明した場合は、argmaxPerTimestep の前段に softmax を挟む必要がある。

/** CTC の空白（blank）トークンのクラスインデックス。常に0。 */
export const CTC_BLANK_INDEX = 0

/**
 * 認識モデルの生出力（[T, C] を平坦化した配列）から、タイムステップごとの
 * argmax クラスインデックスと、その確率値を取り出す。
 *
 * data.length が timeSteps*numClasses に満たない、timeSteps/numClasses が
 * 0以下など、どんな入力でも例外を投げない（該当タイムステップは
 * インデックス0・確率0として扱う）。
 */
export function argmaxPerTimestep(
  data: ArrayLike<number>,
  timeSteps: number,
  numClasses: number,
): { indices: Int32Array; probs: Float32Array } {
  const safeSteps = Number.isFinite(timeSteps) && timeSteps > 0 ? Math.floor(timeSteps) : 0
  const safeClasses = Number.isFinite(numClasses) && numClasses > 0 ? Math.floor(numClasses) : 0

  const indices = new Int32Array(safeSteps)
  const probs = new Float32Array(safeSteps)

  if (!data || safeClasses === 0) return { indices, probs }

  for (let t = 0; t < safeSteps; t++) {
    let bestIdx = 0
    let bestVal = -Infinity
    const base = t * safeClasses
    for (let c = 0; c < safeClasses; c++) {
      const v = data[base + c]
      if (v > bestVal) {
        bestVal = v
        bestIdx = c
      }
    }
    indices[t] = bestIdx
    probs[t] = bestVal === -Infinity ? 0 : bestVal
  }

  return { indices, probs }
}

/**
 * CTC クラスインデックス → 文字への変換。blank・範囲外のインデックスは null。
 * dict は parsePaddleDict() の戻り値（1..18383行目に相当する配列。0起点で
 * dict[0] が「辞書の1行目」）を想定している。
 */
export function classIndexToChar(index: number, dict: readonly string[]): string | null {
  if (index === CTC_BLANK_INDEX) return null
  const spaceIndex = dict.length + 1
  if (index === spaceIndex) return ' '
  const dictIndex = index - 1
  if (dictIndex < 0 || dictIndex >= dict.length) return null
  return dict[dictIndex]
}

export type CtcDecodeResult = { text: string; confidence: number }

/**
 * CTC greedy デコード。本家 PaddleOCR の CTCLabelDecode.decode と同じアルゴリズム:
 *   1. 1つ前のタイムステップと同じインデックスが連続する区間は、先頭の1回だけを採用する
 *      （＝「連続する同一インデックスを1つに畳む」）
 *   2. blank(0) は採用しない（文字を出力しない）
 *   3. 採用したインデックスを辞書で文字に変換して連結する
 *
 * confidence は「採用したタイムステップの確率の平均 × 100」（0..100）。
 * 1文字も採用できなかった場合（空文字認識）は 0 を返す。
 *
 * indices と probs の長さが食い違う、どちらかが空、といった入力でも例外を投げない
 * （probs 側が足りない場合は確率0として扱う）。
 */
export function ctcGreedyDecode(
  indices: ArrayLike<number>,
  probs: ArrayLike<number>,
  dict: readonly string[],
): CtcDecodeResult {
  const chars: string[] = []
  const confidences: number[] = []
  let prevIndex = -1

  const length = indices ? indices.length : 0
  for (let t = 0; t < length; t++) {
    const idx = indices[t]
    if (idx !== prevIndex) {
      const ch = classIndexToChar(idx, dict)
      if (ch !== null) {
        chars.push(ch)
        const p = probs && t < probs.length ? probs[t] : 0
        confidences.push(Number.isFinite(p) ? p : 0)
      }
    }
    prevIndex = idx
  }

  const confidence =
    confidences.length > 0 ? (confidences.reduce((sum, v) => sum + v, 0) / confidences.length) * 100 : 0

  return { text: chars.join(''), confidence }
}
