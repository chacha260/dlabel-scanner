// 1フレーム分の検出結果（複数件ありうる）から「新しく追加すべき」ヒットだけを選び出す純粋関数。
//
// 以前の実装は「直近 dedupeMs ミリ秒以内に同じ値を見たかどうか」という時間ベースの
// 判定で追加の可否を決めていた。そのためカメラを同じラベルに向け続けると、
// 1.5秒おきに同じ値が際限なく再追加され、一覧が同じ値の重複で埋まってしまっていた
// （ユーザー報告）。
//
// 新しいルール: 「呼び出し側の結果一覧に、今その値が含まれているか」だけで
// 追加の可否を決める（isDuplicate 述語）。時間は一切関係ない。一覧からその値が
// 消えれば（行削除・クリア、将来的には送信/書き出しでの消費も含む）、
// 再び新規として追加できるようになる。
//
// 「読み取り済み」フィードバックを毎フレーム光らせないための短い時間窓は、
// この関数の責務ではなく呼び出し側（useBarcodeScanner）が別途持つ。
// ここでは値ごとの独立した判定と、同一フレーム内の重複排除だけを純粋に行う。

import type { BarcodeHit } from './types'

/**
 * hits のうち「追加すべき」ものだけを、検出順を保ったまま返す。
 * isDuplicate(value) が true を返す値（＝呼び出し側の結果一覧に今その値が
 * 既に含まれている）は追加対象から除外する。この関数自身は一切 mutate しない
 * （純粋関数・テストしやすさのため）。
 *
 * 同一フレーム内に同じ値が複数回出現した場合、1件目が「追加すべき」と判定されれば、
 * 2件目以降は「たった今このフレームで追加対象に選んだ」ことを理由に重複させない
 * （isDuplicate は「一覧に既にあるか」だけを見る述語であり、このフレームで
 * これから追加しようとしている分はまだ一覧に反映されていないため、
 * isDuplicate だけでは2件目以降を弾けない）。
 */
export function selectNewHits(hits: BarcodeHit[], isDuplicate: (value: string) => boolean): BarcodeHit[] {
  const newHits: BarcodeHit[] = []
  // 同一フレーム内で同じ値が複数回出現したときに、2件目以降を
  // 「たった今このフレームで新規採用した」ものとして重複させないための集合。
  const takenInThisFrame = new Set<string>()

  for (const hit of hits) {
    if (takenInThisFrame.has(hit.value)) continue
    if (isDuplicate(hit.value)) continue
    newHits.push(hit)
    takenInThisFrame.add(hit.value)
  }

  return newHits
}
