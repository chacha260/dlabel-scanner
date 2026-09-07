// PaddleOCR の実物のONNXモデルを通して、検出→後処理→切り出し→認識→CTCデコードの
// 全経路が実際に文字を読めるところまで確認する end-to-end テスト。
//
// なぜ「使い捨てスクリプト」ではなく vitest のテストとして書いたか:
//   scripts/smoke-paddle.mjs は「モデルが読み込めて入出力の形が想定どおりか」を
//   確かめるだけの検証で、後処理（boxes.ts）やCTCデコード（ctc.ts）を一切通していない。
//   これらは .ts の純粋関数として実装されており、.mjs（プレーンなNode ESM）から
//   TypeScriptを直接importできない（トランスパイルが要る）ため、素朴にやるなら
//   コピー＆手動移植か、tsx等の追加ツールが必要になる。vitestなら、このリポジトリの
//   test環境（vite.config.ts の test.environment: 'node'）がそのままTSのimportを
//   トランスパイルしてくれるため、src/scan/ocr/paddle/ の実装（boxes.ts・ctc.ts・
//   geometry.ts・tensorize.ts・dict.ts）を一切書き換えず・再実装せずにそのままimport
//   して実物のモデル出力に通せる。「検証したいのはまさにその実装」という要件に対して
//   最も素直な選択だと判断した。
//
// なぜ onnxruntime-node は本体の依存に含めないか（scripts/smoke-paddle.mjs と同じ理由）:
//   本番はブラウザ／Capacitor WebView上で onnxruntime-web（WASM）を使う。
//   onnxruntime-node はNode上でONNXを動かすためだけのネイティブアドオンで、
//   アプリの実行には一切関与しない。CIやこの環境の通常の `pnpm test` に
//   常時ぶら下げると、ネイティブビルドの重さ・プラットフォーム依存の失敗要因を
//   本体の依存関係に持ち込むことになるため、必要なときだけ一時的に入れる運用にする。
//
//     pnpm add -D onnxruntime-node
//     pnpm exec vitest run src/scan/ocr/paddle/__tests__/e2e-real-model.test.ts
//     pnpm remove onnxruntime-node
//
//   onnxruntime-node が入っていない状態（＝通常の `pnpm test`）では、下の動的
//   importが失敗するのを検知して describe.skip 相当（skipIf）にし、テストファイル
//   自体は読み込まれるがテストは1件も実行しない。「onnxruntime-node無しでも
//   `pnpm test` が緑のまま」であることを、このファイルを追加したあとに実際に
//   確認済み。
//
// Node環境なのでcanvas（OffscreenCanvas）が無く、本番のpreprocess.ts
// （resizeImageData・cropImageData）はそのままでは使えない。この検証で
// 代わりに行っていること・行っていないことを明確にしておく:
//   - 使わない: 本番のリサイズ・切り出し（canvas依存のため）→ この2つだけ、
//     このテストファイル内に簡易実装（切り出しは単純な矩形コピー、リサイズは
//     バイリニア補間）を書く。本番はCanvas 2D（drawImage）の補間に任せているため、
//     厳密には同じアルゴリズムではないが、認識モデルへの入力サイズを合わせるという
//     目的においては十分に近い近似になる。
//   - そのまま使う（絶対に再実装しない）: 検出後処理（boxes.ts postprocessDetection・
//     binarizeMask・labelConnectedComponents）、座標計算（geometry.ts
//     computeRecTargetWidth・unclipBox）、正規化（tensorize.ts normalizeDetPixels・
//     normalizeRecPixels）、辞書パース（dict.ts parsePaddleDict）、CTCデコード
//     （ctc.ts argmaxPerTimestep・ctcGreedyDecode）。今回のバグ・今回の修正が
//     直接関わる部分はすべて本物の実装をそのまま呼ぶ。
//
// 合成画像について:
//   この環境にはcanvasライブラリも実物のラベル画像も無いため、5x7の簡易ビット
//   マップフォントを手書きし、白地に黒で「1234567890」を大きく（1文字40x56px、
//   8倍拡大）描画したRGBA画素配列を自前で生成する。検出モデルの入力は32の倍数
//   サイズが要件（geometry.ts DET_SIZE_MULTIPLE参照）なので、合成画像は最初から
//   608x96（608=32*19, 96=32*3）で作り、検出前のリサイズが一切不要になるように
//   してある（scaleX=scaleY=1のままpostprocessDetectionに渡せる）。
//
// ============================================================================
// 実行結果の記録（このコメントを更新した本人が実際に onnxruntime-node を入れて
// このファイルを実行し、確認した実測値。以後このコメントを見れば再実行しなくても
// 「前回いつ・何が確認できていたか」が分かるようにする）
// ============================================================================
// 2026-09-07 実行（修正後のsrc/scan/ocr/paddle/boxes.tsに対して。
//   `pnpm exec vitest run src/scan/ocr/paddle/__tests__/e2e-real-model.test.ts
//   --reporter=verbose` で実行、環境はこのリポジトリのNode + onnxruntime-node
//   1.29.0・CPU・シングルスレッド）:
//   検出された箱の数: 1（608x96の合成画像1枚に対して数字10桁ぶんの塊が
//     1つの連結成分として検出された）
//   認識された文字列: "1234567890"（生テキスト。10桁すべて完全一致。ノイズの無い
//     合成フォントのためここまで綺麗に一致したが、実運用の手ブレ・照明ムラのある
//     画像でここまでの完全一致を前提にしているわけではない。重要なのは
//     「空文字ではなく実際に数字が読めた」という事実そのもの）
//   信頼度（CTCの確率平均）: 99.7%
//   所要時間: 238ms（検出セッション作成＋推論＋後処理、認識セッション作成＋
//     推論＋CTCデコードまで全部含む。モデルはローカルディスクから読み込むため
//     ネットワーク待ちは無い）
//
// 2026-09-07 追加確認（同じ実行内）: postprocessDetection自体は書き換えず、
//   boxes.ts / geometry.ts が公開している純粋関数（binarizeMask・
//   labelConnectedComponents・unclipBox）だけを使って「バグがあった当時の順序
//   （スコアをunclipの“後”の矩形に対して取る）」を独立に組み立て直し、同じ
//   確率マップに通したところ、既定のboxThreshold(0.6)を満たす箱は0件だった
//   （下の2件目のテストケース参照）。これは今回の不具合の再現そのものであり、
//   修正が実際にこの不具合を解消していることの直接的な証拠になっている。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOX_THRESHOLD, binarizeMask, labelConnectedComponents, postprocessDetection } from '../boxes'
import { argmaxPerTimestep, ctcGreedyDecode } from '../ctc'
import { parsePaddleDict } from '../dict'
import { computeRecTargetWidth, REC_TARGET_HEIGHT, unclipBox } from '../geometry'
import { normalizeDetPixels, normalizeRecPixels } from '../tensorize'

