// UI から見た唯一の入口。どちらのバックエンド（ネイティブ / zxing-wasm）が
// 動いているかを呼び出し側が意識しなくて済むようにするファサード。

import type { BarcodeHit, BarcodeInput, BarcodeReader } from './types'
import { createNativeReader, isNativeAvailable } from './native'
import { createZxingReaderCore, type ZxingReaderCore } from './zxingReaderCore'

export type { BarcodeHit, BarcodeInput, BarcodeReader, NormalizedRect } from './types'
export { SUPPORTED_FORMATS } from './types'
export { selectNewHits } from './dedupe'
export { filterHitsByRoi, isHitInRoi } from './roiFilter'

export type BarcodeBackend = 'native' | 'zxing'

// createBarcodeReader() の呼び出し側（useBarcodeScanner）が、zxing-wasm 経路の
// 「重大だが即座には気づけない」異常を利用者に伝えるためのフック。
// どちらも任意（省略時はログにも利用者にも一切出さない、という既存の挙動のまま）。
export type BarcodeReaderNotifications = {
  /**
   * デコードが連続して失敗し続けている（＝1フレームの偶発的な失敗ではなく
   * 持続的な異常）と判定されたときに1回だけ呼ばれる。この時点でリーダーは
   * 自動的に作り直され、以後は新しい worker で継続を試みる
   * （zxingReaderCore.ts の onPersistentFailure 参照）。
   */
  onPersistentDecodeFailure?: () => void
  /**
   * worker の自己回復（下記 createFallbackReader 参照）を既定回数
   * （MAX_ZXING_WORKER_REGENERATIONS 回）試みてもなお使えない状態が続き、
   * これ以上の自動復旧を諦めたときに1回だけ呼ばれる。
   */
  onWorkerExhausted?: () => void
}

type DecodeMessage = { type: 'decode'; id: number; bitmap: ImageBitmap }
type ResultMessage = { type: 'result'; id: number; hits: BarcodeHit[]; error?: string }

// zxingReaderCore が「死亡」と判定した後の detect() は、呼び出し側
// （createFallbackReader の自己回復ラッパー）が isDead() を見て worker を
// 作り直せるように、BarcodeReader に isDead() を足した拡張型として扱う。
type ZxingBarcodeReader = BarcodeReader & { isDead(): boolean }

// 1リクエストのタイムアウト（ミリ秒）。
// 根拠: フレームループは10fps（FRAME_INTERVAL_MS=100ms、useBarcodeScanner.ts参照）
// で動くため、あまり長いと「詰まった」体感がそのまま続いてしまう。一方で
// zxing-wasm のソフトウェアデコードはデータ量の多いQR（tryHarder等の探索も絡む）
// では数百ms〜1秒程度かかることも珍しくないため、正常な処理まで誤って
// タイムアウト＝異常と判定しないよう、その数倍の余裕（4秒）を持たせる。
const ZXING_DETECT_TIMEOUT_MS = 4000

// 何回連続で data.error 付きの result（= zxing.worker.ts の handleDecode が
// catch した回数）が来たら「持続的な失敗」とみなすか。
// 10fpsのループなので、20回はおよそ2秒間デコードが連続で失敗し続けている
// ことに相当する。1〜2フレームのたまたまの失敗（壊れた1フレームや、
// カメラが暗転した瞬間など）まで過敏に反応しないための余裕を持たせつつ、
// 「ワーカーは生きているが実質使い物にならない」状態を数秒以内には検知できる値。
const ZXING_MAX_CONSECUTIVE_DECODE_ERRORS = 20

