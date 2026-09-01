// カメラのズーム値に関する純粋なロジックのみを集めたモジュール。DOM には依存しない。
//
// ズームの範囲（min/max/step）は端末・カメラごとに異なる。localStorage に
// 保存したズーム値を別の端末（あるいは同じ端末でも別のカメラ構成）でそのまま
// 適用すると、範囲外になったり、そもそもズーム非対応で範囲自体が無かったりする。
// そのため「適用する前に必ずこの関数を通す」ことを徹底する。

export type ZoomRange = { min: number; max: number; step: number }

/**
 * 永続化されたズーム値を、現在の端末の実際のズーム範囲に対して検証・クランプする。
 *
 * - range が無い（= 端末がズーム非対応）場合は null を返す（適用しない）。
 * - range 自体が壊れている（min/max が数値でない、max < min）場合も null を返す。
 * - persisted が無い（null）・数値でない（NaN 等）場合は、安全側として range の
 *   下限（min）にフォールバックする。
 * - persisted が範囲外なら、範囲内に収まるようクランプする。
 */
export function resolveZoomValue(persisted: number | null, range: ZoomRange | null): number | null {
  if (!range) return null
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max < range.min) return null

  if (persisted === null || !Number.isFinite(persisted)) return range.min
  if (persisted < range.min) return range.min
  if (persisted > range.max) return range.max
  return persisted
}
