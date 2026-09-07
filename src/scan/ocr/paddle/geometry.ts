// PaddleOCR パイプラインの座標計算まわりの純粋関数。canvas / ONNX に依存しない。

// ============================================================================
// 検出前処理: リサイズ後のサイズ計算
// ============================================================================

// 検出モデル（DBNet）にかける前に、長辺がこれを超えないように縮小する。
// 大きすぎる画像をそのまま検出モデルに通すと、WASM上でのCPU推論時間が
// 現実的でなくなる（「高精度・低速のフォールバック」という位置づけ自体は
// 許容するが、それでも数十秒〜分のオーダーになるのは実用に耐えない）。
// 960はPP-OCRの検出前処理でよく使われる既定値。
export const DET_MAX_SIDE = 960

// 検出モデルの入力は幅・高さとも32の倍数である必要がある（モデル内部のダウン
// サンプリング段数に由来する制約。用意済みのONNXの入力仕様として前提とする）。
export const DET_SIZE_MULTIPLE = 32

/**
 * 元画像のサイズ (width, height) から、検出モデルに渡すためのリサイズ後サイズと、
 * 「検出結果の座標を元画像の座標へ戻すための倍率」を求める。
 *
 * - 長辺が DET_MAX_SIDE を超える場合のみ縮小する（超えなければ等倍のまま
 *   32の倍数への丸めだけ行う）
 * - 幅・高さそれぞれを32の倍数に丸める（四捨五入。丸めた結果が0にならないよう
 *   最低でも multiple の値は確保する）
 *
 * scaleX / scaleY は「リサイズ後の座標 × scaleX = 元画像の座標」となるように
 * 定義してある（= 元サイズ / リサイズ後サイズ）。呼び出し側の後処理
 * （boxes.ts の postprocessDetection）はこれをそのまま乗算に使う。
 *
 * width・height が0以下やNaNでも例外を投げず、1として扱う。
 */
export function computeDetResize(
  width: number,
  height: number,
  maxSide: number = DET_MAX_SIDE,
  multiple: number = DET_SIZE_MULTIPLE,
): { width: number; height: number; scaleX: number; scaleY: number } {
  const safeW = Number.isFinite(width) && width > 0 ? width : 1
  const safeH = Number.isFinite(height) && height > 0 ? height : 1
  const safeMultiple = Number.isFinite(multiple) && multiple > 0 ? Math.floor(multiple) : 32
  const safeMaxSide = Number.isFinite(maxSide) && maxSide > 0 ? maxSide : 960

  const longSide = Math.max(safeW, safeH)
  const ratio = longSide > safeMaxSide ? safeMaxSide / longSide : 1

  const roundToMultiple = (v: number): number => Math.max(safeMultiple, Math.round(v / safeMultiple) * safeMultiple)

  const targetWidth = roundToMultiple(safeW * ratio)
  const targetHeight = roundToMultiple(safeH * ratio)

  return {
    width: targetWidth,
    height: targetHeight,
    scaleX: safeW / targetWidth,
    scaleY: safeH / targetHeight,
  }
}

// ============================================================================
// 認識前処理: 幅の計算
// ============================================================================

// 認識モデルの入力高さは仕様上48固定（ONNXの入力shape [N,3,48,W] より）。
export const REC_TARGET_HEIGHT = 48

// 認識モデルに渡す1枠あたりの幅の上限。極端に横長の枠（誤検出等）で
// 幅が際限なく伸びて推論時間・メモリを浪費しないようにするためのガード。
export const REC_MAX_WIDTH = 320

// コーディネーターが onnxruntime-node で実測した結果、認識モデルのタイムステップ数
// T は「入力幅W / 8」ちょうどになる（320/8=40 を実測で確認済み）。8で割り切れない
// 幅を渡すこと自体は動的軸なので動くと思われるが、割り切れる幅にしておけば
// 端数の丸めに起因する不確実性を最初から排除できるため、常に8の倍数に丸める。
export const REC_WIDTH_MULTIPLE = 8

/**
 * 検出枠（元画像上のピクセルサイズ）から、認識モデルに渡す画像の幅を求める。
 * 高さを REC_TARGET_HEIGHT に合わせたときのアスペクト比保持後の幅を、
 * REC_WIDTH_MULTIPLE の倍数に丸め、REC_MAX_WIDTH で頭打ちにする。
 *
 * boxWidth・boxHeight が0以下やNaNでも例外を投げない。
 */
