// 「どの文字が怪しいか」を判定する純粋モジュール。canvas にも DOM にも React にも
// 依存せず、文字列と数値だけを扱う（stripes.ts / lines.ts と同じ流儀。vitest が
// node 環境で動くため、この判定ロジックをそこだけで完結してテストできるようにする）。
//
// 背景: 現場から「I と 1 が見分けられない」という報告が来ている。この種の取り違えは
// 前処理をどれだけ磨いても完全には無くならない（そもそも字形がほぼ同じで、
// 文脈が無ければ人間でも判別できないことがある）。
//
// そこで方針を「間違えないようにする」から「**間違えたかもしれない箇所を人に見せる**」
// へ広げる。現場の人が一瞬で直せるなら、実用上の精度としてはそのほうが効く。
// 「怪しい」の根拠は2種類あり、このモジュールはその両方を扱う。
//   1. エンジンが返す文字ごとの信頼度が低い（judgeByConfidence）
//   2. PSM を変えた2回の認識で結果が食い違った（compareOcrPasses）

/** 1文字ぶんの判定結果 */
export type CharVerdict = {
  /** その文字そのもの */
  text: string
  /** 怪しい（人が確認したほうがよい）と判定されたか */
  uncertain: boolean
}

// エンジンが返す文字ごとの信頼度が、この値を下回ったら「怪しい」とみなす。
//
// tesseract.js（Word.symbols[].confidence）の信頼度は 0..100 のスケールで返る。
// 80 という値の根拠: はっきり読めている文字はおおむね 90 以上に張り付き、
// 字形が紛らわしい文字や潰れた文字で目に見えて下がる、という一般的な傾向に
// 基づく初期値であり、**実物の現品票で測って決めた値ではない**。
// 高くしすぎると全部が怪しい扱いになって「強調」の意味が無くなり、
// 低くしすぎると本当に怪しい文字を見逃す。実機で調整すること。
export const LOW_CONFIDENCE_THRESHOLD = 80

/**
 * 文字ごとの信頼度から「怪しい文字」を判定する。
 *
 * symbols が空（エンジンが文字単位の情報を返さなかった場合。ocr.worker.ts の
 * コメント参照）のときは、判定材料が無いので **何も怪しくない扱い** にする。
 * 「情報が取れない」ことを「全部怪しい」に変換すると、画面が真っ赤になるだけで
 * 何の情報にもならないため。
 */
export function judgeByConfidence(
  symbols: { text: string; confidence: number }[],
  threshold: number = LOW_CONFIDENCE_THRESHOLD,
): CharVerdict[] {
  if (!Array.isArray(symbols) || symbols.length === 0) return []
  const safeThreshold = Number.isFinite(threshold) ? threshold : LOW_CONFIDENCE_THRESHOLD
  return symbols.map((symbol) => ({
    text: symbol.text,
    // confidence が数値でない（壊れた入力）場合は判定材料にならないので怪しくない扱い
    uncertain: Number.isFinite(symbol.confidence) && symbol.confidence < safeThreshold,
  }))
}

/**
 * 2回の認識結果を文字単位で突き合わせ、一致しなかった箇所を「怪しい」と判定する。
 *
 * 単純に位置どうしを比較してはいけない。片方が1文字多く読んだ（あるいは落とした）
 * だけで、それ以降の全文字がずれて「全部不一致」になってしまうため。
 * ここでは最長共通部分列（LCS）で2つの文字列を対応付け、**共通部分列に含まれた
 * 文字だけを「両方のパスが同じ判断をした＝信頼できる」** とみなす。
 * 挿入・削除・置換で食い違った箇所だけが怪しいものとして残る。
 *
 * 戻り値は primary（第1引数）側の文字列を1文字ずつ並べたもの。表示するのは
 * あくまで primary の結果であり、secondary は「裏を取るためだけ」に使う。
 *
 * 計算量は O(len(a) × len(b))。OCR の対象は現品票の1〜数行で、長くても
 * 数百文字なので実用上まったく問題にならない。
 */
export function compareOcrPasses(primary: string, secondary: string): CharVerdict[] {
  const a = Array.from(primary)
  const b = Array.from(secondary)

  if (a.length === 0) return []
  // 裏取りの材料が無い場合は「怪しくない」扱いにする（judgeByConfidence と同じ理由。
  // 情報が無いことを「全部怪しい」に変換しない）。
  if (b.length === 0) return a.map((text) => ({ text, uncertain: false }))

  // LCS の長さ表。dp[i][j] = a[i..] と b[j..] の最長共通部分列の長さ
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  // 表をたどり直して、a の各文字が共通部分列に採用されたかどうかを決める
  const verdicts: CharVerdict[] = []
  let i = 0
  let j = 0
  while (i < a.length) {
    if (j < b.length && a[i] === b[j]) {
      // 両方のパスがこの文字で一致した
      verdicts.push({ text: a[i], uncertain: false })
      i++
      j++
    } else if (j < b.length && dp[i + 1][j] >= dp[i][j + 1]) {
      // a 側だけにあるこの文字は、secondary では裏が取れていない
      verdicts.push({ text: a[i], uncertain: true })
      i++
    } else if (j < b.length) {
      // b 側にだけある文字は表示しない（表示するのは primary だけ）。
      // b を1つ進めて対応付けを続ける。
      j++
    } else {
      // secondary を使い切った。残りの a は裏が取れていない
      verdicts.push({ text: a[i], uncertain: true })
      i++
    }
  }

  return verdicts
}

/**
 * 信頼度による判定と2パス照合の結果を統合する。
 * どちらか一方でも「怪しい」と言っていれば怪しい扱いにする（見逃すより出しすぎるほうが安全）。
 *
 * 2つの配列は同じ文字列から作られているとは限らない（symbols はエンジンが
 * 認識した文字の並びで、空白の扱いなどが text と一致しないことがある）。
 * そのため文字位置での単純な重ね合わせはせず、**長さが一致するときだけ**統合し、
 * 一致しない場合は基準となる byPasses 側をそのまま返す。
 * 無理に位置合わせして誤った位置を強調するくらいなら、片方の情報を捨てるほうがよい。
 */
export function mergeVerdicts(byPasses: CharVerdict[], byConfidence: CharVerdict[]): CharVerdict[] {
  if (byConfidence.length === 0) return byPasses
  if (byPasses.length === 0) return byConfidence
  if (byPasses.length !== byConfidence.length) return byPasses
  return byPasses.map((verdict, index) => ({
    text: verdict.text,
    uncertain: verdict.uncertain || byConfidence[index].uncertain,
  }))
}
