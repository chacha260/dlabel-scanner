// 初めてこのアプリに触る現場の人向けの「使い方」パネル。
// SimpleScanScreen.tsx に実装されている機能だけを説明し、存在しない機能
// （結果の保存・履歴・設定画面など）は書かない。カメラ映像の上に全画面で重ね、
// 開いている間は scanGating.ts の helpOpen フラグでバーコード検出を止める
// （このパネルは画面全体を覆い、カメラがどこを向いているか分からなくなるため）。
//
// エントリーチャンクを太らせないよう、SimpleScanScreen.tsx 側で
// React.lazy + Suspense を使って別チャンクとして遅延読み込みする。

import type { ReactNode } from 'react'
import {
  CloseIcon,
  CopyIcon,
  FlashIcon,
  FlashOffIcon,
  PauseIcon,
  PlayIcon,
  ScanIcon,
  SoundOffIcon,
  SoundOnIcon,
  WarningIcon,
} from './components/Icons'

type HelpSheetProps = {
  onClose: () => void
}

type PillTone = 'default' | 'primary' | 'danger' | 'amber'

const pillToneClass: Record<PillTone, string> = {
  default: 'bg-slate-800 text-slate-100',
  primary: 'bg-cyan-500 text-slate-950',
  danger: 'bg-red-600 text-white',
  amber: 'bg-amber-400 text-slate-950',
}

// 実際の画面にあるボタンと見た目（色・アイコン）を揃えた「参照用ボタン」。
// 文中でボタン名に触れるたびにこれを添えることで、説明とアプリ画面上の
// ボタンが一目で対応するようにする。
function ButtonRef({ icon, tone = 'default', children }: { icon?: ReactNode; tone?: PillTone; children: ReactNode }) {
  return (
    <span
      className={`mx-0.5 inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 align-middle text-[0.95em] font-bold ${pillToneClass[tone]}`}
    >
      {icon}
      {children}
    </span>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-slate-800 px-5 py-7">
      <h2 className="mb-3 text-xl font-bold text-cyan-300">{title}</h2>
      <div className="space-y-3 text-base leading-relaxed text-slate-200">{children}</div>
    </section>
  )
}

