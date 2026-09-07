// PaddleOCR の ONNX モデルが「実際に読み込めて推論が通るか」を Node 上で確かめる
// 使い捨ての検証スクリプト。アプリの実行には一切関与しない。
//
// なぜこれが要るのか: このリポジトリの開発環境には Android 実機も無く、
// ブラウザでの動作確認もできない。PaddleOCR 経路は onnxruntime-web（WASM）で
// 動くため本番と実行環境は違うが、「モデルファイルが壊れていないか」
// 「入出力の名前と形が想定どおりか」「CTC のクラス数と辞書の行数が対応するか」
// といった、実装の前提になる部分だけは Node からでも確かめられる。
// 前提が崩れていることに実機で初めて気づく、という事態を避けるためのもの。
//
// 実行方法（onnxruntime-node は本体の依存ではないので、必要なときだけ入れる）:
//   pnpm add -D onnxruntime-node
//   node scripts/smoke-paddle.mjs
//   pnpm remove onnxruntime-node
//
// 2026-09-04 時点の実行結果（この値を前提に src/scan/ocr/paddle/ を実装している）:
//   DET  入力 x [1,3,320,320] → 出力 fetch_name_0 [1,1,320,320]
//        ＝確率マップは入力と同じ解像度（ダウンサンプリングされない）
//   REC  入力 x [1,3,48,320]  → 出力 fetch_name_0 [1,40,18385]
//        ＝タイムステップ T は入力幅 W の 1/8 ちょうど
//   DICT 18383行 → 1(blank) + 18383 + 1(space) = 18385 でクラス数と一致

import ort from 'onnxruntime-node'
const B = '/home/sosi/app/dlabel-scanner/public/vendor/paddleocr/'

function fill(n, v = 0.1) { const a = new Float32Array(n); a.fill(v); return a }

// --- 検出モデル: 32の倍数のサイズで通す ---
{
  const s = await ort.InferenceSession.create(B + 'ppocrv5-mobile-det.onnx')
  console.log('DET inputs :', s.inputNames, ' outputs:', s.outputNames)
  const H = 320, W = 320
  const t = new ort.Tensor('float32', fill(1 * 3 * H * W), [1, 3, H, W])
  const out = await s.run({ [s.inputNames[0]]: t })
  const o = out[s.outputNames[0]]
  console.log('DET out dims:', o.dims, 'type:', o.type, 'sample:', o.data[0].toFixed(5))
}

// --- 認識モデル: 高さ48固定 ---
{
  const s = await ort.InferenceSession.create(B + 'ppocrv5-mobile-rec.onnx')
  console.log('REC inputs :', s.inputNames, ' outputs:', s.outputNames)
  const W = 320
  const t = new ort.Tensor('float32', fill(1 * 3 * 48 * W), [1, 3, 48, W])
  const out = await s.run({ [s.inputNames[0]]: t })
  const o = out[s.outputNames[0]]
  console.log('REC out dims:', o.dims, 'type:', o.type)
  const [, T, C] = o.dims
  console.log(`  -> timesteps T=${T} for W=${W} (W/T = ${(W/T).toFixed(2)}), classes C=${C}`)
  // 1タイムステップ目の argmax
  let best = 0, bi = 0
  for (let c = 0; c < C; c++) if (o.data[c] > best) { best = o.data[c]; bi = c }
  console.log('  -> t0 argmax idx', bi, 'prob', best.toFixed(4))
}

// --- 辞書の行数とクラス数の対応 ---
const fs = await import('node:fs')
const dict = fs.readFileSync(B + 'ppocrv5_dict.txt', 'utf8').split('\n')
const nonEmptyTrailing = dict[dict.length - 1] === '' ? dict.length - 1 : dict.length
console.log(`DICT lines (excluding trailing empty): ${nonEmptyTrailing}`)
console.log(`  1(blank) + ${nonEmptyTrailing} + 1(space) = ${1 + nonEmptyTrailing + 1}`)
