import { describe, expect, it } from 'vitest'
import { mapCoverRectToVideo } from '../../ocr/geometry'
import { filterHitsByRoi, isHitInRoi } from '../roiFilter'
import type { BarcodeHit } from '../types'

const ROI = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } // 中央の正方形

function hitWithBox(value: string, box: { x: number; y: number; w: number; h: number }): BarcodeHit {
  return { value, format: 'code_128', box }
}

describe('isHitInRoi', () => {
  it('中心が ROI の内側にあるヒットは採用される', () => {
    const hit = hitWithBox('inside', { x: 0.4, y: 0.4, w: 0.1, h: 0.1 }) // 中心 (0.45, 0.45)
    expect(isHitInRoi(hit, ROI)).toBe(true)
  })

  it('中心が ROI の外側にあるヒットは除外される', () => {
    const hit = hitWithBox('outside', { x: 0.0, y: 0.0, w: 0.1, h: 0.1 }) // 中心 (0.05, 0.05)
    expect(isHitInRoi(hit, ROI)).toBe(false)
  })

  it('中心がちょうど ROI の境界上にあるヒットは採用される（境界含む）', () => {
    // 中心がちょうど ROI の左端 x=0.25 に一致する
    const hit = hitWithBox('boundary', { x: 0.2, y: 0.4, w: 0.1, h: 0.1 }) // 中心 (0.25, 0.45)
    expect(isHitInRoi(hit, ROI)).toBe(true)
  })

  it('box を持たないヒットは判定できないため常に採用する', () => {
    const hit: BarcodeHit = { value: 'no-box', format: 'qr_code' }
    expect(isHitInRoi(hit, ROI)).toBe(true)
  })
})

describe('filterHitsByRoi', () => {
  it('内側・外側が混在する配列から、内側だけを検出順のまま返す', () => {
    const hits = [
      hitWithBox('outside-1', { x: 0.0, y: 0.0, w: 0.05, h: 0.05 }),
      hitWithBox('inside-1', { x: 0.3, y: 0.3, w: 0.05, h: 0.05 }),
      hitWithBox('outside-2', { x: 0.9, y: 0.9, w: 0.05, h: 0.05 }),
      hitWithBox('inside-2', { x: 0.45, y: 0.45, w: 0.05, h: 0.05 }),
    ]
    expect(filterHitsByRoi(hits, ROI).map((h) => h.value)).toEqual(['inside-1', 'inside-2'])
  })

  it('回帰ガード: object-fit: cover でレターボックスされた映像でも、mapCoverRectToVideo を通した ROI が正しいヒットを選ぶ', () => {
    // 縦長の枠(400x800)に横長の映像(1920x1080)を cover 表示 → 上下が大きく切り落とされる
    const displayRoi = { x: 0.1, y: 0.4, w: 0.8, h: 0.2 } // 表示座標（画面中央付近の横長の帯）
    const videoRoi = mapCoverRectToVideo(displayRoi, 400, 800, 1920, 1080)

    // 映像座標で、ROI の中心付近に位置するバーコード（狙った1本）
    const centerX = videoRoi.x + videoRoi.w / 2
    const centerY = videoRoi.y + videoRoi.h / 2
    const targeted = hitWithBox('targeted', { x: centerX - 0.02, y: centerY - 0.02, w: 0.04, h: 0.04 })

    // 映像の上端付近（cover で切り落とされ表示すらされていない領域）にある別のバーコード
    const outOfView = hitWithBox('out-of-view', { x: 0.5, y: 0.01, w: 0.04, h: 0.04 })

    const result = filterHitsByRoi([outOfView, targeted], videoRoi)
    expect(result.map((h) => h.value)).toEqual(['targeted'])
  })
})
