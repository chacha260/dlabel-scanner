// Google ML Kit Text Recognition v2（端末内蔵モデル）による OCR。
// このアプリで唯一の OCR エンジン。以前は tesseract.js（Web Worker 上で動く JS 実装）
// と併存させ、実物の現品票でどちらが実際に読めるかを比較していたが、比較の結果
// ML Kit が圧倒的に高精度だったため tesseract.js は完全に削除し、ML Kit だけを使う
// 方針になった。
//
// 前提: このアプリの APK は INTERNET 権限を持たない（docs/apk.md §7）。ML Kit は
// com.google.mlkit:text-recognition（ビルド時に静的リンクされるモデル）を使うため、
// 通信なしで動作する。このファイルには絶対にネットワーク依存のコードを書かないこと。
//
// @capacitor-mlkit/text-recognition の TextRecognition.processImage() は、
// ローカルファイルパス（file:///...）しか受け付けない（base64 / data URL / canvas は不可。
// node_modules/@capacitor-mlkit/text-recognition/dist/esm/definitions.d.ts で確認済み）。
// そのため ImageData → JPEG Blob → base64 → Filesystem 経由で一時ファイル化 → file:// パス
// 取得、という変換が必要になる。

import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { TextRecognition } from '@capacitor-mlkit/text-recognition'
import type { OcrResult } from './types'

/**
 * この端末で ML Kit が使えるか（= Capacitor のネイティブ環境で動いていて、
 * プラグインが実装されているか）。ブラウザ（pnpm dev / GitHub Pages）では false。
 *
 * Capacitor.isNativePlatform() / isPluginAvailable() は
 * node_modules/.pnpm/@capacitor+core@8.5.1/.../types/definitions.d.ts の
 * CapacitorGlobal インターフェースで確認済み（同期・例外を投げない設計）。
 * プラグイン名は登録時の識別子である 'TextRecognition'
 * （@capacitor-mlkit/text-recognition が registerPlugin に渡す名前）を使う。
 */
export function isMlKitAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('TextRecognition')
}

// ImageData を JPEG 化する際の品質。
// OCR にかける画像なので、圧縮ノイズ（ブロックノイズ）が文字のエッジを潰すと
// 逆効果になる。一方でこのアプリの OCR 入力は preprocess.ts 側で既に
// 「文字行の高さ基準」で数十〜百数十KB程度に縮小済みのグレースケール画像であり、
// 元々の画素数が小さいため、JPEG 品質を多少下げても文字の可読性への影響は小さい。
// PNG ではなく JPEG を選んだのは、Filesystem.writeFile が受け取る base64 文字列を
// できるだけ小さくしたい（Cache ディレクトリへの書き込み・読み出しコストを抑えたい）
// ためで、可逆圧縮の PNG よりも小さくできる。0.92 は「圧縮ノイズによる文字潰れが
// 目視で確認できない上限に近い、高品質側の値」として選んだ。
const JPEG_QUALITY = 0.92

// Cache ディレクトリ配下に一時ファイルをまとめて置くサブディレクトリ名。
// ファイル名自体は連続シャッターで前回のファイルを掴む競合を避けるため、
// 呼び出しごとに crypto.randomUUID() でユニークに生成する
// （Capacitor WebView / 主要ブラウザのいずれでも利用可能）。
const TEMP_FILE_DIR = 'ocr-mlkit-tmp'

function createTempFileName(): string {
  return `${TEMP_FILE_DIR}/${crypto.randomUUID()}.jpg`
}

// ImageData → JPEG Blob。ImageData を直接エンコードできる API は無いため、
// OffscreenCanvas に描画してから convertToBlob で変換する。
async function imageDataToJpegBlob(image: ImageData): Promise<Blob> {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('2D context is not available')
  }
  ctx.putImageData(image, 0, 0)
  return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
}

// Blob → base64 文字列（data URL のプレフィックスを除いた、純粋な base64 のみ）。
//
// data URL のプレフィックスを除去する必要があるかどうかは、Filesystem.writeFile の
// WriteFileOptions.data のコメントで裏を取った
// （node_modules/@capacitor/filesystem/dist/esm/definitions.d.ts）:
//   「If not provided, binary data will be written. For this, you must provide
//    data as base64 encoded, so that the plugin can decode it before writing to disk.」
// つまりネイティブ側は data 文字列全体をそのまま base64 デコードする実装であり、
// 受け取るのは「純粋な base64」で、"data:image/jpeg;base64," のような data URL の
// プレフィックスが混ざっているとデコードに失敗する（プレフィックス部分は base64 の
// 文字集合外の文字 ':' '/' ';' を含む）。そのため FileReader.readAsDataURL() で
// 得られる文字列からプレフィックスを取り除いてから渡す。
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('FileReader の結果が文字列ではありません'))
        return
      }
      // "data:image/jpeg;base64,XXXX" の "," より前を取り除く
      const commaIndex = result.indexOf(',')
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result)
    }
    reader.onerror = () => {
      reject(reader.error ?? new Error('FileReader でエラーが発生しました'))
    }
    reader.readAsDataURL(blob)
  })
}

/**
 * 前処理済みの ImageData を ML Kit で認識する。
 * 失敗した場合は例外を投げてよい（呼び出し側が catch して日本語メッセージを出します）。
 */
export async function recognizeWithMlKit(image: ImageData): Promise<OcrResult> {
  const startedAt = performance.now()
  const tempPath = createTempFileName()

  try {
    const blob = await imageDataToJpegBlob(image)
    const base64 = await blobToBase64(blob)

    // Cache ディレクトリは低メモリ時に端末が自動で消してよい領域であり、
    // このファイルは処理直後に自分で削除する使い捨てなので用途と一致する。
    // recursive: true はサブディレクトリ（TEMP_FILE_DIR）が未作成でも失敗しないため。
    await Filesystem.writeFile({
      path: tempPath,
      data: base64,
      directory: Directory.Cache,
      recursive: true,
    })
    const { uri } = await Filesystem.getUri({ path: tempPath, directory: Directory.Cache })

    // script は省略して既定の Script.Latin を使う。現品票で読むのはほぼ数字・
    // 英数字の品番であり、日本語スクリプト（Script.Japanese）は今回の対象外。
    // blocks（行・要素単位の詳細）は OcrResult の契約上使わない
    // （symbols を空配列にする理由は下記コメントを参照）ため受け取らない。
    const { text } = await TextRecognition.processImage({ path: uri })

    return {
      text: text.trim(),
      // ML Kit は文字ごと・全体としての信頼度スコアを一切返さない
      // （TextElement / TextLine / TextBlock のいずれにも confidence フィールドがない。
      // definitions.d.ts で確認済み）。ここでの 0 は「信頼度が低い」という意味では
      // なく「信頼度という情報そのものが無い」ことを表す値であり、tesseract.js の
      // confidence（0〜100 のスコア）とは意味が異なる。UI 側でこの 0 を
      // 「信頼度ゼロ＝怪しい」と解釈しないよう扱いを分けること。
      confidence: 0,
      ms: Math.round(performance.now() - startedAt),
    }
  } finally {
    // 認識が成功しても失敗しても一時ファイルは必ず削除する。シャッターを押すたびに
    // Cache 領域にファイルが溜まり続けるのを避けるため。削除自体が失敗しても
    // （ファイルが既に無い等）、認識結果は返せるようにここでは例外を握りつぶす。
    try {
      await Filesystem.deleteFile({ path: tempPath, directory: Directory.Cache })
    } catch {
      // 無視してよい（次回以降 recursive: true の writeFile が上書きするか、
      // OS 側の Cache 掃除に任せる）
    }
  }
}