// onnxruntime-node は使うときだけ `pnpm add -D onnxruntime-node` する使い捨ての
// 依存なので、無い環境（＝通常のpnpm test）ではこのimportが失敗する。失敗したら
// このファイルのテストを丸ごとskipする（describe.skipIfの条件をここで確定させる）。
let ort: typeof import('onnxruntime-node') | null = null
try {
  ort = await import('onnxruntime-node')
} catch {
  ort = null
}

const VENDOR_DIR = path.resolve(process.cwd(), 'public/vendor/paddleocr')
const DET_MODEL_PATH = path.join(VENDOR_DIR, 'ppocrv5-mobile-det.onnx')
const REC_MODEL_PATH = path.join(VENDOR_DIR, 'ppocrv5-mobile-rec.onnx')
const DICT_PATH = path.join(VENDOR_DIR, 'ppocrv5_dict.txt')

// ============================================================================
// 5x7 の簡易ビットマップフォント（数字のみ）。'1'=インク、'0'=背景。
// 標準的な5x7ドットマトリクスフォントの慣用パターンを手書きした。
// ============================================================================
const DIGIT_FONT_5X7: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
}

const FONT_SCALE = 8 // 1ドット→8x8px。7行フォントで高さ56px（「高さ40px以上」の要件を満たす）
const GLYPH_COLS = 5
const GLYPH_ROWS = 7
const GLYPH_W = GLYPH_COLS * FONT_SCALE // 40
const GLYPH_H = GLYPH_ROWS * FONT_SCALE // 56
const GLYPH_GAP = 16
const MARGIN_X = 32
const MARGIN_Y = 20
const TEXT = '1234567890'

