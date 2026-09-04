// 表罫線（枠線）の検出・除去と、罫線を避けたROIの内側詰めを行う純粋モジュール。
//
// stripes.ts と同じ設計方針をそのまま踏襲する: canvas / ImageData には一切依存せず、
// 数値配列（グレースケール輝度の1次元配列と幅・高さ）だけを扱う。理由も同じで、
// vitest が Node 環境（vite.config.ts の test.environment: 'node'）で完結するように
// するため。実際の画素の読み書き（getImageData / crop）は preprocess.ts 側の責務とし、
// ここには一切持ち込まない。
//
// stripes.ts の countTransitions（反転回数）との違い、なぜそれでは罫線を拾えないか:
// バーコードの縞は「白黒反転が非常に多い」ことを手がかりに検出した。罫線（枠線）は
// 逆の性質を持つ。罫線は反転が少なく、その代わり「同じ暗さの画素が途切れず長く
// 連続する」。文字のストロークも暗画素の連続ではあるが、良くて数文字分の幅で
// 途切れる。ROI の大半（初期値では6割以上）を横切ってようやく罫線と呼べるだけの
// 連続暗画素ランは、印字された文字列の走査線ではまず起こらない。そのため罫線検出は
// 「反転回数」ではなく「最長連続暗画素ランの、走査方向全長に対する比率」を使う。

// ============================================================================
// しきい値（すべて机上の初期値。実機の現品票画像がまだ手元にないための決め打ちであり、
// 実際のラベル画像で調整することを前提にしている。この事情は正直に明記しておく）
// ============================================================================

/**
 * 「暗い画素」とみなす輝度（0..255、以下ならば暗い）のしきい値。
 *
 * 罫線は多くの場合、印刷のインクや枠の縁として黒に近い色で引かれることを想定し、
 * 中間グレー（128）よりだいぶ暗い側に振った。ただし薄いグレーの罫線や、照明ムラで
 * 全体が暗く沈んだROIでは検出漏れが起きうる。preprocess.ts 側でこの検出はコントラスト
 * 正規化の後に行うようにしており（理由は preprocess.ts のコメントを参照）、照明条件に
 * よるばらつきはある程度そちらで吸収される前提の値。
 */
export const RULED_LINE_DARK_THRESHOLD = 100

/**
 * 罫線とみなす「最長連続暗画素ラン」の、走査方向全長（行なら幅、列なら高さ）に
 * 対する比率。0.6 とした根拠: 文字は数文字分の幅しか暗画素が連続しないため、
 * ROI の6割以上を暗画素が途切れず横切るのは、印字された文字列ではまず起こらず、
 * 実質的に罫線（あるいは塗りつぶし帯）でしか発生しない、という机上の想定に基づく。
 */
export const RULED_LINE_RUN_RATIO = 0.6

/**
 * 罫線として線形インペイントで除去してよい最大の太さ（px）。
 *
 * これを超える連続暗画素の帯（極端に太い罫線や、意図的な塗りつぶし帯など）は、
 * 直上/直下（縦罫線なら左右）の非罫線行・列との距離が開きすぎて、線形補間の
 * 信頼性が失われる。信頼できない補間で広い範囲を書き換えるくらいなら、あえて
 * 何もしない方が安全（全面を塗り潰して情報を消すのが最悪のケース）という判断で、
 * 安全弁として太さの上限を設けている。罫線の太さは実運用ではおおむね数px程度と
 * 見込んでの初期値。
 */
export const MAX_RULED_LINE_THICKNESS_PX = 6

/**
 * ROI の内側詰め（1-C）で、元のROIに対して最低限保持しなければならない割合。
 *
 * 罫線の誤検出（たまたま文字の並びが条件を満たした場合など）で大きく削り込み、
 * 文字そのものを失う事故を防ぐための下限。0.7 は「上下合わせて・左右合わせて、
 * それぞれ最大でも3割までしか削らない」という机上の初期値。
 */
