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
  /** バーコード値の整形（トリミング）ルール設定パネルを全画面表示している状態 */
  trimPanelOpen?: boolean
  /** ライセンス情報パネルを全画面表示している状態 */
  licenseOpen?: boolean
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
    (flags.helpOpen ?? false) ||
    (flags.trimPanelOpen ?? false) ||
    (flags.licenseOpen ?? false)
  )
}

/**
 * この画面の2つの読み取りモード。
 * - 'barcode': 継続的なバーコード検出をONにする（従来の挙動）
 * - 'ocr'    : 継続的なバーコード検出をOFFにする。ユーザーが明示的にシャッターで
 *              読んだものだけを一覧に追加させたいための分離であり、これが
 *              モード分割の核心。他の条件が全て揃っていてもこのモードでは無効にする。
 */
export type ScanMode = 'barcode' | 'ocr'

/**
 * バーコードモードの「読み取り契機」。モード（barcode / ocr）とは直交する軸であり、
 * 「今バーコードを読む画面かどうか」ではなく「バーコードモードの中で、いつ読むか」を決める。
 *
 * - 'continuous': カメラを向けている間ずっと読み続ける（従来からの唯一の挙動）。
 *                 次々に読み取っていく棚卸しのような作業に向く。
 * - 'hold'      : 読み取りボタンを押している間だけ読む。指を離した瞬間に止まる。
 *                 現品票が密集していて、狙っていない隣のラベルまで勝手に拾ってしまう
 *                 現場（ユーザー要望）向け。ハンディターミナルのトリガーと同じ操作感になる。
 *
 * 既定は 'continuous'。これまで唯一の挙動だったものを既定から外すと、
 * 何も設定を触っていない利用者の手元で挙動が変わってしまうため。
 */
export type BarcodeTriggerMode = 'continuous' | 'hold'

export const DEFAULT_BARCODE_TRIGGER_MODE: BarcodeTriggerMode = 'continuous'

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
  /** 現在の読み取りモード。'ocr' のときは他の条件によらず常に無効にする */
  mode: ScanMode
  /**
   * バーコードの読み取り契機。省略時は 'continuous'（＝従来通りの常時読み取り）として扱う。
   * 省略可能にしてあるのは、モード分割前から存在する画面（src/ui/legacy/ScanScreen.tsx）が
   * この軸を持たないまま従来の挙動で動き続けられるようにするため。
   */
  triggerMode?: BarcodeTriggerMode
  /**
   * triggerMode が 'hold' のときに、読み取りボタンが「今まさに押されているか」。
   * 省略時は false。'continuous' のときはこの値を一切見ない
   * （＝ボタンを押していなくても読み続ける）。
   */
  holdActive?: boolean
}

/**
 * 読み取り契機の条件だけを切り出した述語。
 * - 'continuous': 常に満たされる（ボタンの押下状態を一切見ない）
 * - 'hold'      : ボタンが押されている間だけ満たされる
 *
 * triggerMode を省略した呼び出し（レガシー画面など）は 'continuous' 扱いになるため、
 * この関数を通しても従来の挙動は一切変わらない。
 */
export function isTriggerSatisfied(inputs: Pick<ScanGateInputs, 'triggerMode' | 'holdActive'>): boolean {
  const triggerMode = inputs.triggerMode ?? DEFAULT_BARCODE_TRIGGER_MODE
  if (triggerMode === 'continuous') return true
  return inputs.holdActive ?? false
}

/**
 * バーコード検出を有効にすべきかどうかを判定する単一の述語。
 * ここに列挙した条件のいずれか1つでも満たさなければ検出を止める。
 *
 * 「長押し中のみ読む」モードの停止も、専用の分岐を別に設けるのではなく
 * この述語の条件のひとつ（isTriggerSatisfied）として畳み込む。こうしておくと
 * 「一時停止中」「ヘルプを開いている」といった既存の停止理由と同じ経路を通るため、
 * 呼び出し側（useBarcodeScanner の enabled）に渡す値の作り方が1本のままで済む。
 */
export function isBarcodeScanEnabled(inputs: ScanGateInputs): boolean {
  return (
    inputs.mode === 'barcode' &&
    inputs.tabActive &&
    inputs.cameraReady &&
    inputs.pageVisible &&
    !inputs.manualPaused &&
    !inputs.overlaysOpen &&
    isTriggerSatisfied(inputs)
  )
}