export default function HelpSheet({ onClose }: HelpSheetProps) {
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-slate-950 text-slate-100">
      {/* 上部バー: タイトルと閉じるボタン（×）。常に見える位置に固定する */}
      <div
        className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <h1 className="text-xl font-bold text-slate-100">使い方</h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="使い方を閉じる"
          className="rounded-full p-2 text-slate-300 active:bg-slate-800"
        >
          <CloseIcon className="h-7 w-7" />
        </button>
      </div>

      {/* 本文（スクロール） */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <Section title="このアプリでできること">
          <p>
            棚のラベルにスマホのカメラを向けると、バーコードは自動で読み取ります。バーコードが無い部分の文字は、枠で囲って
            <ButtonRef icon={<ScanIcon className="h-4 w-4" />} tone="primary">
              枠内をOCR
            </ButtonRef>
            を押すと読み取れます。読み取った内容はどちらも画面下の一覧にたまっていき、あとからコピーして使えます。
          </p>
        </Section>

        <Section title="バーコードを読む">
          <p>特別な操作はいりません。カメラをバーコードに向けるだけで、自動的に・繰り返し読み取って一覧に追加していきます。</p>
          <p>同じバーコードを続けて読んでも、短い時間の間は二重に追加されません。</p>
          <p>
            <ButtonRef icon={<SoundOnIcon className="h-4 w-4" />}>音</ButtonRef>
            のボタンで読み取り音のON/OFFを切り替えられます。
            <ButtonRef icon={<SoundOffIcon className="h-4 w-4" />}>OFF</ButtonRef>
            にしていても、端末の振動はそのまま鳴ります。
          </p>
          <p>
            <ButtonRef icon={<PauseIcon className="h-4 w-4" />} tone="amber">
              一時停止
            </ButtonRef>
            を押すと、バーコードの読み取りだけを止めます。カメラ映像はそのまま映り続けるので、もう一度押して
            <ButtonRef icon={<PlayIcon className="h-4 w-4" />}>再開</ButtonRef>
            すればすぐに読み取りを再開します。
          </p>
        </Section>

        <Section title="文字を読む（OCR）">
          <p>カメラ映像の上にある水色の枠を、読みたい文字の上に合わせます。</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>枠の内側を指でドラッグすると、枠ごと移動します。</li>
            <li>枠のふちにある小さな丸い印をドラッグすると、その辺だけ大きさを変えられます。</li>
            <li>
              触っているうちに分からなくなったら、枠の左上にある
              <ButtonRef>枠をリセット</ButtonRef>
              で元の位置・大きさに戻せます。
            </li>
          </ul>
          <p>
            枠を合わせたら
            <ButtonRef icon={<ScanIcon className="h-4 w-4" />} tone="primary">
              枠内をOCR
            </ButtonRef>
            を押します。初回だけ文字認識エンジン（約9MB）のダウンロードが走りますが、一度ダウンロードすればそれ以降は電波が無い場所でもそのまま使えます。
          </p>
        </Section>

        <Section title="読み取った画像の見かた">
          <p>
            OCRの結果が出ると、結果の横に小さな画像（サムネイル）が表示されます。これは
            <strong className="text-slate-100">実際に文字認識にかけたのとまったく同じ画像</strong>
            です。結果がおかしいときは、この画像を見れば「枠のずれ」や「ピントのボケ」が原因かどうかを判断できます。
          </p>
          <p>
            PSM（読み取りモード）やバーコード除外の設定を変えたときは、
            <ButtonRef>同じ画像で再認識</ButtonRef>
            を押せば、もう一度狙い直さずに、今の画像のまま読み直せます。抽出フィルタの切り替えだけは読み取り済みの結果を絞り込むだけなので、押さなくても表示がすぐに変わります。
          </p>
        </Section>

        <Section title="バーコードが写り込むとき">
          <p>枠の中にバーコードの縞模様が入っていると、文字認識エンジンがそれも文字として読もうとして、結果が崩れてしまうことがあります。</p>
          <p>
            そのため、このアプリは枠内のバーコードを自動で見つけ、縞模様の部分だけを塗りつぶしてから文字を読み取ります（
            <span className="font-semibold text-cyan-200">「バーコードを自動で除外」</span>
            、既定でON）。塗りつぶした場合は「バーコード◯箇所を除外して読み取りました」と表示されます。
          </p>
          <p>それでもうまく読めないときは、枠を動かしてバーコードを枠の外に出すか、この設定をOFFにしてから「同じ画像で再認識」を押し、結果を見比べてみてください。</p>
        </Section>

        <Section title="うまく読めないとき">
          <p>結果がおかしい・空白のときは、次を順番に試してください。</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>ラベルにもう少し近づく</li>
            <li>手ブレしないよう、スマホを両手で構えてしっかり止める</li>
            <li>
              暗い場所では
              <ButtonRef icon={<FlashIcon className="h-4 w-4" />} tone="amber">
                ライト
              </ButtonRef>
              を点ける（対応機種のみボタンが表示されます。消すときは
              <ButtonRef icon={<FlashOffIcon className="h-4 w-4" />}>ライトOFF</ButtonRef>
              ）
            </li>
            <li>枠を文字ぎりぎりまで小さく合わせ、余計なものを写り込ませない</li>
            <li>「単一行」「単語」「ブロック」の読み取りモードを切り替えてみる</li>
            <li>「フィルタなし（そのまま）」「数字のみ抽出」「英数字のみ抽出」の抽出フィルタを切り替えてみる</li>
          </ul>
        </Section>

        <Section title="結果の扱い">
          <p>一覧の各行は、右側の</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <CopyIcon className="mr-1 inline h-4 w-4 align-text-bottom text-slate-300" />
              アイコンでその行だけコピー
            </li>
            <li>
              <CloseIcon className="mr-1 inline h-4 w-4 align-text-bottom text-slate-400" />
              アイコンでその行だけ削除
            </li>
          </ul>
          <p>
            画面下部の
            <ButtonRef icon={<CopyIcon className="h-4 w-4" />}>全部コピー</ButtonRef>
            で一覧全体をまとめてコピー、
            <ButtonRef tone="danger">クリア</ButtonRef>
            で一覧をすべて消せます。
          </p>
          <div className="flex gap-2.5 rounded-lg border border-amber-500/50 bg-amber-950/40 p-3.5">
            <WarningIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <p className="font-semibold text-amber-200">
              結果は保存されません。アプリを閉じたり画面を再読み込みしたりすると、一覧の内容は消えます。コピーし忘れに注意してください。
            </p>
          </div>
        </Section>

        <Section title="ホーム画面に追加">
          <p>
            Chromeのメニューから「ホーム画面に追加」を選ぶと、アプリのように起動できるようになり、電波が無い場所でもそのまま使えます。
          </p>
        </Section>

        {/* スクロールを戻さなくても閉じられるよう、末尾にも閉じるボタンを置く */}
        <div className="px-5 py-7" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.75rem)' }}>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-14 w-full items-center justify-center rounded-xl bg-cyan-500 text-base font-bold text-slate-950 active:bg-cyan-400"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
