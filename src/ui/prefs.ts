// 画面まわりのユーザー設定。読み取った内容は保存しない方針だが、
// 毎回操作し直すのが煩わしい表示・操作の設定だけは localStorage に残す。

const SOUND_STORAGE_KEY = 'dlabel.soundEnabled'

/** 読み取り音を鳴らすか。保存値が無い・壊れている場合は ON とする */
export function loadSoundEnabled(): boolean {
  try {
    const raw = localStorage.getItem(SOUND_STORAGE_KEY)
    if (raw === null) return true
    return raw === 'true'
  } catch {
    // プライベートブラウジング等で読めなくても既定値で動作させる
    return true
  }
}

export function saveSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, String(enabled))
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}

const HELP_SEEN_STORAGE_KEY = 'dlabel.helpSeen'

/** 使い方（ヘルプ）パネルを一度でも見せたことがあるか。初回起動時の自動表示判定に使う */
export function loadHelpSeen(): boolean {
  try {
    return localStorage.getItem(HELP_SEEN_STORAGE_KEY) === 'true'
  } catch {
    // プライベートブラウジング等で読めない場合は「未表示」扱いにする
    // （毎回自動で開いてしまうだけで、実害はない）
    return false
  }
}

export function markHelpSeen(): void {
  try {
    localStorage.setItem(HELP_SEEN_STORAGE_KEY, 'true')
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}

const ZOOM_STORAGE_KEY = 'dlabel.zoom'

/**
 * 直近のズーム値。保存値が無い・壊れている場合は null を返す
 * （呼び出し側は「保存された値が無い」ものとして扱う）。
 * 保存されたのが別端末での値である可能性があるため、適用前に必ず
 * camera/zoom.ts の resolveZoomValue で現在の端末の範囲に対して検証すること。
 */
export function loadZoom(): number | null {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  } catch {
    // プライベートブラウジング等で読めなくても既定のズーム（範囲下限）で動作させる
    return null
  }
}

export function saveZoom(value: number): void {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(value))
  } catch {
    // 保存できなくても致命的ではないため無視する
  }
}