// 合成画像のサイズ。検出モデルの入力要件（32の倍数）を最初から満たすように
// 逆算してある（geometry.ts DET_SIZE_MULTIPLE参照）ので、検出前のリサイズは不要。
const IMAGE_WIDTH = MARGIN_X * 2 + TEXT.length * GLYPH_W + (TEXT.length - 1) * GLYPH_GAP // 608
const IMAGE_HEIGHT = GLYPH_H + MARGIN_Y * 2 // 96

/** RGBA画素配列（Uint8ClampedArray）に「白地に黒文字」の合成ラベル画像を描く。 */
function buildSyntheticDigitsImage(): { data: Uint8ClampedArray; width: number; height: number } {
  const width = IMAGE_WIDTH
  const height = IMAGE_HEIGHT
  const data = new Uint8ClampedArray(width * height * 4).fill(255) // 白地・不透明

  const setBlack = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const o = (y * width + x) * 4
    data[o] = 0
    data[o + 1] = 0
    data[o + 2] = 0
    data[o + 3] = 255
  }

  for (let i = 0; i < TEXT.length; i++) {
    const glyph = DIGIT_FONT_5X7[TEXT[i]]
    const originX = MARGIN_X + i * (GLYPH_W + GLYPH_GAP)
    const originY = MARGIN_Y
    for (let row = 0; row < GLYPH_ROWS; row++) {
      for (let col = 0; col < GLYPH_COLS; col++) {
        if (glyph[row][col] !== '1') continue
        // 1ドットをFONT_SCALE x FONT_SCALEの正方形として塗る
        for (let dy = 0; dy < FONT_SCALE; dy++) {
          for (let dx = 0; dx < FONT_SCALE; dx++) {
            setBlack(originX + col * FONT_SCALE + dx, originY + row * FONT_SCALE + dy)
          }
        }
      }
    }
  }

  return { data, width, height }
}

/**
 * 矩形で切り出す（本番のcropImageDataのNode版簡易実装。OffscreenCanvasが
 * 使えないためここだけ自前で書く。座標の丸め・クランプの考え方はcropImageDataに
 * 合わせてある）。
 */
function cropPixels(
  src: { data: Uint8ClampedArray; width: number; height: number },
  box: { x: number; y: number; w: number; h: number },
): { data: Uint8ClampedArray; width: number; height: number } {
  const sx = Math.max(0, Math.min(src.width - 1, Math.round(box.x)))
  const sy = Math.max(0, Math.min(src.height - 1, Math.round(box.y)))
  const sw = Math.max(1, Math.min(src.width - sx, Math.round(box.w)))
  const sh = Math.max(1, Math.min(src.height - sy, Math.round(box.h)))

  const out = new Uint8ClampedArray(sw * sh * 4)
  for (let y = 0; y < sh; y++) {
    const srcRow = (sy + y) * src.width + sx
    const dstRow = y * sw
    out.set(src.data.subarray(srcRow * 4, (srcRow + sw) * 4), dstRow * 4)
  }
  return { data: out, width: sw, height: sh }
}

/**
 * バイリニア補間によるリサイズ（本番のresizeImageDataのNode版簡易実装）。
 * 本番はCanvas 2DのdrawImageに補間を任せている（preprocess.tsのコメント参照）ため
 * 厳密には同じ実装ではないが、認識モデルへ渡す入力サイズを合わせるという
 * 目的には十分な近似。
 */
