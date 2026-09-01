// OCR の ROI 枠（表示座標）に関する純粋ロジックの単体テスト。
// クランプ・最小サイズ・永続化の妥当性検証、および「移動/リサイズ後の表示座標が
// mapCoverRectToVideo を通っても正しく映像座標に変換される」という、
// 表示座標と映像座標の取り違えを検出するための回帰テストを含む。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mapCoverRectToVideo } from '../geometry'
import {
  clampRoi,
  DEFAULT_ROI,
  isValidRoiRect,
  loadPersistedRoi,
  MIN_ROI_H,
  MIN_ROI_W,
  moveRoi,
  resizeRoi,
  savePersistedRoi,
} from '../roi'

describe('clampRoi', () => {
  it('表示枠内に収まっている矩形はそのまま', () => {
    const rect = { x: 0.1, y: 0.2, w: 0.5, h: 0.3 }
    expect(clampRoi(rect)).toEqual(rect)
  })

  it('右・下にはみ出す位置は表示枠内に収まるよう詰められる', () => {
    const r = clampRoi({ x: 0.9, y: 0.9, w: 0.3, h: 0.3 })
    expect(r.x + r.w).toBeLessThanOrEqual(1.0000001)
    expect(r.y + r.h).toBeLessThanOrEqual(1.0000001)
    expect(r.w).toBeCloseTo(0.3, 6) // サイズ自体は変えず、位置だけ詰める
  })

  it('負の座標は0にクランプされる', () => {
    const r = clampRoi({ x: -0.5, y: -0.5, w: 0.2, h: 0.2 })
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
  })

  it('最小サイズを下回る幅・高さは最小値まで引き上げられる', () => {
    const r = clampRoi({ x: 0.5, y: 0.5, w: 0.001, h: 0.001 })
    expect(r.w).toBeCloseTo(MIN_ROI_W, 6)
    expect(r.h).toBeCloseTo(MIN_ROI_H, 6)
  })

  it('1を超える幅・高さは1にクランプされる', () => {
    const r = clampRoi({ x: 0, y: 0, w: 5, h: 5 })
    expect(r.w).toBe(1)
    expect(r.h).toBe(1)
  })

  it('NaN や無限大を含む矩形でも例外を投げず、有限の値を返す', () => {
    const r = clampRoi({ x: Number.NaN, y: Number.POSITIVE_INFINITY, w: Number.NaN, h: -Infinity })
    expect(Number.isFinite(r.x)).toBe(true)
    expect(Number.isFinite(r.y)).toBe(true)
    expect(Number.isFinite(r.w)).toBe(true)
    expect(Number.isFinite(r.h)).toBe(true)
  })
})

describe('moveRoi', () => {
  it('サイズを変えずに平行移動する', () => {
    const base = { x: 0.2, y: 0.2, w: 0.3, h: 0.2 }
    const r = moveRoi(base, 0.1, -0.05)
    expect(r.w).toBeCloseTo(base.w, 6)
    expect(r.h).toBeCloseTo(base.h, 6)
    expect(r.x).toBeCloseTo(0.3, 6)
    expect(r.y).toBeCloseTo(0.15, 6)
  })

  it('枠の外に出ようとする移動は境界でクランプされる', () => {
    const base = { x: 0.8, y: 0.8, w: 0.15, h: 0.15 }
    const r = moveRoi(base, 0.5, 0.5)
    expect(r.x + r.w).toBeLessThanOrEqual(1.0000001)
    expect(r.y + r.h).toBeLessThanOrEqual(1.0000001)
    expect(r.w).toBeCloseTo(base.w, 6) // 移動ではサイズは変わらない
  })
})

