// computeOcrScale / normalizeContrast の純粋なロジックのみを検証する
// （canvas 依存部分は preprocessRoi 側にあり、ここでは含まない）。

import { describe, expect, it } from 'vitest'
import { computeOcrScale, normalizeContrast, OCR_PIXEL_BUDGET, TARGET_ROI_HEIGHT_PX } from '../preprocess'

describe('computeOcrScale', () => {
  it('PCブラウザ相当（1280x720からROI切り出し）では、ROIの高さがTARGET_ROI_HEIGHT_PXに近づくスケールになる', () => {
    // DEFAULT_ROI（w:0.8, h:0.18）を 1280x720 に当てはめた典型的なサイズ
    const sw = 1024
    const sh = 130
    const scale = computeOcrScale(sw, sh)
    // 出力の高さがおよそ TARGET_ROI_HEIGHT_PX に近い値になっているはず
    expect(sh * scale).toBeGreaterThan(TARGET_ROI_HEIGHT_PX * 0.9)
    expect(sh * scale).toBeLessThan(TARGET_ROI_HEIGHT_PX * 1.1)
  })

  it('実機の高解像度カメラ相当（3840x2160からROI切り出し）でも、同じ物理的な文字の大きさなら\n     PCブラウザとほぼ同じ出力サイズになる（画素数ではなく高さ基準で倍率を決めているため）', () => {
    // 同じ DEFAULT_ROI（w:0.8, h:0.18）を 3840x2160 に当てはめたサイズ。
    // 画角・文字の物理的な大きさが同じであれば、入力解像度が3倍になっても
    // 出力サイズはほぼ変わらないのが新方式の狙い。
    const pcScale = computeOcrScale(1024, 130)
    const apkScale = computeOcrScale(3072, 389)
    const pcOutH = 130 * pcScale
    const apkOutH = 389 * apkScale
    // どちらも TARGET_ROI_HEIGHT_PX 付近に収束し、互いの差は小さい
    expect(Math.abs(pcOutH - apkOutH)).toBeLessThan(5)
  })

  it('小さい ROI では上限（4倍）でクランプされる', () => {
    // 高さ10pxのROIは 96/10 = 9.6倍相当になるが、4倍が上限
    const scale = computeOcrScale(80, 10)
    expect(scale).toBe(4)
  })

  it('非常に大きい ROI では下限（0.2倍）でクランプされる', () => {
    // 高さ1000pxのROIは 96/1000 = 0.096倍相当になるが、0.2倍が下限
    // （このケースでは出力画素数も予算内に収まるため、下限がそのまま採用される）
    const scale = computeOcrScale(1000, 1000)
    expect(scale).toBe(0.2)
  })

  it('画素数予算を超える場合は、高さ基準の下限クランプ（0.2）より優先して倍率を下げる', () => {
    // 幅が非常に大きい横長のROI。高さ基準だけなら0.2倍にクランプされるはずだが、
    // それでも出力画素数が予算を超えるため、予算優先でさらに縮小される。
    const sw = 40000
    const sh = 1000
    const scale = computeOcrScale(sw, sh)
    const outputPixels = sw * sh * scale * scale
    expect(scale).toBeLessThan(0.2)
    expect(outputPixels).toBeLessThanOrEqual(OCR_PIXEL_BUDGET + 1) // 浮動小数点誤差を許容
  })

  it('0 を渡しても有限の正の値を返し、例外を投げない', () => {
    expect(() => computeOcrScale(0, 0)).not.toThrow()
    const scale = computeOcrScale(0, 0)
    expect(Number.isFinite(scale)).toBe(true)
    expect(scale).toBeGreaterThan(0)
  })

  it('負の値を渡しても有限の正の値を返し、例外を投げない', () => {
    const scale = computeOcrScale(-100, -50)
    expect(Number.isFinite(scale)).toBe(true)
    expect(scale).toBeGreaterThan(0)
  })

  it('NaN を渡しても有限の正の値を返し、例外を投げない', () => {
    const scale = computeOcrScale(Number.NaN, Number.NaN)
    expect(Number.isFinite(scale)).toBe(true)
    expect(scale).toBeGreaterThan(0)
  })

  it('スケールは常に有限の正の値を返す（幅広い入力サイズで検証）', () => {
    const cases: [number, number][] = [
      [1, 1],
      [100, 100],
      [1536, 194],
      [5000, 5000],
      [1, 100000],
    ]
    for (const [w, h] of cases) {
      const scale = computeOcrScale(w, h)
      expect(Number.isFinite(scale)).toBe(true)
      expect(scale).toBeGreaterThan(0)
    }
  })
})

describe('normalizeContrast', () => {
  it('コントラストが低い（狭いレンジに集中した）画像を 0..255 いっぱいに引き伸ばす', () => {
    // 100〜150 の範囲に収まる、明暗差の乏しいグレースケール画像
    const gray = Uint8ClampedArray.from([100, 110, 120, 130, 140, 150])
    const out = normalizeContrast(gray)
    expect(Math.min(...out)).toBeLessThanOrEqual(5)
    expect(Math.max(...out)).toBeGreaterThanOrEqual(250)
    // 大小関係（順序）は保たれる＝しきい値判定で白黒に振り分ける二値化ではない
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(out[i - 1])
    }
  })

  it('レンジが極端に狭い（ほぼ単色の）画像はストレッチせずそのまま返す', () => {
    // 128 ± 1 程度のノイズしかない、ほぼ均一な画像
    const gray = Uint8ClampedArray.from([127, 128, 128, 129, 128, 127, 128, 129])
    const out = normalizeContrast(gray)
    expect(Array.from(out)).toEqual(Array.from(gray))
  })

  it('空配列を渡しても例外を投げない', () => {
    const gray = new Uint8ClampedArray(0)
    expect(() => normalizeContrast(gray)).not.toThrow()
    expect(normalizeContrast(gray).length).toBe(0)
  })

  it('外れ値（ごく少数の極端に明るい/暗い画素）に下位/上位の境界を引っ張られない', () => {
    // 95画素中、実質的な内容は 100〜130 に分布しており（各値3画素ずつ）、
    // そこに1画素ずつだけ 0 と 255 という外れ値が混じっている。
    // もし外れ値を無視せず単純な min/max でストレッチすると、
    // lo=0, hi=255 になってしまい、本来の内容（100〜130）はほとんど
    // 引き伸ばされないまま（100〜130 付近に固まったまま）になる。
    const base: number[] = []
    for (let v = 100; v <= 130; v++) {
      base.push(v, v, v)
    }
    const gray = Uint8ClampedArray.from([0, ...base, 255])
    const out = normalizeContrast(gray)
    const middle = Array.from(out).slice(1, 1 + base.length)
    // 外れ値を除いた下位/上位パーセンタイル（=100と130）を境界として使うため、
    // 本来の内容（100〜130）が 0..255 のほぼ全域まで引き伸ばされているはず
    expect(Math.max(...middle) - Math.min(...middle)).toBeGreaterThan(200)
  })
})