export const MIN_INNER_CROP_RETAIN_RATIO = 0.7

// ============================================================================
// 検出
// ============================================================================

/**
 * 1本の走査線（行または列）の中で、最長の連続暗画素ランを求める。
 *
 * どんな入力（空配列・NaN混じり・要素数1など）でも例外を投げず、意味の通る値
 * （見つからなければ長さ0）を返す。stripes.ts の countTransitions / findDenseBand
 * が守っている規約と同じ。
 */
export function longestDarkRun(line: ArrayLike<number>, darkThreshold: number): { start: number; length: number } {
  if (!line || line.length === 0) return { start: 0, length: 0 }
  const threshold = Number.isFinite(darkThreshold) ? darkThreshold : RULED_LINE_DARK_THRESHOLD

  let bestStart = 0
  let bestLength = 0
  let curStart = -1

  for (let i = 0; i < line.length; i++) {
    const value = line[i]
    const isDark = Number.isFinite(value) && value <= threshold
    if (isDark) {
      if (curStart === -1) curStart = i
      const length = i - curStart + 1
      if (length > bestLength) {
        bestLength = length
        bestStart = curStart
      }
    } else {
      curStart = -1
    }
  }

  return { start: bestStart, length: bestLength }
}

// longestDarkRun を、2次元配列上の1本の走査線（行 or 列）に対して、実体をコピーせず
// ストライド（要素間隔）指定で直接読みに行くための内部ヘルパー。
// 行方向なら offset=y*w, stride=1, count=w。列方向なら offset=x, stride=w, count=h。
function longestDarkRunStrided(
  gray: ArrayLike<number>,
  offset: number,
  stride: number,
  count: number,
  darkThreshold: number,
): { start: number; length: number } {
  if (!gray || count <= 0) return { start: 0, length: 0 }
  const threshold = Number.isFinite(darkThreshold) ? darkThreshold : RULED_LINE_DARK_THRESHOLD

  let bestStart = 0
  let bestLength = 0
  let curStart = -1

  for (let i = 0; i < count; i++) {
    const value = gray[offset + i * stride]
    const isDark = Number.isFinite(value) && value <= threshold
    if (isDark) {
      if (curStart === -1) curStart = i
      const length = i - curStart + 1
      if (length > bestLength) {
        bestLength = length
        bestStart = curStart
      }
    } else {
      curStart = -1
    }
  }

  return { start: bestStart, length: bestLength }
}

/**
 * 罫線と判定された1本の走査線（行 or 列）の情報。
 *
 * index は行番号（あるいは列番号）。runStart / runLength は、その行・列の中で
 * 見つかった最長連続暗画素ランの開始位置と長さ（＝罫線とみなした根拠そのもの）。
 *
 * 将来のデスキュー（傾き補正）への布石として runStart を残してある: 罫線が
 * 画像に対して斜めに傾いていれば、連続する行ごとに runStart が少しずつ横に
 * ずれていくはずなので、複数行分の runStart を横軸=index・縦軸=runStart として
 * 線形回帰すれば傾き角が求まる。ただし本実装ではそこまでは行っていない
 * （実際には ROI 内に複数本の罫線が混在しうるため、どの行がどの罫線に属すかを
 * まず分類するクラスタリングが必要で、机上の初期実装の範囲を超えると判断した）。
 * 傾き推定が必要になったら、この runStart を出発点にするとよい。
 */
export type RuledLine = { index: number; runStart: number; runLength: number }

export type RuledLines = { rows: RuledLine[]; cols: RuledLine[] }

export type DetectRuledLinesOptions = { darkThreshold?: number; runRatio?: number }

function safeDims(w: number, h: number): { w: number; h: number } {
  const safeW = Number.isFinite(w) && w > 0 ? Math.floor(w) : 0
  const safeH = Number.isFinite(h) && h > 0 ? Math.floor(h) : 0
  return { w: safeW, h: safeH }
}

