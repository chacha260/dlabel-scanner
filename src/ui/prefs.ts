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
