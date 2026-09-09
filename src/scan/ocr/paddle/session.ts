// PaddleOCR (PP-OCRv5 mobile) の ONNX Runtime Web セッション管理。
//
// onnxruntime-web / fetch に触れる「薄いグルー」はこのファイルに閉じ込め、
// アルゴリズム部分（CTCデコード・連結成分・矩形拡張・リサイズ計算・正規化）は
// すべて同じディレクトリの純粋関数（ctc.ts / boxes.ts / geometry.ts /
// tensorize.ts）に切り出してあり、そちらはNode環境のVitestでテストできる。
//
// 'onnxruntime-web/wasm' を選ぶ理由:
// パッケージの exports マップ（node_modules/onnxruntime-web/package.json）を
// 確認したところ、既定の '.'（'onnxruntime-web'）は webgl・webgpu も含んだ
// フルバンドル（ort.bundle.min.mjs）を読み込む。このアプリはCSPで
// wasm-unsafe-eval 以外の実行系を許可しておらず、executionProviders も
// ['wasm'] だけを使うため、wasmバックエンドのみを含む軽量ビルド
// （ort.wasm.bundle.min.mjs）を明示的に指す './wasm' サブパスを使う。
//
// wasmPaths のファイル名について:
// このビルド（jsep/asyncify/jspiのいずれでもない「default build」）が要求する
// wasmランタイムのファイル名は、onnxruntime-common の型定義コメントに明記の
// とおり `ort-wasm-simd-threaded.wasm` / `ort-wasm-simd-threaded.mjs` で固定。
// これはコーディネーターが public/vendor/onnxruntime/ に配置済みのファイル名と
// 一致している（配置済みファイルを変更しないこと。ここではそのファイル名を
// 前提にURLプレフィックスだけを指定する）。
import * as ort from 'onnxruntime-web/wasm'
import type { InferenceSession } from 'onnxruntime-web/wasm'
import { parsePaddleDict } from './dict'

// このアプリの静的アセット配信ベース（GitHub Pagesのサブパス配信・APK同梱の
// どちらでも正しく解決できるよう、import.meta.env.BASE_URLを基準にする。
// 旧 ocr.worker.ts のvendorUrl相当の考え方 — tesseract.js削除時にocr.worker.ts
// 自体は無くなったが、「vendor配下のファイルはBASE_URL基準で参照する」という
// 方針そのものはこのアプリの一貫した流儀としてvite.config.tsのコメントにも
// 引き継がれている）。
const VENDOR_ONNXRUNTIME_BASE = `${import.meta.env.BASE_URL}vendor/onnxruntime/`
const VENDOR_PADDLEOCR_BASE = `${import.meta.env.BASE_URL}vendor/paddleocr/`

const DET_MODEL_URL = `${VENDOR_PADDLEOCR_BASE}ppocrv5-mobile-det.onnx`
const REC_MODEL_URL = `${VENDOR_PADDLEOCR_BASE}ppocrv5-mobile-rec.onnx`
const DICT_URL = `${VENDOR_PADDLEOCR_BASE}ppocrv5_dict.txt`

// wasmPaths・numThreadsなどのグローバル設定は、最初にセッションを作る前に
// 一度だけ行えばよい。preparePaddle()を複数回呼んでも二重に設定しないための
// フラグ（副作用の重複自体は害はないが、意図を明確にするため）。
let envConfigured = false