/** 行方向（横罫線）の罫線検出。各行の最長連続暗画素ランが幅の runRatio 以上なら罫線行とみなす。 */
export function detectRuledRows(
  gray: ArrayLike<number>,
  w: number,
  h: number,
  darkThreshold: number = RULED_LINE_DARK_THRESHOLD,
  runRatio: number = RULED_LINE_RUN_RATIO,
): RuledLine[] {
  const { w: safeW, h: safeH } = safeDims(w, h)
  if (!gray || safeW <= 0 || safeH <= 0) return []
  const ratio = Number.isFinite(runRatio) && runRatio > 0 ? runRatio : RULED_LINE_RUN_RATIO
  const minRunLength = safeW * ratio

  const rows: RuledLine[] = []
  for (let y = 0; y < safeH; y++) {
    const { start, length } = longestDarkRunStrided(gray, y * safeW, 1, safeW, darkThreshold)
    if (length >= minRunLength) rows.push({ index: y, runStart: start, runLength: length })
  }
  return rows
}

/** 列方向（縦罫線）の罫線検出。行方向と対称のロジック（ストライドが w になるだけ）。 */
export function detectRuledCols(
  gray: ArrayLike<number>,
  w: number,
  h: number,
  darkThreshold: number = RULED_LINE_DARK_THRESHOLD,
  runRatio: number = RULED_LINE_RUN_RATIO,
): RuledLine[] {
  const { w: safeW, h: safeH } = safeDims(w, h)
  if (!gray || safeW <= 0 || safeH <= 0) return []
  const ratio = Number.isFinite(runRatio) && runRatio > 0 ? runRatio : RULED_LINE_RUN_RATIO
  const minRunLength = safeH * ratio

  const cols: RuledLine[] = []
  for (let x = 0; x < safeW; x++) {
    const { start, length } = longestDarkRunStrided(gray, x, safeW, safeH, darkThreshold)
    if (length >= minRunLength) cols.push({ index: x, runStart: start, runLength: length })
  }
  return cols
}

/** detectRuledRows / detectRuledCols をまとめて行う。 */
export function detectRuledLines(
  gray: ArrayLike<number>,
  w: number,
  h: number,
  options?: DetectRuledLinesOptions,
): RuledLines {
  const darkThreshold = options?.darkThreshold ?? RULED_LINE_DARK_THRESHOLD
  const runRatio = options?.runRatio ?? RULED_LINE_RUN_RATIO
  return {
    rows: detectRuledRows(gray, w, h, darkThreshold, runRatio),
    cols: detectRuledCols(gray, w, h, darkThreshold, runRatio),
  }
}

// ============================================================================
// 除去（1次元線形インペイント）
// ============================================================================

// 連続する整数のインデックス列を「区間（run）」の列にまとめる。
// 重複除去・NaN除去・昇順ソートも行い、呼び出し側がどんな順序・重複ありで
// 渡してきても正しく動くようにする。
function groupConsecutive(indices: number[]): { start: number; end: number }[] {
  if (!indices || indices.length === 0) return []
  const sorted = [...new Set(indices.filter((i) => Number.isFinite(i)))].sort((a, b) => a - b)
  if (sorted.length === 0) return []

  const runs: { start: number; end: number }[] = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i]
    } else {
      runs.push({ start, end: prev })
      start = sorted[i]
      prev = sorted[i]
    }
  }
  runs.push({ start, end: prev })
  return runs
}