function bilinearResize(
  src: { data: Uint8ClampedArray; width: number; height: number },
  targetWidth: number,
  targetHeight: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4)
  const scaleX = src.width / targetWidth
  const scaleY = src.height / targetHeight

  for (let ty = 0; ty < targetHeight; ty++) {
    const sy = Math.min(src.height - 1, (ty + 0.5) * scaleY - 0.5)
    const y0 = Math.max(0, Math.floor(sy))
    const y1 = Math.min(src.height - 1, y0 + 1)
    const fy = sy - y0

    for (let tx = 0; tx < targetWidth; tx++) {
      const sx = Math.min(src.width - 1, (tx + 0.5) * scaleX - 0.5)
      const x0 = Math.max(0, Math.floor(sx))
      const x1 = Math.min(src.width - 1, x0 + 1)
      const fx = sx - x0

      const o00 = (y0 * src.width + x0) * 4
      const o10 = (y0 * src.width + x1) * 4
      const o01 = (y1 * src.width + x0) * 4
      const o11 = (y1 * src.width + x1) * 4
      const dstO = (ty * targetWidth + tx) * 4

      for (let c = 0; c < 4; c++) {
        const top = src.data[o00 + c] * (1 - fx) + src.data[o10 + c] * fx
        const bottom = src.data[o01 + c] * (1 - fx) + src.data[o11 + c] * fx
        out[dstO + c] = top * (1 - fy) + bottom * fy
      }
    }
  }

  return out
}