describe('resizeRoi', () => {
  const base = { x: 0.3, y: 0.3, w: 0.4, h: 0.2 }

  it('se ハンドルは右下だけを動かし、左上（x, y）は固定する', () => {
    const r = resizeRoi(base, 'se', 0.1, 0.05)
    expect(r.x).toBeCloseTo(base.x, 6)
    expect(r.y).toBeCloseTo(base.y, 6)
    expect(r.w).toBeCloseTo(base.w + 0.1, 6)
    expect(r.h).toBeCloseTo(base.h + 0.05, 6)
  })

  it('nw ハンドルは左上を動かし、右下（x+w, y+h）は固定する', () => {
    const r = resizeRoi(base, 'nw', 0.05, 0.05)
    const rightBefore = base.x + base.w
    const bottomBefore = base.y + base.h
    expect(r.x + r.w).toBeCloseTo(rightBefore, 6)
    expect(r.y + r.h).toBeCloseTo(bottomBefore, 6)
    expect(r.x).toBeCloseTo(base.x + 0.05, 6)
  })

  it('e ハンドルは幅だけを変え、高さ・y・x は変わらない', () => {
    const r = resizeRoi(base, 'e', 0.1, 0.5) // dy は e では無視される
    expect(r.x).toBeCloseTo(base.x, 6)
    expect(r.y).toBeCloseTo(base.y, 6)
    expect(r.h).toBeCloseTo(base.h, 6)
    expect(r.w).toBeCloseTo(base.w + 0.1, 6)
  })

  it('最小サイズを下回るほど縮めようとしても、最小サイズより小さくならない', () => {
    const r = resizeRoi(base, 'se', -1, -1)
    expect(r.w).toBeGreaterThanOrEqual(MIN_ROI_W - 1e-9)
    expect(r.h).toBeGreaterThanOrEqual(MIN_ROI_H - 1e-9)
  })

  it('表示枠の外まで広げようとしても 0..1 の範囲でクランプされる', () => {
    const r = resizeRoi(base, 'se', 5, 5)
    expect(r.x + r.w).toBeLessThanOrEqual(1.0000001)
    expect(r.y + r.h).toBeLessThanOrEqual(1.0000001)
  })
})

describe('isValidRoiRect', () => {
  it('正常な矩形は妥当と判定する', () => {
    expect(isValidRoiRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.2 })).toBe(true)
  })

  it('オブジェクトでない値・null・配列は不正', () => {
    expect(isValidRoiRect(null)).toBe(false)
    expect(isValidRoiRect(undefined)).toBe(false)
    expect(isValidRoiRect('roi')).toBe(false)
    expect(isValidRoiRect(42)).toBe(false)
  })

  it('フィールドが欠けている・数値でない場合は不正', () => {
    expect(isValidRoiRect({ x: 0.1, y: 0.2, w: 0.3 })).toBe(false)
    expect(isValidRoiRect({ x: '0.1', y: 0.2, w: 0.3, h: 0.2 })).toBe(false)
    expect(isValidRoiRect({ x: 0.1, y: 0.2, w: Number.NaN, h: 0.2 })).toBe(false)
  })

  it('最小サイズを下回る矩形は不正', () => {
    expect(isValidRoiRect({ x: 0.1, y: 0.2, w: 0.001, h: 0.2 })).toBe(false)
    expect(isValidRoiRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.001 })).toBe(false)
  })

  it('表示枠からはみ出す矩形は不正', () => {
    expect(isValidRoiRect({ x: 0.8, y: 0.2, w: 0.5, h: 0.2 })).toBe(false)
    expect(isValidRoiRect({ x: -0.1, y: 0.2, w: 0.3, h: 0.2 })).toBe(false)
  })
})

