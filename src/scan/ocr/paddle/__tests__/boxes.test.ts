import { describe, expect, it } from 'vitest'
import { binarizeMask, labelConnectedComponents, postprocessDetection } from '../boxes'

describe('binarizeMask', () => {
  it('閾値以上を1、未満を0にする', () => {
    const out = binarizeMask([0.1, 0.3, 0.29, 0.9], 0.3)
    expect(Array.from(out)).toEqual([0, 1, 0, 1])
  })

  it('空配列でも例外を投げない', () => {
    expect(() => binarizeMask([], 0.3)).not.toThrow()
    expect(binarizeMask([]).length).toBe(0)
  })
})

// width x height の平面インデックス上に矩形を書き込むテスト用ヘルパー
function fillRect(binary: Uint8Array, width: number, x0: number, y0: number, x1: number, y1: number, value: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      binary[y * width + x] = value
    }
  }
}

// probMap（Float32Array等の実数配列）に矩形を書き込むテスト用ヘルパー。
// fillRect と違って0/1ではなく任意の確率値（0.95等）を書き込める。
// x1,y1 は境界を含む（inclusive）。
function fillProbRect(
  probMap: { [index: number]: number; length: number },
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      probMap[y * width + x] = value
    }
  }
}

describe('labelConnectedComponents', () => {
  it('離れた2つの矩形をそれぞれ別の成分として検出する', () => {
    const width = 10
    const height = 10
    const binary = new Uint8Array(width * height)
    fillRect(binary, width, 0, 0, 1, 1, 1) // 2x2
    fillRect(binary, width, 5, 5, 7, 8, 1) // 3x4
    const boxes = labelConnectedComponents(binary, width, height, 8)
    expect(boxes.length).toBe(2)
    const small = boxes.find((b) => b.minX === 0)
    const large = boxes.find((b) => b.minX === 5)
    expect(small).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1, pixelCount: 4 })
    expect(large).toEqual({ minX: 5, minY: 5, maxX: 7, maxY: 8, pixelCount: 12 })
  })

  it('8近傍では斜めにしか繋がっていない2画素も同じ成分とみなす', () => {
    const width = 4
    const height = 4
    const binary = new Uint8Array(width * height)
    binary[0] = 1 // (0,0)
    binary[1 * width + 1] = 1 // (1,1) 斜め隣接
    const boxes8 = labelConnectedComponents(binary, width, height, 8)
    expect(boxes8.length).toBe(1)

    const boxes4 = labelConnectedComponents(binary, width, height, 4)
    expect(boxes4.length).toBe(2)
  })

  it('全て0の入力は空配列を返す', () => {
    const binary = new Uint8Array(16)
    expect(labelConnectedComponents(binary, 4, 4)).toEqual([])
  })

  it('width/heightが0以下、データが不足している等の退化した入力でも例外を投げない', () => {
    expect(() => labelConnectedComponents(new Uint8Array(4), 0, 4)).not.toThrow()
    expect(labelConnectedComponents(new Uint8Array(4), 0, 4)).toEqual([])
    expect(() => labelConnectedComponents(new Uint8Array(2), 4, 4)).not.toThrow()
    expect(labelConnectedComponents(new Uint8Array(2), 4, 4)).toEqual([])
  })
})

