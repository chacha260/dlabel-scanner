import { describe, expect, it } from 'vitest'
import { isAnyOverlayOpen, isBarcodeScanEnabled, type OverlayFlags } from '../scanGating'

function allClosed(): OverlayFlags {
  return {
    profilePickerOpen: false,
    rawPanelOpen: false,
    fieldEditorOpen: false,
    ocrResultPanelOpen: false,
    forceConfirmOpen: false,
    clearConfirmOpen: false,
    draftBannerOpen: false,
  }
}

describe('isAnyOverlayOpen', () => {
  it('すべて閉じていれば false', () => {
    expect(isAnyOverlayOpen(allClosed())).toBe(false)
  })

  const overlayKeys: (keyof OverlayFlags)[] = [
    'profilePickerOpen',
    'rawPanelOpen',
    'fieldEditorOpen',
    'ocrResultPanelOpen',
    'forceConfirmOpen',
    'clearConfirmOpen',
    'draftBannerOpen',
  ]

  for (const key of overlayKeys) {
    it(`${key} だけが true でも true になる`, () => {
      expect(isAnyOverlayOpen({ ...allClosed(), [key]: true })).toBe(true)
    })
  }
})

describe('isBarcodeScanEnabled', () => {
  const baseInputs = {
    tabActive: true,
    cameraReady: true,
    pageVisible: true,
    manualPaused: false,
    overlaysOpen: false,
  }

  it('すべての条件が満たされていれば true', () => {
    expect(isBarcodeScanEnabled(baseInputs)).toBe(true)
  })

  it('タブが非アクティブなら false', () => {
    expect(isBarcodeScanEnabled({ ...baseInputs, tabActive: false })).toBe(false)
  })

  it('カメラが未準備なら false', () => {
    expect(isBarcodeScanEnabled({ ...baseInputs, cameraReady: false })).toBe(false)
  })

  it('ページが非表示なら false', () => {
    expect(isBarcodeScanEnabled({ ...baseInputs, pageVisible: false })).toBe(false)
  })

  it('手動一時停止中なら false', () => {
    expect(isBarcodeScanEnabled({ ...baseInputs, manualPaused: true })).toBe(false)
  })

  it('オーバーレイが開いていれば false', () => {
    expect(isBarcodeScanEnabled({ ...baseInputs, overlaysOpen: true })).toBe(false)
  })

  it('オーバーレイが閉じてタブ・カメラ・可視性が揃えば再び true に戻る（自動再開、手動一時停止でない場合）', () => {
    const paused = isBarcodeScanEnabled({ ...baseInputs, overlaysOpen: true })
    expect(paused).toBe(false)
    const resumed = isBarcodeScanEnabled({ ...baseInputs, overlaysOpen: false })
    expect(resumed).toBe(true)
  })

  it('手動一時停止中はオーバーレイが閉じていても true に戻らない', () => {
    const result = isBarcodeScanEnabled({ ...baseInputs, manualPaused: true, overlaysOpen: false })
    expect(result).toBe(false)
  })
})
