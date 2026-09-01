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
    helpOpen: false,
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
    'helpOpen',
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
    mode: 'barcode' as const,
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

  it('文字（OCR）モードでは、他の条件が全て揃っていても false になる', () => {
    expect(isBarcodeScanEnabled({ ...baseInputs, mode: 'ocr' })).toBe(false)
  })

  it('バーコードモードで、他に何も阻害要因が無ければ true になる', () => {
    expect(isBarcodeScanEnabled({ ...baseInputs, mode: 'barcode' })).toBe(true)
  })
})

describe('helpOpen（使い方パネル）と isBarcodeScanEnabled の組み合わせ', () => {
  const baseInputs = {
    tabActive: true,
    cameraReady: true,
    pageVisible: true,
    manualPaused: false,
    overlaysOpen: false,
    mode: 'barcode' as const,
  }

  it('ヘルプを開くとバーコード検出が無効になる', () => {
    const overlaysOpen = isAnyOverlayOpen({ helpOpen: true })
    expect(isBarcodeScanEnabled({ ...baseInputs, overlaysOpen })).toBe(false)
  })

  it('ヘルプを閉じると検出が再開する（手動一時停止でない場合）', () => {
    const overlaysOpen = isAnyOverlayOpen({ helpOpen: false })
    expect(isBarcodeScanEnabled({ ...baseInputs, overlaysOpen })).toBe(true)
  })

  it('手動一時停止中はヘルプを閉じても検出は再開しない', () => {
    const overlaysOpen = isAnyOverlayOpen({ helpOpen: false })
    expect(isBarcodeScanEnabled({ ...baseInputs, manualPaused: true, overlaysOpen })).toBe(false)
  })
})