describe('postprocessDetection', () => {
  it('小さすぎる成分をminSidePxで除外し、閾値を超えた成分だけをスケール変換して返す', () => {
    // 10x10のマップ空間。左上に2x2の小さい塊（除外対象）、
    // (4,4)-(7,7)の4x4の塊（採用対象）を置く。
    const width = 10
    const height = 10
    const probMap = new Float32Array(width * height)
    for (let y = 0; y <= 1; y++) for (let x = 0; x <= 1; x++) probMap[y * width + x] = 0.9
    for (let y = 4; y <= 7; y++) for (let x = 4; x <= 7; x++) probMap[y * width + x] = 1.0

    const boxes = postprocessDetection(probMap, width, height, { scaleX: 2, scaleY: 3 }, { boxThreshold: 0.2 })

    // 手計算（修正後の順序: スコアリングはunclipより前、tight（拡張前）の箱に対して行う）:
    // 4x4塊(x4..7,y4..7)は全画素が1.0 → tightスコア = 16*1.0 / (4*4=16) = 1.0
    // → boxThreshold(0.2)を超えるので採用 → unclip(ratio1.5, area16,perimeter16,distance1.5)
    // → 拡張後 x=2.5,y=2.5,w=7,h=7 → クランプ後 x0=2,y0=2,x1=10,y1=10（幅8,高さ8）
    // → 元画像座標 x=2*2=4, y=2*3=6, w=8*2=16, h=8*3=24
    // → score は判定に使ったtightスコアそのまま（1.0。以前の実装のようにunclip後の
    //   面積で割り直した値ではない）
    expect(boxes.length).toBe(1)
    expect(boxes[0].x).toBeCloseTo(4, 5)
    expect(boxes[0].y).toBeCloseTo(6, 5)
    expect(boxes[0].w).toBeCloseTo(16, 5)
    expect(boxes[0].h).toBeCloseTo(24, 5)
    expect(boxes[0].score).toBeCloseTo(1.0, 5)
  })

  it('スコアが閾値未満の成分は除外する（tight＝拡張前の箱でスコアを取る）', () => {
    // 対角線上にしか画素が無い成分（8近傍なので1つの連結成分になる）を作る。
    // バウンディングボックスは4x4(x4..7,y4..7)だが、実際に1.0なのは対角の4画素だけで、
    // 残り12画素は0.0のまま。tightスコア = 4*1.0 / (4*4=16) = 0.25。
    // 既定のboxThreshold(0.6)はこれを下回るので除外されるはず。
    // （このテストは「スコアはtightの箱に対して計算する」こと自体を検証するためのもので、
    // 単純な全面塗りつぶしの矩形だと拡張前でも1.0になってしまい閾値未満のケースを
    // 作れないため、あえて内部に隙間のある成分にしてある）
    const width = 10
    const height = 10
    const probMap = new Float32Array(width * height)
    probMap[4 * width + 4] = 1.0
    probMap[5 * width + 5] = 1.0
    probMap[6 * width + 6] = 1.0
    probMap[7 * width + 7] = 1.0
    // 既定オプション（boxThresholdを上書きしない）で確かめる
    const boxes = postprocessDetection(probMap, width, height, { scaleX: 1, scaleY: 1 })
    expect(boxes).toEqual([])
  })

  // ↓↓↓ 本命の回帰テスト ↓↓↓
  //
  // なぜ「既定オプションのまま」で試すことが重要か:
  // この不具合（postprocessDetectionが常に0件を返す）は、boxThreshold(0.6)という
  // 既定値そのものが原因だった。ところが以前のテストはすべて boxThreshold: 0.2 を
  // 明示的に渡しており、既定値の経路を一度も通していなかった。そのため実装が
  // 壊れていてもテストは全部緑のままだった、という事故が実際に起きている。
  // 二度と同じ穴を作らないために、ここでは options を一切渡さず
  // DEFAULT_DET_POSTPROCESS_OPTIONS（＝実際にdetect.tsが使うのと同じ設定）だけで
  // 検証する。
  it('既定オプションのまま、現品票の1行程度の現実的な確率マップから1つの箱を検出できる（回帰テスト）', () => {
    // 768x96のマップに、240x26の文字行を模した塊を1つ置く。内部は確率0.95
    // （綺麗に読めている文字行を想定）、外部は0.02（背景のノイズ程度）。
    // サイズ・確率とも、タスク説明に書かれている実測条件（内部0.95・外部0.02、
    // 240x26）をそのまま踏襲している。
    const width = 768
    const height = 96
    const probMap = new Float32Array(width * height).fill(0.02)
    const blockW = 240
    const blockH = 26
    const x0 = Math.floor((width - blockW) / 2)
    const y0 = Math.floor((height - blockH) / 2)
    fillProbRect(probMap, width, x0, y0, x0 + blockW - 1, y0 + blockH - 1, 0.95)

    const boxes = postprocessDetection(probMap, width, height, { scaleX: 1, scaleY: 1 })

    expect(boxes.length).toBe(1)
    // tightスコアは内部確率の0.95そのもの（外部の0.02で薄まっていない）になるはず
    // ＝ unclip後の矩形ではなくtightの矩形でスコアを取っていることの直接的な証拠。
    expect(boxes[0].score).toBeCloseTo(0.95, 5)
  })

  // 極端な縦横比でも既定値のまま通ることを確認する。unclip後の矩形でスコアを
  // 取っていた旧実装では、正方形に近い箱ほどスコアが0.33に近づき、細長い箱ほど
  // 0.4に近づく（boxes.ts postprocessDetection内のコメント参照）が、どちらに
  // 転んでもboxThreshold(0.6)には遠く届かず除外されていた。tightスコアに戻せば
  // 縦横比に関わらず内部確率がそのまま出るはずなので、縦横比の違いはもはや
  // 通過・除外を左右しない、ということをここで確認する。
  it('正方形に近い箱でも既定値のまま検出できる', () => {
    const width = 200
    const height = 200
    const probMap = new Float32Array(width * height).fill(0.02)
    fillProbRect(probMap, width, 80, 80, 119, 119, 0.95) // 40x40の正方形に近い塊
    const boxes = postprocessDetection(probMap, width, height, { scaleX: 1, scaleY: 1 })
    expect(boxes.length).toBe(1)
    expect(boxes[0].score).toBeCloseTo(0.95, 5)
  })

  it('極端に細長い箱でも既定値のまま検出できる', () => {
    const width = 400
    const height = 60
    const probMap = new Float32Array(width * height).fill(0.02)
    fillProbRect(probMap, width, 50, 26, 349, 33, 0.95) // 300x8の細長い塊
    const boxes = postprocessDetection(probMap, width, height, { scaleX: 1, scaleY: 1 })
    expect(boxes.length).toBe(1)
    expect(boxes[0].score).toBeCloseTo(0.95, 5)
  })

  it('検出枠を読み順（上から下、同じ行は左から右）に並べ替えて返す', () => {
    const width = 20
    const height = 20
    const probMap = new Float32Array(width * height)
    // 上段・右寄り
    for (let y = 1; y <= 4; y++) for (let x = 10; x <= 13; x++) probMap[y * width + x] = 1.0
    // 上段・左寄り
    for (let y = 1; y <= 4; y++) for (let x = 1; x <= 4; x++) probMap[y * width + x] = 1.0
    // 下段
    for (let y = 15; y <= 18; y++) for (let x = 1; x <= 4; x++) probMap[y * width + x] = 1.0

    const boxes = postprocessDetection(probMap, width, height, { scaleX: 1, scaleY: 1 }, { boxThreshold: 0.2 })
    expect(boxes.length).toBe(3)
    // 上段2つが先、下段が最後
    expect(boxes[0].y).toBeLessThan(boxes[2].y)
    expect(boxes[1].y).toBeLessThan(boxes[2].y)
    // 上段の中では左（x小）が先
    expect(boxes[0].x).toBeLessThan(boxes[1].x)
  })

  it('probMapが不正（サイズ不足）な場合は空配列を返す', () => {
    expect(postprocessDetection(new Float32Array(2), 10, 10, { scaleX: 1, scaleY: 1 })).toEqual([])
  })

  it('probMapが空でも例外を投げない', () => {
    expect(() => postprocessDetection(new Float32Array(0), 0, 0, { scaleX: 1, scaleY: 1 })).not.toThrow()
  })
})