// zxing-wasm ワーカーを使う BarcodeReader 実装。id で紐づけた
// Promise ベースのリクエスト / レスポンスとして振る舞う。
// zxing-wasm は ImageData でしか読めないため、<video> / OffscreenCanvas の
// どちらを渡されても、ここで ImageBitmap 化してからワーカーへ転送する
// （呼び出し側は BarcodeReader.detect の入力を意識しなくてよい）。
//
// 堅牢化の詳細（pending管理・タイムアウト・死亡判定・自己回復のトリガー）は
// zxingReaderCore.ts に切り出してある。ここでは「DOM に依存する部分」
// （実際の Worker とのメッセージのやり取り・ImageBitmap 化）だけを行う。
function createZxingReader(worker: Worker, notifications: BarcodeReaderNotifications | undefined): ZxingBarcodeReader {
  const core: ZxingReaderCore = createZxingReaderCore(worker, {
    timeoutMs: ZXING_DETECT_TIMEOUT_MS,
    maxConsecutiveErrors: ZXING_MAX_CONSECUTIVE_DECODE_ERRORS,
    onPersistentFailure: notifications?.onPersistentDecodeFailure,
  })

  worker.addEventListener('message', (event: MessageEvent<ResultMessage>) => {
    const data = event.data
    if (data.type !== 'result') return
    if (data.error) {
      // 以前は data.error を完全に無視しており、デコードが毎フレーム失敗し
      // 続けても呼び出し側（ひいては利用者）は「何も見つからない」としか
      // 見えなかった。開発時に気付けるよう最低限コンソールには出しておく。
      // 連続失敗が持続的なものかどうかの判定・利用者への通知は
      // core.handleResult 内（zxingReaderCore.ts）に集約してある。
      console.warn('[barcode] zxing decode error', data.error)
    }
    core.handleResult(data.id, data.hits, data.error)
  })
  // 以前はこの2つを一切購読しておらず、worker が abort() やブラウザによる
  // OOM kill で応答しなくなっても detect() の Promise が永久に未解決のまま
  // 残ってしまっていた（フレームループの busyRef が true に固定され、以後
  // 全フレームがスキップされ続ける＝「アプリが落ちた」ように見える不具合の
  // 主因）。ここで拾って即座に死亡扱いにする。
  worker.addEventListener('error', () => core.handleWorkerFailure())
  worker.addEventListener('messageerror', () => core.handleWorkerFailure())

  return {
    isDead: () => core.isDead(),
    async detect(input: BarcodeInput): Promise<BarcodeHit[]> {
      // 既に死亡しているなら、ImageBitmap を作る前（＝無駄な確保をする前）に
      // 諦める。ここで確保してしまうと、送り先が無いのに ImageBitmap だけ
      // 生成してしまい、close() し忘れるとリークする。
      if (core.isDead()) return []

      let bitmap: ImageBitmap
      try {
        bitmap = await createImageBitmap(input)
      } catch {
        // createImageBitmap 自体の失敗（極端に大きい入力・メモリ不足など）も
        // 例外を投げず「見つからなかった」として扱う（呼び出し側の規約に合わせる。
        // native.ts の detect() や detectBoxes() と同じ流儀）。
        return []
      }

      // createImageBitmap は非同期（await をまたぐ）ため、その間に worker が
      // 死亡した可能性がある。ここで再確認し、死亡していれば送らずに
      // bitmap.close() で確実に解放する（送れないと分かった ImageBitmap を
      // 抱えたままにしない）。
      if (core.isDead()) {
        bitmap.close()
        return []
      }

      const { id, promise } = core.registerRequest()
      const message: DecodeMessage = { type: 'decode', id, bitmap }
      worker.postMessage(message, [bitmap])
      return promise
    },
    close() {
      core.close()
    },
  }
}

// zxing-wasm ワーカーを新規生成する。wasm 本体・zxing-wasm 一式はここまで
// 遅延させ、初期バンドルには含めない（元からの方針。変更なし）。
function spawnZxingWorker(): Worker {
  return new Worker(new URL('./zxing.worker.ts', import.meta.url), { type: 'module' })
}

// worker を1回でも失うと以後ずっとバーコードが読めなくなる、というのは
// 現場ツールとして最悪の体験になる（QRのデータ量が多いほど wasm ヒープを
// 使い切りやすく、この経路に落ちる確率が最も高い）。そのため、死亡を検知した
// 「次の」detect() 呼び出しで新しい worker を作り直して自己回復させる方式に
// している（＝ BarcodeReader インターフェース自体は変えず、
// useBarcodeScanner.ts 側は一切意識しなくてよい）。
//
// 上限を設ける理由: 端末やブラウザの状態によっては、作り直した直後の worker も
// また同じ理由（恒常的なメモリ不足等）で即座に死ぬ、という状況が起こり得る。
// その場合に際限なく作り直し続けると、Worker 生成・wasm 再ロードのコストで
// CPU/メモリをさらに消耗する「復旧ループ」そのものが新たな負荷源になってしまう。
// 3回までは自動復旧を試み、それでも駄目なら諦めて以後は detect() が常に
// 空配列を返すだけにする（利用者には onWorkerExhausted で1回だけ知らせる）。
const MAX_ZXING_WORKER_REGENERATIONS = 3

async function createFallbackReader(
  notifications?: BarcodeReaderNotifications,
): Promise<{ reader: BarcodeReader; backend: BarcodeBackend }> {
  let regenerations = 0
  let exhaustedNotified = false
  let current = createZxingReader(spawnZxingWorker(), notifications)

  const resilientReader: BarcodeReader = {
    async detect(input: BarcodeInput): Promise<BarcodeHit[]> {
      if (current.isDead()) {
        if (regenerations >= MAX_ZXING_WORKER_REGENERATIONS) {
          if (!exhaustedNotified) {
            exhaustedNotified = true
            notifications?.onWorkerExhausted?.()
          }
          return []
        }
        regenerations += 1
        current = createZxingReader(spawnZxingWorker(), notifications)
      }
      return current.detect(input)
    },
    close() {
      current.close()
    },
  }
  return { reader: resilientReader, backend: 'zxing' }
}

export async function createBarcodeReader(
  notifications?: BarcodeReaderNotifications,
): Promise<{ reader: BarcodeReader; backend: BarcodeBackend }> {
  if (isNativeAvailable()) {
    try {
      const reader = await createNativeReader()
      return { reader, backend: 'native' }
    } catch {
      // ネイティブ実装の生成に失敗した端末は zxing-wasm にフォールバックする
      return createFallbackReader(notifications)
    }
  }
  return createFallbackReader(notifications)
}