// 罫線と判定された行の帯を、直上・直下の非罫線行から線形補間して埋める。
// ベタ塗りではなく線形インペイントを選んだ理由: 罫線の太さは数pxしかなく、
// 交差する文字のストローク（罫線の上下にまたがって続いている縦画・横画）は、
// 直上・直下の実際の画素値から補間すればほぼ復元できる。ベタ塗り（周囲の
// 平均色などで一律に塗る）だと、罫線と交差していた文字のストロークまで
// 完全に消えてしまい、ベタ塗りの方がかえって情報を失う。
function inpaintRows(out: Uint8ClampedArray, w: number, h: number, ruledRowIndices: number[], maxThicknessPx: number): void {
  const runs = groupConsecutive(ruledRowIndices)
  for (const run of runs) {
    const thickness = run.end - run.start + 1
    if (thickness > maxThicknessPx) continue // 安全弁: 太すぎる帯（太い罫線・塗りつぶし帯）は補間せず諦める

    const donorAbove = run.start - 1
    const donorBelow = run.end + 1
    if (donorAbove < 0 || donorBelow > h - 1) continue // 画像端に接していて片側にしか補間元が無い場合も諦める

    const span = donorBelow - donorAbove
    const aboveOffset = donorAbove * w
    const belowOffset = donorBelow * w
    for (let y = run.start; y <= run.end; y++) {
      const t = (y - donorAbove) / span
      const rowOffset = y * w
      for (let x = 0; x < w; x++) {
        const a = out[aboveOffset + x]
        const b = out[belowOffset + x]
        out[rowOffset + x] = Math.round(a + (b - a) * t)
      }
    }
  }
}

// inpaintRows と対称の縦罫線版（左右の非罫線列から補間する）。
function inpaintCols(out: Uint8ClampedArray, w: number, h: number, ruledColIndices: number[], maxThicknessPx: number): void {
  const runs = groupConsecutive(ruledColIndices)
  for (const run of runs) {
    const thickness = run.end - run.start + 1
    if (thickness > maxThicknessPx) continue

    const donorLeft = run.start - 1
    const donorRight = run.end + 1
    if (donorLeft < 0 || donorRight > w - 1) continue

    const span = donorRight - donorLeft
    for (let x = run.start; x <= run.end; x++) {
      const t = (x - donorLeft) / span
      for (let y = 0; y < h; y++) {
        const rowOffset = y * w
        const a = out[rowOffset + donorLeft]
        const b = out[rowOffset + donorRight]
        out[rowOffset + x] = Math.round(a + (b - a) * t)
      }
    }
  }
}

/**
 * 検出済みの罫線（行・列それぞれのインデックス）を、1次元の線形インペイントで
 * グレースケール画像から除去する。入力は書き換えず、新しい配列を返す（他の
 * ヘルパーと同様の純粋関数）。
 *
 * 行の除去→列の除去の順で行う。行と列の罫線が交差するマス目は行側の補間で
 * 先に埋まった値を列側の補間の材料にも使うことになるが、どちらも周辺の
 * 実際の画素値からの線形補間である点は変わらず、交差点だけを特別扱いするより
 * 単純で、実害も小さいと判断した。
 *
 * どんな入力でも例外を投げない。空配列・幅/高さ0・NaN混じりのインデックス列を
 * 渡しても、可能な範囲で処理し、それ以上のことはできない場合は何もしない。
 */
export function inpaintRuledLines(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  ruledRowIndices: number[],
  ruledColIndices: number[],
  maxThicknessPx: number = MAX_RULED_LINE_THICKNESS_PX,
): Uint8ClampedArray {
  const { w: safeW, h: safeH } = safeDims(w, h)
  if (!gray || gray.length === 0 || safeW <= 0 || safeH <= 0) {
    return gray instanceof Uint8ClampedArray ? Uint8ClampedArray.from(gray) : new Uint8ClampedArray(0)
  }

  const thickness = Number.isFinite(maxThicknessPx) && maxThicknessPx > 0 ? maxThicknessPx : MAX_RULED_LINE_THICKNESS_PX
  const out = Uint8ClampedArray.from(gray)
  inpaintRows(out, safeW, safeH, ruledRowIndices ?? [], thickness)
  inpaintCols(out, safeW, safeH, ruledColIndices ?? [], thickness)
  return out
}

// ============================================================================
// 内側詰め（1-C）
// ============================================================================

export type CropRect = { x: number; y: number; w: number; h: number }

