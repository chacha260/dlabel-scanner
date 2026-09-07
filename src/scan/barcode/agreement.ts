// バーコードの「複数回一致」ガード（運用的冗長化）。純粋関数ではなく、フレームを
// またいだ観測回数という時間軸の状態を持つ小さなトラッカーとして実装する
// （guards.ts の evaluateBarcodeHit は1件のヒットだけを見る純粋関数だが、
// こちらは「前のフレームで何回見たか」を覚えていないと成立しないため、別ファイルに
// 分離してある）。
//
// 狙い: 同じ値を連続 N 回デコードできて初めて採用する。10fps のフレームループなので
// N=2 でも遅延は約100msにしかならないが、「一度きりのランダムな誤読」（=見切れた
// バーコードがたまたまその1フレームだけ別の値に化ける、センサーノイズ等）には
// 非常によく効く。
//
// 重要な限界（README にも明記する）: この仕組みは「一度きりのランダムな誤読」には
// 効くが、切れたバーコードを毎フレーム同じように誤読する「系統的な誤読」には
// 効かない（どのフレームでも同じ間違った値が安定して出るため、何回連続しても
// その値で一致してしまう）。系統的な誤読を止めるのは guards.ts のチェックディジット
// 検証と見切れ検出の役割であり、複数回一致はあくまでそれらを補う運用的な保険。
//
// 時刻は必ず呼び出し側から引数で受け取り、Date.now() をこのファイル内で呼ばない
// （テストで時刻を完全にコントロールできるようにするため）。

import type { BarcodeHit } from './types'
import { isTwoDimensionalFormat } from './guards'

// 値ごとに保持するエントリ数の上限。棚卸しのように大量の異なるバーコードを
// 次々に読ませる運用では、何もしないとこの Map が際限なく育ち続ける
// （読み取り済みでも forget されない限りエントリは残るため、後述のエビクションが
// 無いと単純にメモリリークになる）。
const DEFAULT_MAX_TRACKED_VALUES = 64

type AgreementEntry = { count: number; lastSeenAt: number }

export type BarcodeAgreementTracker = {
  /**
   * 1フレーム分のヒット（guards.ts の evaluateBarcodeHit を既に通過したもの）を
   * まとめて渡し、「このフレームで採用してよい」ヒットだけを元の順序のまま返す。
   *
   * 値ごとに完全に独立してカウントする（重要）: このアプリは棚のラベルのように
   * 複数のバーコードが同時に画角へ写る運用を前提にしている
   * （zxing.worker.ts の maxNumberOfSymbols=16、dedupe.ts の selectNewHits の
   * コメント参照）。「直前のフレームと同じ値か」のような単純な前後比較で数えると、
   * A・B 2本が交互にデコードされただけで両方とも永遠に採用されなくなってしまう。
   * そのため値（フォーマット+文字列）をキーにした独立カウンタを Map で持つ。
   *
   * 1フレームにつき同じ値は最大1カウントにする（重要）: 同じ値のラベルが2枚
   * 並んで写っている場合、1フレームの検出結果に同じ値が複数件含まれることがある。
   * これを「フレームをまたいだ再観測」と同様に複数回カウントしてしまうと、
   * 1フレームだけで N 回分のカウントが揃ってしまい、複数回一致ガードが
   * その場で無条件に成立する（＝一度きりの誤読に対して何の防御にもならない）。
   * この関数を「1フレーム分をまとめて受け取るバッチ API」にしてあるのはこのため
   * （observe を値ごとに1回ずつ呼ぶ設計にすると、「このフレームで既に数えたか」を
   * 呼び出し側とこのファイルの両方で二重に管理する必要が生まれ、抜け漏れの元になる。
   * 1フレーム分を丸ごと渡してもらえば、フレーム内の重複排除をこの関数の中だけで
   * 完結できる）。
   *
   * 2次元シンボルは常に即座に採用する（カウントの対象にもしない）。guards.ts の
   * evaluateBarcodeHit 冒頭のコメントと同じ理由（強力な誤り訂正を内蔵しており、
   * デコード成功時点で内容が保証されているため）。
   */
  observeFrame: (hits: BarcodeHit[], nowMs: number, requiredCount: number, windowMs: number) => BarcodeHit[]
  /**
   * 値ごとの追跡状態を破棄する。
   *
   * 採用後の扱い（重要・設計判断）: このアプリでは「一度採用された値のカウンタは
   * 破棄し、次にその値が必要になったときは毎回 N 回の一致をやり直す」方式を
   * 採用している（呼び出し側は、実際に結果一覧へ新規追加した直後にこれを呼ぶ）。
   * 一覧からその値の行を削除すれば再び新規として追加できる、という既存の設計
   * （dedupe.ts の selectNewHits・isDuplicate 参照）と一貫性を保つには、
   * 「一度信用した値をずっと信用し続ける」方式より「毎回やり直す」方式の方が
   * 単純で説明しやすい。副作用として、既に一覧にある値へ再度カメラを向けたときの
   * 「読み取り済み」通知（onDuplicate）が、カウンタが揃うまでの数フレーム
   * （N=2なら最大約200ms）だけ遅れることがあるが、実害はない軽微なトレードオフ。
   */
  forget: (format: string, value: string) => void
  /** 全消去（テスト用途、およびリーダー再生成時の状態リセット用） */
  reset: () => void
}

