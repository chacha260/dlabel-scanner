// zxing-wasm ワーカーとの1リクエスト分のやり取りのうち、「事故が起きやすい
// 状態管理」だけを DOM に一切依存しない形で切り出したコア。
//
// 経緯（重要・変更する場合は必ず読むこと）: 以前の createZxingReader（barcode/index.ts）は
// detect() が worker からの result メッセージを待つ Promise を作るだけで、
// - reject する経路が一つも無い
// - タイムアウトが無い
// - worker の error / messageerror イベントを一切購読していない
// という状態だった。これらが揃うと、worker が
//   - データ量の多い QR を読もうとして wasm ヒープ確保に失敗し abort() する
//   - ブラウザにメモリ不足として OOM kill される
// といった形で「例外も投げずに、ただ黙って応答しなくなる」ケースで、detect() の
// Promise が永久に未解決のまま残ってしまう。useBarcodeScanner.ts の tick() は
// busyRef.current を detect().finally() でしか false に戻さない設計のため、
// これが起きるとフレームループ全体がそのフレームで永久に止まる
// （カメラ映像は流れ続けるのに一切バーコードが読めなくなる＝現場からは
// 「アプリが落ちた/固まった」ように見える）。
//
// このモジュールはその対策（有限時間で必ず settle させる・死亡判定・
// 死亡後の resource 解放・持続的なデコード失敗の検知）だけを、
// createImageBitmap や実際の Worker 生成といった DOM 依存処理と分離して
// 持つ。vitest の実行環境は 'node'（vite.config.ts 参照）で Worker も
// OffscreenCanvas も使えないため、こうして分離しておかないとこの
// 重要なロジックを一切テストできなくなってしまう。

import type { BarcodeHit } from './types'

/**
 * markDead() から worker.terminate() を呼べればよいだけなので、
 * 実際の Worker が持つ機能のうちこれだけを要求する最小インターフェースにしてある
 * （テストでは terminate() だけを持つダミーオブジェクトを渡せる）。
 */
export type TerminableWorker = {
  terminate(): void
}

export type ZxingReaderCoreOptions = {
  /**
   * 1リクエストが有限時間で必ず settle するためのタイムアウト（ミリ秒）。
   * フレームループは10fps（100ms間隔）で動くため、長すぎるとその間ずっと
   * フレームがスキップされ続けて「固まった」体感になる。一方で短すぎると、
   * データ量の多い QR のように正当に時間がかかる正常なデコードまで
   * 誤って worker ごと作り直す羽目になる。zxing-wasm のソフトウェアデコードは
   * 通常でも数百ms かかることがあるため、その数倍の余裕を見て数秒程度にする
   * （具体的な値は呼び出し側 index.ts で定義し、ここでは受け取るだけにする）。
   */
  timeoutMs: number
  /**
   * data.error 付きの result（= handleDecode が catch した回数）が
   * 何回連続で来たら「一時的な失敗ではなく持続的な失敗」とみなし、
   * このリーダーを死亡扱いにして作り直しの対象にするか。
   */
  maxConsecutiveErrors: number
  /**
   * 持続的な失敗（上記 maxConsecutiveErrors 到達）を検知した瞬間に、
   * 一度だけ呼ばれる通知。UI 側（useBarcodeScanner）が利用者にフィードバックを
   * 出すためのフック。タイムアウトによる死亡（1回限りの重いフレームからの
   * 自己回復、下記 markDead のコメント参照）ではあえて呼ばない
   * ＝ 単発の遅いフレーム程度では利用者に何も見せず静かに復旧し、
   * 「デコードそのものが繰り返し失敗している」という異常時にだけ知らせる。
   */
  onPersistentFailure?: () => void
}