function configureOrtEnv(): void {
  if (envConfigured) return
  envConfigured = true

  // CSPのconnect-srcは'self'のみ（index.html参照）で、CDNからの取得は
  // 確実にブロックされる。onnxruntime-webの既定動作（unpkg等のCDNから
  // wasmを取得しようとする）を必ず上書きし、自前配信のローカルパスを指す。
  ort.env.wasm.wasmPaths = VENDOR_ONNXRUNTIME_BASE

  // マルチスレッド版のwasmはSharedArrayBufferを使うが、これを有効化するには
  // クロスオリジン分離（COOP/COEPヘッダ）が必要になる。ところがこのアプリは
  // GitHub Pages（静的ホスティングでレスポンスヘッダを制御できない）と
  // Capacitorの WebView（アプリ側でHTTPレスポンスヘッダを一切制御できない）
  // の2箇所にしか配信されず、どちらもこのヘッダを設定できない。
  // numThreads=1にすると、ONNX Runtime WebはWorkerスレッドを一切生成せず
  // メインスレッド（正確にはこの処理を呼んだスレッド）だけで完結するため、
  // COOP/COEPが無い環境でも確実に動く（型定義のコメントにも
  // 「1に設定するとworker threadを生成しない」と明記されている）。
  ort.env.wasm.numThreads = 1
}

const SESSION_OPTIONS: InferenceSession.SessionOptions = {
  executionProviders: ['wasm'],
}

type PaddleSession = {
  det: InferenceSession
  rec: InferenceSession
  dict: string[]
}

let session: PaddleSession | null = null
let loadingPromise: Promise<PaddleSession> | null = null

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`${url} の取得に失敗しました（HTTP ${res.status}）`)
  }
  return res.text()
}

async function loadSession(onProgress?: (status: string) => void): Promise<PaddleSession> {
  configureOrtEnv()

  onProgress?.('辞書を読み込み中...')
  const dictText = await fetchText(DICT_URL)
  const dict = parsePaddleDict(dictText)
  if (dict.length === 0) {
    throw new Error('PaddleOCRの辞書ファイル（ppocrv5_dict.txt）が空か、読み込みに失敗しました')
  }

  onProgress?.('検出モデルを読み込み中...（初回のみ時間がかかります）')
  const det = await ort.InferenceSession.create(DET_MODEL_URL, SESSION_OPTIONS)

  onProgress?.('認識モデルを読み込み中...（初回のみ時間がかかります）')
  const rec = await ort.InferenceSession.create(REC_MODEL_URL, SESSION_OPTIONS)

  return { det, rec, dict }
}

/** モデル・wasmを読み込み済みか（UIで「初回は時間がかかる」案内を出すため）。 */
export function isPaddleReady(): boolean {
  return session !== null
}

/**
 * ONNXセッションを準備する。重い（モデル21MB + wasm14MB）ので、エンジンを
 * 選んだ時点で先に呼べるようにしておく。
 *
 * 失敗してもrejectせず{ ok: false, error }を返す（呼び出し側がvoidで
 * 呼び捨てにするため。仕様として明示的に非rejectが指定されている）。
 * 失敗した場合はloadingPromiseをクリアし、次回の呼び出しで再度読み込みを
 * 試みられるようにする（一時的なネットワーク不調などから回復できるように）。
 */
export async function preparePaddle(
  onProgress?: (status: string) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (session) return { ok: true }

  try {
    if (!loadingPromise) {
      loadingPromise = loadSession(onProgress)
    }
    session = await loadingPromise
    return { ok: true }
  } catch (e) {
    loadingPromise = null
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `PaddleOCRの読み込みに失敗しました: ${message}` }
  }
}

/**
 * 準備済みのセッションを取得する。未準備の場合は例外を投げる
 * （detect.ts / recognize.ts から使う内部ヘルパー。この関数自体は
 * paddle/index.tsの公開APIからは呼ばれない）。
 */
export function getPaddleSessionOrThrow(): PaddleSession {
  if (!session) {
    throw new Error('PaddleOCRが初期化されていません。先にpreparePaddle()を呼び出してください')
  }
  return session
}

// 以前はここに、セッションを破棄してメモリを解放する disposePaddle() があったが、
// 呼び出し元がどこにも無かった（このアプリはOCRエンジンを一度読み込んだら
// 画面を閉じるまで保持し続ける設計で、途中で明示的に解放する場面が無い）ため、
// 利用者の判断で削除した。セッション解放自体が将来必要になった場合は、
// git 履歴から `current.det.release()` / `current.rec.release()` を呼ぶ実装を
// 復元できる。
