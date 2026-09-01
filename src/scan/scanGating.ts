// バーコード検出の有効/無効を決める判定ロジック。
// React にも DOM にも依存しない純粋関数のみを置き、単体テストしやすくする。
// ScanScreen.tsx はここで計算した結果を useBarcodeScanner の enabled に渡すだけにする。

// 画面によって存在するオーバーレイの種類は異なる（例: 単一画面構成では
// プロファイル選択シートやフィールド編集など、そもそも存在しないものがある）。
// 各フラグは省略可能にし、省略時は「開いていない」として扱う。呼び出し側は
// 自分の画面に実在するオーバーレイの分だけ渡せばよい。

/** データ表示中の各種オーバーレイの開閉状態。1つでも開いていればバーコード検出は止める */
export type OverlayFlags = {
  /** ラベル定義の選択シート */
  profilePickerOpen?: boolean
  /** 生データ表示パネル */
  rawPanelOpen?: boolean
  /** フィールドごとの手入力/部分OCRエディタ */
  fieldEditorOpen?: boolean
  /** シャッターで撮った画像とOCR結果を表示している状態（処理中も含む） */
  ocrResultPanelOpen?: boolean
  /** 「不足のまま保存」確認ダイアログ */
  forceConfirmOpen?: boolean
  /** クリア確認ダイアログ */
  clearConfirmOpen?: boolean
  /** 起動時の「作業中のデータがあります」復元バー（ユーザーの選択待ち） */
  draftBannerOpen?: boolean
  /** 使い方（ヘルプ）パネルを全画面表示している状態 */
  helpOpen?: boolean
}

/** いずれかのオーバーレイが開いているか */
export function isAnyOverlayOpen(flags: OverlayFlags): boolean {
  return (
    (flags.profilePickerOpen ?? false) ||
    (flags.rawPanelOpen ?? false) ||
    (flags.fieldEditorOpen ?? false) ||
    (flags.ocrResultPanelOpen ?? false) ||
    (flags.forceConfirmOpen ?? false) ||
    (flags.clearConfirmOpen ?? false) ||
    (flags.draftBannerOpen ?? false) ||
    (flags.helpOpen ?? false)
  )
}

export type ScanGateInputs = {
  /** タブがスキャン画面で、かつカメラを起動すべき状態か（App.tsx 側のタブ切り替え） */
  tabActive: boolean
  /** カメラ映像の準備ができているか */
  cameraReady: boolean
  /** ブラウザタブ自体が前面表示中か（document.visibilityState === 'visible'） */
  pageVisible: boolean
  /** ユーザーが「一時停止」ボタンで手動停止しているか */
  manualPaused: boolean
  /** 何らかのオーバーレイが開いているか（isAnyOverlayOpen の結果） */
  overlaysOpen: boolean
}

/**
 * バーコード検出を有効にすべきかどうかを判定する単一の述語。
 * ここに列挙した条件のいずれか1つでも満たさなければ検出を止める。
 */
export function isBarcodeScanEnabled(inputs: ScanGateInputs): boolean {
  return (
    inputs.tabActive &&
    inputs.cameraReady &&
    inputs.pageVisible &&
    !inputs.manualPaused &&
    !inputs.overlaysOpen
  )
}
