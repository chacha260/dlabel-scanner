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
//
// 「怪しい」の根拠はもともと2種類あった:
//   1. エンジンが返す文字ごとの信頼度が低い（judgeByConfidence）
//   2. 2回の認識で結果が食い違った（compareOcrPasses）
// tesseract.js を削除して ML Kit 1本にした結果、1. は完全に成立しなくなった
// （ML Kit は文字ごとの信頼度はおろか、全体の信頼度スコアすら一切返さない。
// mlkit.ts / types.ts のコメントを参照）。判定材料が無いまま関数だけ残しても
// 呼び出しようがないため judgeByConfidence は削除した。2. の compareOcrPasses は
// エンジン非依存（2回のテキストを突き合わせるだけ）で今後も使うため残す。
// 次の予定は「PSM を変えた2パス」ではなく「前処理を変えた2パス（素の画像 vs
// コントラスト補正）」で同じ仕組みを使うこと。

/** 1文字ぶんの判定結果 */
export type CharVerdict = {
  /** その文字そのもの */
  text: string
  /** 怪しい（人が確認したほうがよい）と判定されたか */
  uncertain: boolean
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
  // 裏取りの材料が無い場合は「怪しくない」扱いにする（情報が無いことを
  // 「全部怪しい」に変換しない、という一貫した方針のため）。
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
 * 2種類の判定結果を統合する。どちらか一方でも「怪しい」と言っていれば怪しい扱いにする
 * （見逃すより出しすぎるほうが安全）。
 *
 * もともとは compareOcrPasses（2パス照合）と judgeByConfidence（文字ごとの信頼度）の
 * 結果を統合するために作った関数だったが、tesseract.js の削除に伴って
 * judgeByConfidence 自体を削除したため、現時点でこの関数を実際に呼ぶ箇所は無い。
 * それでも汎用の「2つの CharVerdict[] を安全にORで統合する」関数として残す
 * （引数名は当時の名残りだが、判定の根拠が何であるかには依存しない実装のため
 * そのまま使える）。次に予定している「前処理を変えた2パス」同士の統合にも
 * そのまま流用できる。
 *
 * 2つの配列は同じ文字列から作られているとは限らない。そのため文字位置での
 * 単純な重ね合わせはせず、**長さが一致するときだけ**統合し、一致しない場合は
 * 基準となる byPasses 側をそのまま返す。無理に位置合わせして誤った位置を
 * 強調するくらいなら、片方の情報を捨てるほうがよい。
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