// 1軸分の「開始側トリム量・終了側トリム量」を、下限（保持すべき最小割合）を
// 超えないように必要なら比例縮小する。片側だけを削って辻褄を合わせるのではなく、
// 開始側・終了側の比率を保ったまま両方を縮めることで、検出結果の左右・上下の
// 非対称性をできるだけ尊重する。
function clampTrimPair(startTrim: number, endTrim: number, total: number, minRetainRatio: number): [number, number] {
  const maxTotalTrim = total * (1 - minRetainRatio)
  const currentTrim = startTrim + endTrim
  if (currentTrim <= 0 || currentTrim <= maxTotalTrim) return [startTrim, endTrim]
  const scale = maxTotalTrim / currentTrim
  return [Math.floor(startTrim * scale), Math.floor(endTrim * scale)]
}

/**
 * 罫線が検出されたROIについて、外周から罫線に接している部分を内側へ詰めた
 * 切り出し矩形（ローカル座標）を求める。「消す」（インペイント）より「避ける」
 * （そもそもその範囲を切り出さない）方が安全、という考え方に基づく機能。
 *
 * ROI の四辺それぞれから内側に向かって走査し、罫線行・罫線列である間は
 * 境界を進める（例: 上端から下に向かって罫線行が続く限り top を進める）。
 * これは「表の外枠（枠線）がROIの端に写り込んでいる」ケースを狙ったもので、
 * ROI 内部にある罫線（表の行区切り線など）はここでは扱わない
 * （そちらは inpaintRuledLines が担当する）。
 *
 * 誤検出で大きく削り込み文字自体を失う事故を防ぐため、minRetainRatio
 * （既定 MIN_INNER_CROP_RETAIN_RATIO）を下回るまでは詰めない下限を設けている。
 *
 * 全行・全列が罫線判定されるような退化ケース（例: ROI全体が暗い単色）では、
 * 上端からの走査と下端からの走査がぶつかって「詰めた結果、幅/高さが0以下」に
 * なりうる。この場合は安全側に倒し、その軸はまったくトリムしない。
 */
export function computeInnerCrop(
  w: number,
  h: number,
  ruledRowIndices: number[],
  ruledColIndices: number[],
  minRetainRatio: number = MIN_INNER_CROP_RETAIN_RATIO,
): CropRect {
  const { w: safeW, h: safeH } = safeDims(w, h)
  if (safeW <= 0 || safeH <= 0) return { x: 0, y: 0, w: Math.max(0, safeW), h: Math.max(0, safeH) }

  const rowSet = new Set((ruledRowIndices ?? []).filter((i) => Number.isFinite(i)))
  const colSet = new Set((ruledColIndices ?? []).filter((i) => Number.isFinite(i)))

  let top = 0
  while (top < safeH && rowSet.has(top)) top++
  let bottom = safeH - 1
  while (bottom >= top && rowSet.has(bottom)) bottom--

  let left = 0
  while (left < safeW && colSet.has(left)) left++
  let right = safeW - 1
  while (right >= left && colSet.has(right)) right--

  // 退化ケース（全行/全列が罫線判定）の安全弁: トリムせず全域を保持する
  let topTrim = top <= bottom ? top : 0
  let bottomTrim = top <= bottom ? safeH - 1 - bottom : 0
  let leftTrim = left <= right ? left : 0
  let rightTrim = left <= right ? safeW - 1 - right : 0

  const ratio = Number.isFinite(minRetainRatio) && minRetainRatio > 0 && minRetainRatio <= 1 ? minRetainRatio : MIN_INNER_CROP_RETAIN_RATIO
  ;[topTrim, bottomTrim] = clampTrimPair(topTrim, bottomTrim, safeH, ratio)
  ;[leftTrim, rightTrim] = clampTrimPair(leftTrim, rightTrim, safeW, ratio)

  return {
    x: leftTrim,
    y: topTrim,
    w: Math.max(1, safeW - leftTrim - rightTrim),
    h: Math.max(1, safeH - topTrim - bottomTrim),
  }
}
