// ストレージ永続化 (StorageManager.persist) の要求・状態確認をまとめる小さなユーティリティ。
// 対応していない環境やエラー時は「保護されていない」として安全側に倒す。
// Android は空き容量が少ないと、確認なしに IndexedDB を丸ごと消去することがあるため、
// このAPIで保護を要求しておくことが唯一の対策になる（ただし許可するかはブラウザ次第）。

function getStorageManager(): StorageManager | null {
  if (typeof navigator === 'undefined' || !('storage' in navigator)) return null
  return navigator.storage
}

/** 現在ストレージが永続化保護されているかを調べる */
export async function isStoragePersisted(): Promise<boolean> {
  try {
    const storage = getStorageManager()
    if (!storage || typeof storage.persisted !== 'function') return false
    return await storage.persisted()
  } catch {
    return false
  }
}

/** ストレージの永続化保護を要求する。ブラウザによっては黙って許可/拒否されるだけのこともある */
export async function requestStoragePersistence(): Promise<boolean> {
  try {
    const storage = getStorageManager()
    if (!storage || typeof storage.persist !== 'function') return false
    return await storage.persist()
  } catch {
    return false
  }
}
