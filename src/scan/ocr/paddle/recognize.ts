// 認識（CTC）フェーズのグルー: 検出枠の切り出し→リサイズ・正規化→ONNX推論→
// CTC greedy デコード（ctc.ts）を1つの関数にまとめる。
//
// バッチ化について（複数の箱をまとめて1回の推論にするか、1箱ずつ呼ぶか）:
// ここでは1箱ずつ推論する方式を選んだ。バッチ化するには、バッチ内で最大幅の
// 箱に合わせて他の箱をゼロ埋めし、さらに実際の有効幅をどこかに保持して
// デコード時にパディング部分の出力を無視する、という付加的な仕組みが必要になる。
// PaddleOCRは「高精度・低速のフォールバック」という位置づけで、既定のML Kitより
// 遅いこと自体は許容されており、かつWASM実行はもとよりシングルスレッド
// （numThreads=1。session.ts参照）でしか動かせないため、バッチ化で得られる
// 速度向上も限定的。実装の単純さ・パディング起因のバグを避けられることを優先し、
// 1箱ずつ呼び出すシンプルな実装にした。
import * as ort from 'onnxruntime-web/wasm'
import type { CtcDecodeResult } from './ctc'
import { argmaxPerTimestep, ctcGreedyDecode } from './ctc'
import type { AxisAlignedBox } from './geometry'
import { computeRecTargetWidth, REC_TARGET_HEIGHT } from './geometry'
import { cropImageData, resizeImageData } from './preprocess'
import { getPaddleSessionOrThrow } from './session'
import { normalizeRecPixels } from './tensorize'

// 認識モデルの入出力名。ONNXの実物（protobuf）をパースして確認済み。
const REC_INPUT_NAME = 'x'
const REC_OUTPUT_NAME = 'fetch_name_0'

/**
 * 元画像から1つの検出枠を切り出し、認識モデルにかけて文字列と信頼度を得る。
 */
export async function recognizeBox(originalImage: ImageData, box: AxisAlignedBox): Promise<CtcDecodeResult> {
  const { rec, dict } = getPaddleSessionOrThrow()

  const crop = cropImageData(originalImage, box)
  const targetWidth = computeRecTargetWidth(crop.width, crop.height)
  const resized = resizeImageData(crop, targetWidth, REC_TARGET_HEIGHT)
  const tensorData = normalizeRecPixels(resized.data, targetWidth, REC_TARGET_HEIGHT)
  const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, REC_TARGET_HEIGHT, targetWidth])

  const outputs = await rec.run({ [REC_INPUT_NAME]: inputTensor })
  const output = outputs[REC_OUTPUT_NAME]
  if (!output) {
    throw new Error('PaddleOCR認識モデルの出力が取得できませんでした（出力名が想定と異なる可能性があります）')
  }

  // 出力shapeは[N,T,C]。Tは「入力幅/8」になるはずだが（コーディネーターが
  // onnxruntime-nodeで実測済み）、推測に頼らず実際の出力shapeから読み取る。
  const timeSteps = Number(output.dims[1])
  const numClasses = Number(output.dims[2])
  const { indices, probs } = argmaxPerTimestep(output.data as Float32Array, timeSteps, numClasses)

  return ctcGreedyDecode(indices, probs, dict)
}