export type ZxingReaderCore = {
  /** 新しいリクエストを登録し、id とその結果を待つ Promise を返す */
  registerRequest(): { id: number; promise: Promise<BarcodeHit[]> }
  /** worker からの result メッセージを反映する（該当 id が既に無ければ何もしない） */
  handleResult(id: number, hits: BarcodeHit[], error?: string): void
  /** worker の error / messageerror イベントを反映する（即座に死亡扱いにする） */
  handleWorkerFailure(): void
  /** このリーダーがもう使えない状態か（呼び出し側はこれが true なら作り直しを検討する） */
  isDead(): boolean
  /** 待機中の全リクエストを空配列で解決してから worker.terminate() する */
  close(): void
}

export function createZxingReaderCore(worker: TerminableWorker, options: ZxingReaderCoreOptions): ZxingReaderCore {
  let nextId = 0
  let dead = false
  let consecutiveErrors = 0
  const pending = new Map<number, { resolve: (hits: BarcodeHit[]) => void; timer: ReturnType<typeof setTimeout> }>()

  function settleAll(hits: BarcodeHit[]): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve(hits)
    }
    pending.clear()
  }

  // 死亡確定時の唯一の入口。複数の経路（タイムアウト・error/messageerrorイベント・
  // 持続的なデコード失敗・close()）から呼ばれるが、何度呼ばれても副作用は1回だけ
  // （worker.terminate() の多重呼び出しを避ける）。
  function markDead(): void {
    if (dead) return
    dead = true
    settleAll([])
    // タイムアウトはしたが worker 自体はまだ重い処理を続けている、という状態を
    // 放置すると何が起きるか: フレームループは detect() が settle さえすれば
    // busyRef を戻して次のフレームを送り続ける。だが実際の worker はまだ
    // 前のリクエストの処理中（JS/wasm は1スレッドなので、重い処理の最中は
    // 新しいメッセージを一切処理できない）であり、送り続けた新しいリクエスト
    // （transfer済みのImageBitmapを含む）は worker 側のメッセージキューに
    // 溜まっていくだけになる。これは「1フレームだけ遅かった」が「際限のない
    // メモリ増加」に変わってしまう典型的な二次災害であり、データ量の多い QR で
    // wasm の処理が詰まったときにこそ起こりやすい。
    // ここで即座に terminate() することで、詰まっている処理ごと・溜まっている
    // キューごと確実に断ち切る。以後は呼び出し側（barcode/index.ts の
    // 自己回復ラッパー）が新しい worker を作り直す前提とする。
    worker.terminate()
  }

  return {
    registerRequest() {
      // 呼び出し側は detect() の中で isDead() を確認してから ImageBitmap を
      // 作る設計だが、万一死亡後にそれでも呼ばれた場合に備え、ここでも
      // 安全側に倒しておく（無駄なタイマー登録をしない）。
      if (dead) return { id: -1, promise: Promise.resolve([]) }

      const id = nextId++
      const promise = new Promise<BarcodeHit[]>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve([])
          markDead()
        }, options.timeoutMs)
        pending.set(id, { resolve, timer })
      })
      return { id, promise }
    },
    handleResult(id, hits, error) {
      const entry = pending.get(id)
      if (entry) {
        clearTimeout(entry.timer)
        pending.delete(id)
        entry.resolve(hits)
      }

      if (error) {
        consecutiveErrors += 1
        if (consecutiveErrors >= options.maxConsecutiveErrors) {
          const wasAlreadyDead = dead
          markDead()
          // 既にタイムアウト等で死亡済みなら、持続的失敗としての通知は出さない
          // （利用者への通知は1つの異常につき1回に留める）。
          if (!wasAlreadyDead) options.onPersistentFailure?.()
        }
      } else {
        // 成功（またはエラーなしの「見つからなかった」）を1回でも挟んだら、
        // それまでの連続失敗はリセットする。散発的な失敗まで持続的失敗として
        // 扱わないため。
        consecutiveErrors = 0
      }
    },
    handleWorkerFailure() {
      markDead()
    },
    isDead: () => dead,
    close() {
      markDead()
    },
  }
}