export function computeRecTargetWidth(
  boxWidth: number,
  boxHeight: number,
  targetHeight: number = REC_TARGET_HEIGHT,
  maxWidth: number = REC_MAX_WIDTH,
  multiple: number = REC_WIDTH_MULTIPLE,
): number {
  const safeW = Number.isFinite(boxWidth) && boxWidth > 0 ? boxWidth : 1
  const safeH = Number.isFinite(boxHeight) && boxHeight > 0 ? boxHeight : 1
  const safeMultiple = Number.isFinite(multiple) && multiple > 0 ? Math.floor(multiple) : 8
  const safeMaxWidth = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 320

  const rawWidth = (safeW / safeH) * targetHeight
  const clamped = Math.max(safeMultiple, Math.min(safeMaxWidth, rawWidth))
  const rounded = Math.round(clamped / safeMultiple) * safeMultiple

  // 丸めで上限をわずかに超える可能性があるため、最後にもう一度クランプする
  return Math.max(safeMultiple, Math.min(safeMaxWidth, rounded))
}

// ============================================================================
// unclip（検出枠の外側への拡張）
// ============================================================================

export type AxisAlignedBox = { x: number; y: number; w: number; h: number }

// DBNetの後処理は、確率マップから得た輪郭を「文字の芯」程度に小さく検出しがちなため、
// 外側へ広げてから使うのが標準的（本家実装のunclip_ratio既定値と同じ1.5）。
export const DEFAULT_UNCLIP_RATIO = 1.5

/**
 * 軸平行矩形をunclip_ratioに応じて外側へ広げる近似計算。
 *
 * 本家PaddleOCRは「最小面積の回転矩形」に対してVattiクリッピングという
 * 汎用多角形オフセットアルゴリズムで広げているが、このアプリでは検出枠を
 * 軸平行のバウンディングボックスとして扱うと決めている（boxes.ts 冒頭のコメント
 * 参照）。軸平行という前提があるからこそ、Vattiクリッピングのような汎用アルゴリズム
 * を持ち出さなくても、本家と同じ「面積×unclip_ratio ÷ 周長」で求めた距離だけ
 * 各辺を外側にオフセットするだけで、同じ考え方（矩形の太さに応じて広げ幅を
 * 調整する）による近似が成立する。矩形が正方形に近いほど本家の結果に近く、
 * 極端な縦横比（非常に細長い枠）ではわずかに広がり方の比率が変わるが、
 * 現品票の1行程度のテキスト検出枠であれば実用上問題にならない近似とみなす。
 *
 * w・h が0以下の退化した矩形は、それ以上小さくできないのでそのまま返す。
 */
export function unclipBox(box: AxisAlignedBox, unclipRatio: number = DEFAULT_UNCLIP_RATIO): AxisAlignedBox {
  const { x, y, w, h } = box
  if (!(w > 0) || !(h > 0)) {
    return { x, y, w: Math.max(0, w), h: Math.max(0, h) }
  }
  const ratio = Number.isFinite(unclipRatio) && unclipRatio > 0 ? unclipRatio : DEFAULT_UNCLIP_RATIO
  const area = w * h
  const perimeter = 2 * (w + h)
  const distance = (area * ratio) / perimeter

  return {
    x: x - distance,
    y: y - distance,
    w: w + distance * 2,
    h: h + distance * 2,
  }
}

// ============================================================================
// 読み順ソート
// ============================================================================

/**
 * 検出枠を「上から下、同じ行なら左から右」の読み順に並べ替える。
 *
 * 「同じ行」かどうかは、2つの枠の中心Y座標の差が、2つの枠のうち低い方の
 * 高さの半分以内かどうかで判定する（片方が明らかに次の行にあるほど
 * 中心がずれていれば別の行、多少のズレ（ベースラインの違い等）は同じ行とみなす）。
 *
 * 比較のたびに許容誤差（片方の高さ基準）を計算し直す簡易的な実装のため、
 * 3つ以上の枠が絡む場合に厳密な推移律（a,bが同じ行・b,cが同じ行なら
 * a,cも同じ行、のような関係）が保証されるわけではない。行の高さが大きく
 * 揃わない・行数が非常に多い等の極端なケースでは、読み順が多少乱れる
 * 可能性がある近似だが、現品票程度の行数・行の高さの揃った撮影条件では
 * 実用上問題にならないと判断している。
 */
export function sortBoxesReadingOrder<T extends AxisAlignedBox>(boxes: readonly T[]): T[] {
  const sorted = [...boxes]
  sorted.sort((a, b) => {
    const aCenterY = a.y + a.h / 2
    const bCenterY = b.y + b.h / 2
    const rowTolerance = Math.min(a.h, b.h) / 2
    const dy = aCenterY - bCenterY
    if (Math.abs(dy) > rowTolerance) {
      return dy
    }
    return a.x - b.x
  })
  return sorted
}