/**
 * @param maxTrackedValues 値ごとのエントリ数の上限（既定 DEFAULT_MAX_TRACKED_VALUES）。
 *   テストで小さい値を指定し、エビクションの挙動を検証できるようにするため引数化してある。
 */
export function createBarcodeAgreementTracker(maxTrackedValues: number = DEFAULT_MAX_TRACKED_VALUES): BarcodeAgreementTracker {
  // Map は「最後に set したキーが末尾に来る」という反復順序の性質を持つ。
  // touch() で既存キーも一度 delete してから set し直すことで、
  // 「反復順序の先頭 = 最終観測（lastSeenAt）が最も古いもの」という不変条件を
  // 保つ。エビクション時にこの先頭から捨てれば、追加のソート処理なしに
  // 「最近使ったものほど生き残る」LRU的な挙動になる。
  const state = new Map<string, AgreementEntry>()

  function keyOf(format: string, value: string): string {
    return `${format} ${value}`
  }

  function touch(key: string, entry: AgreementEntry): void {
    state.delete(key)
    state.set(key, entry)
  }

  function evictIfNeeded(): void {
    // 上限に達したときに捨てるのは常に「最終観測が最も古いもの」から
    // （touch() の説明のとおり Map の反復順序＝古い順になっている）。
    // このフレームでちょうど採用条件を満たした・採用直前の値は直前に touch()
    // 済みで末尾（=最新）に来ているため、巻き込まれて捨てられることはない。
    while (state.size > maxTrackedValues) {
      const oldestKey = state.keys().next().value
      if (oldestKey === undefined) break
      state.delete(oldestKey)
    }
  }

  return {
    observeFrame(hits, nowMs, requiredCount, windowMs) {
      const accepted: BarcodeHit[] = []
      // このフレーム内で既にカウント済みの値（フォーマット+文字列）。
      // 「1フレームにつき同じ値は最大1カウント」を守るための集合
      // （このファイル冒頭・observeFrame のコメントの「重要」参照）。
      const countedInThisFrame = new Set<string>()

      for (const hit of hits) {
        if (isTwoDimensionalFormat(hit.format)) {
          accepted.push(hit)
          continue
        }
        if (requiredCount <= 1) {
          // 1回で採用＝実質的にこのガードを無効化する設定。カウント自体が不要。
          accepted.push(hit)
          continue
        }

        const key = keyOf(hit.format, hit.value)

        if (countedInThisFrame.has(key)) {
          // 同一フレーム内の2件目以降。カウントは増やさないが、直前の1件目の
          // 処理で既に採用条件を満たしていれば、このヒットも同じフレームの
          // 結果として一緒に採用する（selectNewHits と同じく、フレーム内の
          // 重複ヒット自体を握りつぶして捨てはしない）。
          const entry = state.get(key)
          if (entry !== undefined && entry.count >= requiredCount) accepted.push(hit)
          continue
        }
        countedInThisFrame.add(key)

        const prev = state.get(key)
        // 直近の観測から windowMs 以内なら継続、それを超えていればその値だけを
        // リセットする（他の値のカウントには一切影響しない＝値ごとに独立）。
        const withinWindow = prev !== undefined && nowMs - prev.lastSeenAt <= windowMs
        const count = withinWindow ? prev.count + 1 : 1
        touch(key, { count, lastSeenAt: nowMs })
        if (count >= requiredCount) accepted.push(hit)
      }

      evictIfNeeded()
      return accepted
    },
    forget(format, value) {
      state.delete(keyOf(format, value))
    },
    reset() {
      state.clear()
    },
  }
}

/** 既定の時間窓（ミリ秒）。この時間内に再観測できなければその値のカウントだけをリセットする。 */
export const DEFAULT_AGREEMENT_WINDOW_MS = 1500