describe('loadPersistedRoi / savePersistedRoi（localStorage の読み書き）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('localStorage が使えない環境では既定値にフォールバックする', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(loadPersistedRoi()).toEqual(DEFAULT_ROI)
    expect(() => savePersistedRoi({ x: 0, y: 0, w: 0.5, h: 0.5 })).not.toThrow()
  })

  it('保存されていない場合は既定値を返す', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    })
    expect(loadPersistedRoi()).toEqual(DEFAULT_ROI)
  })

  it('壊れた JSON が保存されていても既定値にフォールバックする', () => {
    const store = new Map<string, string>([['dlabel-scanner:ocrRoi', '{not valid json']])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    })
    expect(loadPersistedRoi()).toEqual(DEFAULT_ROI)
  })

  it('形式は正しいが範囲外・最小サイズ未満の値は既定値にフォールバックする', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    })
    store.set('dlabel-scanner:ocrRoi', JSON.stringify({ x: 2, y: 2, w: 0.1, h: 0.1 }))
    expect(loadPersistedRoi()).toEqual(DEFAULT_ROI)
  })

  it('妥当な値は保存した通りに読み戻せる', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    })
    const rect = { x: 0.15, y: 0.3, w: 0.6, h: 0.15 }
    savePersistedRoi(rect)
    expect(loadPersistedRoi()).toEqual(rect)
  })
})

// --- 表示座標と映像座標の取り違えに対する回帰テスト ---
// ROI をドラッグ（moveRoi/resizeRoi）した後も、その矩形は依然として「表示座標」の
// ままである必要がある。mapCoverRectToVideo に通したときに、表示座標としての
// 意味を保ったまま正しく映像座標へ変換されることを確認する
// （= ドラッグ後の値をうっかり映像座標として扱ってしまうバグを検出できる）。
describe('ドラッグ後の ROI と mapCoverRectToVideo の組み合わせ（回帰テスト）', () => {
  it('移動後の ROI も表示枠と映像の cover 変換を正しく反映する', () => {
    const base = { x: 0.1, y: 0.26, w: 0.8, h: 0.18 }
    const dragged = moveRoi(base, 0.2, 0.1) // 表示座標のまま右下へドラッグ

    // 表示枠 400x340、映像 1920x1080（横長を縦長の枠に cover 表示）というテストケース。
    // 表示座標のまま渡すのが正しい使い方であることを明示する。
    const videoRect = mapCoverRectToVideo(dragged, 400, 340, 1920, 1080)

    expect(videoRect.x).toBeGreaterThanOrEqual(0)
    expect(videoRect.y).toBeGreaterThanOrEqual(0)
    expect(videoRect.x + videoRect.w).toBeLessThanOrEqual(1.000001)
    expect(videoRect.y + videoRect.h).toBeLessThanOrEqual(1.000001)

    // dragged をそのまま映像座標として使う（=変換を忘れる）と全く違う値になるはずで、
    // 変換が実際に効いていることを保証する
    expect(videoRect.x).not.toBeCloseTo(dragged.x, 3)
  })

  it('リサイズ後の ROI も同様に正しく映像座標へ変換される', () => {
    const base = { x: 0.1, y: 0.26, w: 0.8, h: 0.18 }
    const resized = resizeRoi(base, 'se', 0.05, 0.1)

    const videoRect = mapCoverRectToVideo(resized, 400, 340, 1920, 1080)
    expect(videoRect.w).toBeGreaterThan(0)
    expect(videoRect.h).toBeGreaterThan(0)
    expect(videoRect.x + videoRect.w).toBeLessThanOrEqual(1.000001)
    expect(videoRect.y + videoRect.h).toBeLessThanOrEqual(1.000001)
  })

  it('表示枠と映像が同じ縦横比なら、ドラッグ後の値も変わらず一致する（cover 補正が働かないケース）', () => {
    const base = { x: 0.1, y: 0.26, w: 0.8, h: 0.18 }
    const dragged = moveRoi(base, 0.05, -0.05)
    const videoRect = mapCoverRectToVideo(dragged, 800, 450, 1920, 1080) // 同じ 16:9
    expect(videoRect.x).toBeCloseTo(dragged.x, 6)
    expect(videoRect.y).toBeCloseTo(dragged.y, 6)
    expect(videoRect.w).toBeCloseTo(dragged.w, 6)
    expect(videoRect.h).toBeCloseTo(dragged.h, 6)
  })
})
