import { describe, expect, it } from 'vitest'
import { isAnyOverlayOpen, isBarcodeScanEnabled, isTriggerSatisfied, type OverlayFlags } from '../scanGating'

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
    trimPanelOpen: false,
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
    'trimPanelOpen',
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

describe('trimPanelOpen（整形パネル）と isBarcodeScanEnabled の組み合わせ', () => {
  const baseInputs = {
    tabActive: true,
    cameraReady: true,
    pageVisible: true,
    manualPaused: false,
    overlaysOpen: false,
    mode: 'barcode' as const,
  }

  it('整形パネルを開くとバーコード検出が無効になる', () => {
    const overlaysOpen = isAnyOverlayOpen({ trimPanelOpen: true })
    expect(isBarcodeScanEnabled({ ...baseInputs, overlaysOpen })).toBe(false)
  })

  it('整形パネルを閉じると検出が再開する（手動一時停止でない場合）', () => {
    const overlaysOpen = isAnyOverlayOpen({ trimPanelOpen: false })
    expect(isBarcodeScanEnabled({ ...baseInputs, overlaysOpen })).toBe(true)
  })

  it('手動一時停止中は整形パネルを閉じても検出は再開しない', () => {
    const overlaysOpen = isAnyOverlayOpen({ trimPanelOpen: false })
    expect(isBarcodeScanEnabled({ ...baseInputs, manualPaused: true, overlaysOpen })).toBe(false)
  })
})

describe('triggerMode / holdActive（常時読み取り と 長押し中のみ の切り替え）', () => {
  const baseInputs = {
    tabActive: true,
    cameraReady: true,
    pageVisible: true,
    manualPaused: false,
    overlaysOpen: false,
    mode: 'barcode' as const,
  }

  it('triggerMode を省略すると従来通り（常時読み取り）として扱われる', () => {
    expect(isBarcodeScanEnabled(baseInputs)).toBe(true)
  })

  it("triggerMode: 'continuous' はボタンを押していなくても true", () => {
    expect(isBarcodeScanEnabled({ ...baseInputs, triggerMode: 'continuous', holdActive: false })).toBe(true)
  })

  it("triggerMode: 'hold' でボタンを押していなければ false", () => {
    expect(isBarcodeScanEnabled({ ...baseInputs, triggerMode: 'hold', holdActive: false })).toBe(false)
  })

  it("triggerMode: 'hold' で holdActive を省略した場合も false（押していない扱い）", () => {
    expect(isBarcodeScanEnabled({ ...baseInputs, triggerMode: 'hold' })).toBe(false)
  })

  it("triggerMode: 'hold' でボタンを押している間だけ true", () => {
    expect(isBarcodeScanEnabled({ ...baseInputs, triggerMode: 'hold', holdActive: true })).toBe(true)
  })

  it('長押し中でも、手動一時停止中なら false（他の停止理由が優先される）', () => {
    expect(
      isBarcodeScanEnabled({ ...baseInputs, triggerMode: 'hold', holdActive: true, manualPaused: true }),
    ).toBe(false)
  })

  it('長押し中でも、オーバーレイが開いていれば false', () => {
    expect(
      isBarcodeScanEnabled({ ...baseInputs, triggerMode: 'hold', holdActive: true, overlaysOpen: true }),
    ).toBe(false)
  })

  it('長押し中でも、文字（OCR）モードなら false', () => {
    expect(isBarcodeScanEnabled({ ...baseInputs, triggerMode: 'hold', holdActive: true, mode: 'ocr' })).toBe(false)
  })

  it('長押し中でも、カメラが未準備なら false', () => {
    expect(
      isBarcodeScanEnabled({ ...baseInputs, triggerMode: 'hold', holdActive: true, cameraReady: false }),
    ).toBe(false)
  })
})

describe('isTriggerSatisfied（読み取り契機だけを見る述語）', () => {
  it('省略時は常時読み取り扱いで true', () => {
    expect(isTriggerSatisfied({})).toBe(true)
  })

  it("'continuous' は holdActive によらず true", () => {
    expect(isTriggerSatisfied({ triggerMode: 'continuous', holdActive: false })).toBe(true)
    expect(isTriggerSatisfied({ triggerMode: 'continuous', holdActive: true })).toBe(true)
  })

  it("'hold' は holdActive と一致する", () => {
    expect(isTriggerSatisfied({ triggerMode: 'hold', holdActive: false })).toBe(false)
    expect(isTriggerSatisfied({ triggerMode: 'hold', holdActive: true })).toBe(true)
  })
})