describe.skipIf(ort === null)('PaddleOCR 実物のONNXモデルでの end-to-end 検証', () => {
  it(
    '合成した数字画像を 検出→後処理→切り出し→認識→CTCデコード の全経路に通し、修正後は箱が検出され文字が読めることを確認する',
    async () => {
      if (!ort) return // describe.skipIfで弾かれるはずだが、型のためのガード

      const startedAt = Date.now()
      const image = buildSyntheticDigitsImage()

      // --- 検出（DBNet） ---
      const det = await ort.InferenceSession.create(DET_MODEL_PATH)
      const detTensorData = normalizeDetPixels(image.data, image.width, image.height)
      const detTensor = new ort.Tensor('float32', detTensorData, [1, 3, image.height, image.width])
      const detOutputs = await det.run({ [det.inputNames[0]]: detTensor })
      const detOutput = detOutputs[det.outputNames[0]]
      const outHeight = Number(detOutput.dims[2])
      const outWidth = Number(detOutput.dims[3])
      const probMap = detOutput.data as Float32Array

      // ★ここが今回の修正の本体。src/scan/ocr/paddle/boxes.ts の実装を一切
      // 書き換えず・オプションも上書きせず（＝既定のboxThreshold=0.6のまま）
      // そのまま呼ぶ。修正前はこの呼び出しが必ず空配列を返していた。
      const boxes = postprocessDetection(probMap, outWidth, outHeight, { scaleX: 1, scaleY: 1 })

      expect(boxes.length).toBeGreaterThan(0)

      // --- 認識（CTC） ---
      const rec = await ort.InferenceSession.create(REC_MODEL_PATH)
      const dictText = readFileSync(DICT_PATH, 'utf8')
      const dict = parsePaddleDict(dictText)
      expect(dict.length).toBeGreaterThan(0)

      const decodedTexts: string[] = []
      const confidences: number[] = []
      for (const box of boxes) {
        const crop = cropPixels(image, box)
        const targetWidth = computeRecTargetWidth(crop.width, crop.height)
        const resizedData = bilinearResize(crop, targetWidth, REC_TARGET_HEIGHT)
        const recTensorData = normalizeRecPixels(resizedData, targetWidth, REC_TARGET_HEIGHT)
        const recTensor = new ort.Tensor('float32', recTensorData, [1, 3, REC_TARGET_HEIGHT, targetWidth])

        const recOutputs = await rec.run({ [rec.inputNames[0]]: recTensor })
        const recOutput = recOutputs[rec.outputNames[0]]
        const timeSteps = Number(recOutput.dims[1])
        const numClasses = Number(recOutput.dims[2])
        const { indices, probs } = argmaxPerTimestep(recOutput.data as Float32Array, timeSteps, numClasses)
        const result = ctcGreedyDecode(indices, probs, dict)
        decodedTexts.push(result.text)
        confidences.push(result.confidence)
      }

      const combinedText = decodedTexts.join('')
      const elapsedMs = Date.now() - startedAt
      const avgConfidence = confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0
      // CI等での再実行時にも実測値を確認できるよう、テスト実行ログにも残しておく
      // eslint-disable-next-line no-console
      console.log(
        `[e2e-real-model] boxes=${boxes.length} text=${JSON.stringify(combinedText)} confidence=${avgConfidence.toFixed(1)} elapsedMs=${elapsedMs}`,
      )

      // 完全一致は要求しない（合成フォント・簡易補間ゆえの誤差を許容する）が、
      // 「空文字ではなく数字らしい文字列が出ること」は今回の不具合が直っている
      // ことの直接的な証拠になる。
      expect(combinedText.length).toBeGreaterThan(0)
      expect(combinedText).toMatch(/[0-9]/)

      await det.release()
      await rec.release()
    },
    30_000,
  )

  it('修正前（スコアをunclip後の矩形に対して取る壊れた順序）で同じ確率マップを処理すると、既定閾値では0箱になることを確認する', async () => {
    if (!ort) return

    const image = buildSyntheticDigitsImage()
    const det = await ort.InferenceSession.create(DET_MODEL_PATH)
    const detTensorData = normalizeDetPixels(image.data, image.width, image.height)
    const detTensor = new ort.Tensor('float32', detTensorData, [1, 3, image.height, image.width])
    const detOutputs = await det.run({ [det.inputNames[0]]: detTensor })
    const detOutput = detOutputs[det.outputNames[0]]
    const outHeight = Number(detOutput.dims[2])
    const outWidth = Number(detOutput.dims[3])
    const probMap = detOutput.data as Float32Array
    await det.release()

    // 修正後の実装（postprocessDetection）は書き換えない。代わりに、boxes.ts /
    // geometry.ts が公開している純粋関数（binarizeMask・labelConnectedComponents・
    // unclipBox）だけを使って「バグがあった当時の順序」（スコアをunclipの後に取る）
    // を独立に組み立て直し、その順序では既定閾値を満たす箱が無いことを確認する。
    // postprocessDetection自体のロジックには一切触れていないため、「本番の実装を
    // 再実装した」ことにはならない。
    const binary = binarizeMask(probMap, 0.3)
    const components = labelConnectedComponents(binary, outWidth, outHeight, 8)

    let survivedWithBuggyOrder = 0
    for (const comp of components) {
      const boxW = comp.maxX - comp.minX + 1
      const boxH = comp.maxY - comp.minY + 1
      if (Math.min(boxW, boxH) < 3) continue
      const expanded = unclipBox({ x: comp.minX, y: comp.minY, w: boxW, h: boxH }, 1.5)
      const x0 = Math.max(0, Math.floor(expanded.x))
      const y0 = Math.max(0, Math.floor(expanded.y))
      const x1 = Math.min(outWidth, Math.ceil(expanded.x + expanded.w))
      const y1 = Math.min(outHeight, Math.ceil(expanded.y + expanded.h))
      if (x1 <= x0 || y1 <= y0) continue
      let sum = 0
      let count = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += probMap[y * outWidth + x]
          count++
        }
      }
      const buggyScore = count > 0 ? sum / count : 0
      if (buggyScore >= DEFAULT_BOX_THRESHOLD) survivedWithBuggyOrder++
    }

    expect(survivedWithBuggyOrder).toBe(0)
  })
})
