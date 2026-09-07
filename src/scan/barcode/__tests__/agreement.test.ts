import { describe, expect, it } from 'vitest'
import { createBarcodeAgreementTracker, DEFAULT_AGREEMENT_WINDOW_MS } from '../agreement'
import type { BarcodeHit } from '../types'

function hit(value: string, format = 'code_128'): BarcodeHit {
  return { value, format }
}

describe('createBarcodeAgreementTracker', () => {
  it('requiredCount=1のときは1回目から即座に採用する（実質無効化）', () => {
    const tracker = createBarcodeAgreementTracker()
    const accepted = tracker.observeFrame([hit('A')], 0, 1, DEFAULT_AGREEMENT_WINDOW_MS)
    expect(accepted.map((h) => h.value)).toEqual(['A'])
  })

  it('requiredCount=2のとき、1回目は採用されず2回目（別フレーム）で採用される', () => {
    const tracker = createBarcodeAgreementTracker()
    const first = tracker.observeFrame([hit('A')], 0, 2, DEFAULT_AGREEMENT_WINDOW_MS)
    expect(first).toEqual([])
    const second = tracker.observeFrame([hit('A')], 100, 2, DEFAULT_AGREEMENT_WINDOW_MS)
    expect(second.map((h) => h.value)).toEqual(['A'])
  })

  it('要件1: 値ごとに完全に独立してカウントする（AとBが交互に観測されても両方N回で採用される）', () => {
    // 棚に複数のバーコードが同時に写り、フレームごとにどちらか一方しかデコードされない
    // ことがある、という実運用を想定した回帰テスト。
    const tracker = createBarcodeAgreementTracker()
    const required = 2
    const window = DEFAULT_AGREEMENT_WINDOW_MS

    // frame1: Aだけ観測 → Aのカウント1
    expect(tracker.observeFrame([hit('A')], 0, required, window)).toEqual([])
    // frame2: Bだけ観測 → Bのカウント1（Aのカウントには影響しない）
    expect(tracker.observeFrame([hit('B')], 100, required, window)).toEqual([])
    // frame3: Aを再観測 → Aのカウント2に到達して採用される
    expect(tracker.observeFrame([hit('A')], 200, required, window).map((h) => h.value)).toEqual(['A'])
    // frame4: Bを再観測 → Bのカウント2に到達して採用される
    expect(tracker.observeFrame([hit('B')], 300, required, window).map((h) => h.value)).toEqual(['B'])
  })

  it('要件2（最重要な回帰テスト）: 同一フレームに同じ値が2件あっても1回としか数えず、その場では採用されない', () => {
    const tracker = createBarcodeAgreementTracker()
    // 同じラベルが2枚並んで写り、1フレームの検出結果に同じ値が2件含まれるケース。
    const accepted = tracker.observeFrame([hit('A'), hit('A')], 0, 2, DEFAULT_AGREEMENT_WINDOW_MS)
    expect(accepted).toEqual([]) // 2件あっても1カウントにしかならないので、まだ採用されない

    // 次のフレームで初めて2カウント目に到達し、そのフレームの全ヒットが採用される
    const secondFrame = tracker.observeFrame([hit('A'), hit('A')], 100, 2, DEFAULT_AGREEMENT_WINDOW_MS)
    expect(secondFrame).toHaveLength(2)
  })

  it('要件3: 時間窓を過ぎるとその値だけがリセットされ、他の値のカウントは残る', () => {
    const tracker = createBarcodeAgreementTracker()
    const required = 2
    const window = 1500

    // 同じフレームでAとBを両方1回ずつ観測（実運用でも同時に写る2本を想定）
    expect(tracker.observeFrame([hit('A'), hit('B')], 0, required, window)).toEqual([])

    // Bは時間窓内（1000ms後）に再観測 → カウント2に到達して採用される
    expect(tracker.observeFrame([hit('B')], 1000, required, window).map((h) => h.value)).toEqual(['B'])

    // Aは時間窓を超えて（2000ms後、最初の観測から1500msより後）再観測 → その値だけ
    // カウントが1にリセットされ、まだ採用されない（Bが採用済みであることには影響しない）
    expect(tracker.observeFrame([hit('A')], 2000, required, window)).toEqual([])
  })

  it('要件4: エントリ数が上限を超えたら、最終観測が最も古いものから捨てられる', () => {
    // テストしやすいよう上限を3に設定
    const tracker = createBarcodeAgreementTracker(3)
    const required = 3 // このテストでは採用させず、カウント状態だけを見たいので大きめにする
    const window = DEFAULT_AGREEMENT_WINDOW_MS

    tracker.observeFrame([hit('A')], 0, required, window)
    tracker.observeFrame([hit('B')], 10, required, window)
    tracker.observeFrame([hit('C')], 20, required, window)
    // 上限(3)ちょうどなので、まだ何も捨てられていないはず。
    // Aを2回目まで進める（Aが最終観測される）
    tracker.observeFrame([hit('A')], 30, required, window)
    // ここでDを追加すると上限を超えるため、最終観測が最も古い値（この時点ではB）が
    // 捨てられる（Aは直前にtouchされたばかりなので生き残る）。
    tracker.observeFrame([hit('D')], 40, required, window)

    // Bが捨てられていれば、次にBを観測してもカウントは1からやり直しになり、
    // required=3なので1回では採用されない（これ自体は当然）。
    // 代わりに「Bのカウントが破棄されている」ことを、windowを使わずに検証する:
    // 捨てられていなければBは既にcount=1のままだったので、あと2回で採用されるはず。
    // 捨てられていれば、あと2回でもまだ採用されない（1回分のカウントが失われているため）。
    tracker.observeFrame([hit('B')], 50, required, window)
    const stillNotAccepted = tracker.observeFrame([hit('B')], 60, required, window)
    expect(stillNotAccepted).toEqual([]) // 捨てられていなければここで採用されてしまうはず
  })

  it('要件5(2次元): QR等の2次元シンボルはカウントを経ずに毎回即座に採用される', () => {
    const tracker = createBarcodeAgreementTracker()
    const accepted = tracker.observeFrame([hit('DATA', 'qr_code')], 0, 3, DEFAULT_AGREEMENT_WINDOW_MS)
    expect(accepted.map((h) => h.value)).toEqual(['DATA'])
    // 何度呼んでも要求回数に関係なく毎回採用される
    const again = tracker.observeFrame([hit('DATA', 'qr_code')], 1, 3, DEFAULT_AGREEMENT_WINDOW_MS)
    expect(again.map((h) => h.value)).toEqual(['DATA'])
  })

  it('forget() で破棄すると、次に観測したときは1回目からやり直しになる', () => {
    const tracker = createBarcodeAgreementTracker()
    const required = 2
    const window = DEFAULT_AGREEMENT_WINDOW_MS

    tracker.observeFrame([hit('A')], 0, required, window) // カウント1
    const accepted = tracker.observeFrame([hit('A')], 100, required, window) // カウント2で採用
    expect(accepted.map((h) => h.value)).toEqual(['A'])

    tracker.forget('code_128', 'A')

    // forget後は最初からやり直しになるため、1回目では採用されない
    const afterForget = tracker.observeFrame([hit('A')], 200, required, window)
    expect(afterForget).toEqual([])
  })

  it('reset() で全ての値のカウントを消去する', () => {
    const tracker = createBarcodeAgreementTracker()
    const required = 2
    const window = DEFAULT_AGREEMENT_WINDOW_MS

    tracker.observeFrame([hit('A')], 0, required, window)
    tracker.observeFrame([hit('B')], 0, required, window)
    tracker.reset()

    expect(tracker.observeFrame([hit('A')], 100, required, window)).toEqual([])
    expect(tracker.observeFrame([hit('B')], 100, required, window)).toEqual([])
  })
})
