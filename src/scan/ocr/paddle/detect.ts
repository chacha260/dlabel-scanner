// 検出（DBNet）フェーズのグルー: 前処理（リサイズ・正規化）→ONNX推論→
// 後処理（boxes.ts）を1つの関数にまとめる。ONNXへの入出力の取り回しだけを
// ここで行い、アルゴリズムそのもの（サイズ計算・正規化・二値化・連結成分・
// unclip・スコアリング）はすべて純粋関数（geometry.ts / tensorize.ts / boxes.ts）
// に委譲する。
import * as ort from 'onnxruntime-web/wasm'
import type { DetBox } from './boxes'
import { postprocessDetection } from './boxes'
import { computeDetResize } from './geometry'
import { resizeImageData } from './preprocess'
import { getPaddleSessionOrThrow } from './session'
import { normalizeDetPixels } from './tensorize'

// 検出モデルの入出力名。ONNXの実物（protobuf）をパースして確認済み。
const DET_INPUT_NAME = 'x'
const DET_OUTPUT_NAME = 'fetch_name_0'

/**
 * 元画像（前処理をしていない、そのままの解像度のImageData）から、文字が
 * ありそうな矩形（元画像のピクセル座標）を検出する。
 */
export async function detectTextBoxes(image: ImageData): Promise<DetBox[]> {
  const { det } = getPaddleSessionOrThrow()

  const { width, height, scaleX, scaleY } = computeDetResize(image.width, image.height)
  const resized = resizeImageData(image, width, height)
  const tensorData = normalizeDetPixels(resized.data, width, height)
  const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, height, width])

  const outputs = await det.run({ [DET_INPUT_NAME]: inputTensor })
  const output = outputs[DET_OUTPUT_NAME]
  if (!output) {
    throw new Error('PaddleOCR検出モデルの出力が取得できませんでした（出力名が想定と異なる可能性があります）')
  }

  // 出力shapeは[N,1,H,W]。実測により、このモデルはダウンサンプリングを
  // 行わずH・Wとも入力と同じ解像度で返す（コーディネーターがonnxruntime-nodeで
  // 実測して確認済み）ため、ここでのH・Wをそのままマップ座標として後処理に渡す
  // （推測で1/4スケール等の補正を入れない）。
  const outHeight = Number(output.dims[2])
  const outWidth = Number(output.dims[3])
  const probMap = output.data as Float32Array

  return postprocessDetection(probMap, outWidth, outHeight, { scaleX, scaleY })
}
