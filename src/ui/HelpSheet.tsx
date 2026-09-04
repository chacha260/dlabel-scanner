// 初めてこのアプリに触る現場の人向けの「使い方」パネル。
// SimpleScanScreen.tsx に実装されている機能だけを説明し、存在しない機能
// （結果の保存・履歴・設定画面など）は書かない。カメラ映像の上に全画面で重ね、
// 開いている間は scanGating.ts の helpOpen フラグでバーコード検出を止める
// （このパネルは画面全体を覆い、カメラがどこを向いているか分からなくなるため）。
//
// エントリーチャンクを太らせないよう、SimpleScanScreen.tsx 側で
// React.lazy + Suspense を使って別チャンクとして遅延読み込みする。
//
// 「バーコード」「文字」の2モードに分かれたのに合わせて、以前の
// 「枠はOCRとバーコードの両方を兼ねる」という説明は完全に書き直してある
// （2つの枠は別物で、それぞれ別に記憶される、という説明に置き換えた）。

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
  /**
   * ライセンス情報パネルを開く。パネル本体（LicenseSheet）はこのコンポーネントの
   * 子としてではなく SimpleScanScreen.tsx 側で描画する。使い方パネルの上に
   * 重ねて出すため、開閉状態も z-index の前後関係も1箇所（画面側）で
   * まとめて面倒を見たほうが、どちらが手前かを追いやすいため。
   */
  onOpenLicenses: () => void
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

// ボタン右端に添える「>」。専用アイコンを Icons.tsx に増やすほどの用途ではないため、
// このファイル内だけの表示用グリフとして持つ（意味は持たないので aria-hidden）。
function ChevronRightGlyph() {
  return (
    <span aria-hidden="true" className="text-slate-400">
      ›
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

export default function HelpSheet({ onClose, onOpenLicenses }: HelpSheetProps) {
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
            画面いちばん上の切り替えで、<strong className="text-slate-100">「バーコード」</strong>と
            <strong className="text-slate-100">「文字」</strong>の2つのモードを切り替えて使います。
            どちらのモードで読み取った内容も、同じ1つの一覧（画面下）にたまっていき、あとからコピーして使えます。
          </p>
          <p>
            2つのモードはそれぞれ<strong className="text-slate-100">別々の水色の枠</strong>を持っていて、
            動かした位置・大きさはモードごとに個別に記憶されます。「バーコードモードで動かした枠が、文字モードの枠にも影響する」
            ということはありません。
          </p>
          <p>
            モード切り替えのすぐ下には<strong className="text-slate-100">「画質」「整形」</strong>
            が常に並んでいます。この2つはどちらのモードでも共通の設定（一度決めたらしばらく変えないもの）なので、
            モードを切り替えても位置も内容も変わりません。トーチ・一時停止・シャッターなど「読み取りのたびに押す」
            操作は、これまで通り画面下のボタン列にあります。
          </p>
        </Section>

        <Section title="バーコードモード">
          <p>
            <ButtonRef tone="primary">バーコード</ButtonRef>
            を選んでいる間は、カメラをバーコードに向けるだけで自動的に・繰り返し読み取って一覧に追加していきます。特別な操作はいりません。
            （下の<strong className="text-slate-100">「読み取り」</strong>を
            <ButtonRef>長押し中だけ</ButtonRef>
            に切り替えると、ボタンを押している間だけ読む動きに変えられます。次の項を参照してください。）
          </p>
          <p>
            水色の枠（「読み取り範囲」）は、バーコードを受け付ける範囲を示しています。
            カメラ映像は<strong className="text-slate-100">毎秒最大10回</strong>（0.1秒ごと）解析しています。
            端末の処理が追いつかないときは、そのぶん自動的に間引くため、動作が重くなることはありません。
          </p>
          <p>
            <strong className="text-slate-100">同じ値のバーコードは、一覧に残っている間は二度と追加されません。</strong>
            カメラを向け続けても一覧が同じ値で埋まっていくことはなく、その値の行を
            <CloseIcon className="mx-0.5 inline h-3.5 w-3.5 align-text-bottom text-slate-400" />
            で削除するか
            <ButtonRef tone="danger">クリア</ButtonRef>
            を押すと、その値はまた新規として追加できるようになります。既に一覧にある値を検出したときは、
            追加はせず枠の中に控えめに<strong className="text-slate-100">「読み取り済み」</strong>と表示するだけにしています。
          </p>
          <p>
            別のバーコードなら待たずにすぐ追加されます。枠の中に複数本のバーコードが写っていれば、
            <strong className="text-slate-100">1回の読み取りでまとめて全部</strong>一覧に追加されます。
          </p>
          <p>
            棚のラベルなどでバーコードが縦に何本も並んでいて、
            <strong className="text-slate-100">そのうちの1本だけ</strong>を読みたいときは、水色の枠をその1本にぴったり収まる大きさまで小さくしてください。枠の外に出た他のバーコードは読み取り対象になりません（
            <ButtonRef>枠内のみ</ButtonRef>
            がONのとき）。
          </p>
          <p>
            <ButtonRef>枠内のみ</ButtonRef>
            がONのときは、実は枠を小さく絞ること自体が読み取りを軽くします。解析するのは枠の中の映像だけになるため、
            狙った1本ぶんまで枠を小さくするほど、端末の負荷は下がります（読み取りの正確さはそのままです）。
          </p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <ButtonRef tone="primary">枠内のみ</ButtonRef>
              （既定でON）: 枠の中にあるバーコードだけを読み取ります。OFFにすると、カメラに写っている画面全体からバーコードを読み取ります。
              <strong className="text-slate-100">
                OFFにすると水色の枠自体が消えます
              </strong>
              （画面全体が対象なのに枠の外だけ暗いままだと紛らわしいため、枠・枠外を暗くする表示ごと消します）。
              「読み取り済み」の通知は、この状態ではカメラ映像の中央に表示されます。設定は端末に記憶されます。
            </li>
            <li>
              <ButtonRef icon={<SoundOnIcon className="h-4 w-4" />}>音</ButtonRef>
              で読み取り音のON/OFFを切り替えられます。
              <ButtonRef icon={<SoundOffIcon className="h-4 w-4" />}>OFF</ButtonRef>
              にしていても、端末の振動はそのまま鳴ります。
            </li>
            <li>
              <ButtonRef icon={<PauseIcon className="h-4 w-4" />} tone="amber">
                一時停止
              </ButtonRef>
              を押すと、バーコードの読み取りだけを止めます。カメラ映像はそのまま映り続けるので、もう一度押して
              <ButtonRef icon={<PlayIcon className="h-4 w-4" />}>再開</ButtonRef>
              すればすぐに読み取りを再開します。このボタンは
              <strong className="text-slate-100">「読み取り」が「常に読む」のとき</strong>だけ表示されます。
            </li>
            <li>
              <strong className="text-slate-100">読み取り</strong>
              （既定は「常に読む」）: バーコードを<strong className="text-slate-100">いつ読むか</strong>を切り替えます。設定は端末に記憶されます。
              <ul className="mt-1.5 list-[circle] space-y-1.5 pl-5">
                <li>
                  <ButtonRef tone="primary">常に読む</ButtonRef>
                  : これまで通りの動きです。カメラを向けている間ずっと読み取り続けます。棚卸しのように次々に読んでいく作業に向いています。
                </li>
                <li>
                  <ButtonRef tone="primary">長押し中だけ</ButtonRef>
                  :{' '}
                  <ButtonRef icon={<ScanIcon className="h-4 w-4" />}>押して読み取り</ButtonRef>
                  を<strong className="text-slate-100">指で押さえている間だけ</strong>読み取ります。指を離した瞬間に止まります。
                  現品票が密集していて、狙っていない隣のラベルまで勝手に拾ってしまう場所で使ってください。
                  ハンディターミナルのトリガーと同じ感覚で使えます。押している間はカメラ映像の下に
                  <strong className="text-cyan-300">「読み取り中」</strong>と表示されます。
                </li>
              </ul>
              <strong className="text-amber-300">
                「長押し中だけ」を選んでいる間は、一時停止ボタンは表示されません
              </strong>
              （押していないとき＝止まっているとき、なので一時停止する意味がないためです）。
            </li>
          </ul>
          <p className="text-sm text-slate-400">
            「画質」はバーコードモード専用ではなく共通設定（画面上部）に移りました。次のセクションを参照してください。
          </p>
        </Section>

        <Section title="共通設定（画質・整形）">
          <p>
            モード切り替えのすぐ下にある帯には、<strong className="text-slate-100">バーコード・文字どちらのモードでも使う設定</strong>
            だけをまとめてあります。ここに置いてあるのは「一度決めたらしばらく変えない」種類の設定で、モードを切り替えても
            位置も内容も変わりません。
          </p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <strong className="text-slate-100">画質</strong>
              （既定は「最大」）: カメラが取得する映像の解像度を「最大 / 標準 / 軽量」の3段階で切り替えられます。数値が大きいほど細かいところまで写るため、バーコードの細いバーも読み取りやすくなります。
              <strong className="text-slate-100">文字（OCR）モードの精度にも直接効きます。</strong>
              バーコードモードで端末の負荷が気になるときは、まずは
              <ButtonRef tone="primary">枠内のみ</ButtonRef>
              で枠を狙った1本ぶんまで小さくすることを先に試してください。それでも重いと感じる場合の追加の手段として画質を下げてください。
              <strong className="text-amber-300">
                「軽量」（720p相当）は読み取りが軽くなる代わりに、バーの細いバーコードを読み落としやすくなります。
              </strong>
              設定は端末に記憶されます。
            </li>
            <li>
              <ButtonRef>整形</ButtonRef>
              : バーコード・文字（OCR）どちらの読み取り値からも不要な部分を取り除く設定です。次のセクションで詳しく説明します。
            </li>
          </ul>
        </Section>

        <Section title="整形（トリミング）">
          <p>
            画面上部の共通設定バーにある
            <ButtonRef>整形</ButtonRef>
            を押すと、読み取った値から不要な部分を取り除く設定を開けます。
            <strong className="text-slate-100">
              バーコード・文字（OCR）どちらの読み取りにも同じ1つのルールが使われます。
            </strong>
            設定を2箇所に分けると現場が混乱するため、あえて1つに集約してあります。
          </p>
          <p>設定できるルールは次の5種類で、この順番でまとめて適用されます。</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>指定した文字列が最初に現れた位置までを捨てる（それより後ろを残す）</li>
            <li>指定した文字列が最初に現れた位置以降をすべて捨てる（スペースなどの区切り文字を指定するのに便利）</li>
            <li>前方一致する接頭辞を取り除く（複数指定できます）</li>
            <li>後方一致する接尾辞を取り除く（複数指定できます）</li>
            <li>最後に前後の空白を除去する</li>
          </ul>
          <p>
            パネルを開いた状態ではバーコードの自動読み取りは止まり、上部の
            <strong className="text-slate-100">プレビュー欄</strong>
            で今のルールを適用した結果をその場で確認できます（一覧にある直近の読み取り値が、バーコード・OCRどちらの結果でも初期値として入ります）。
          </p>
          <p>
            <strong className="text-slate-100">
              整形は「読み取りを受け付けた瞬間」のルールで確定し、一覧に積まれます。
            </strong>
            あとから整形の設定を変えても、既に一覧にある行には遡って効きません（バーコード・OCRとも共通の考え方です）。
            元の読み取り値も保持しており、整形によって値が変わったときだけ、その行の下に小さく
            <strong className="text-slate-100">「元の読み取り: 〜」</strong>
            として表示します。
            <strong className="text-amber-300">ルールを適用した結果が空文字になってしまう場合は、読み取りを無駄にしないよう元の値をそのまま使います。</strong>
          </p>
          <p>
            <strong className="text-slate-100">「読み取り済み」の判定（重複チェック）</strong>
            はバーコードだけの機能で、整形した後の値で行います。整形前の値が違っても、整形後の値が一致すれば同じバーコードとして扱われます
            （OCRの結果は「読み取り済み」の対象にはなりません）。
          </p>
          <p>
            <strong className="text-slate-100">文字（OCR）モードでは、次の順番で値が決まります。</strong>
            1. 「紛らわしい文字の手直し」でタップして直した後の生テキスト → 2. 整形 → 3. 抽出フィルタ（数字のみ等）。
            整形を先にするのは、フィルタで先に空白や記号を落としてしまうと、整形が探している区切り文字自体が消えて
            見つからなくなるためです。抽出フィルタだけは切り替えるたびに一覧の表示へ即座に反映されますが、
            整形はバーコードと同じく読み取った瞬間に確定します。エンジンが実際に返した生テキストは、手直し後も
            <strong className="text-slate-100">常に別行でそのまま表示され続けます</strong>
            （このアプリは生の認識結果を隠しません）。
          </p>
          <div className="flex gap-2.5 rounded-lg border border-slate-600 bg-slate-800/60 p-3.5">
            <p className="leading-relaxed">
              <strong className="text-cyan-200">GS（区切り文字）について:</strong>
              一部のバーコード（GS1-128など）は、複数の情報を1本の値に連結して持っており、その区切りに
              <span className="mx-1 font-mono text-slate-100">GS</span>
              という目に見えない制御文字（コード
              <span className="mx-1 font-mono text-slate-100">0x1D</span>
              ）を使います。実際のバーコードの中に
              <span className="mx-1 font-mono text-slate-100">(01)</span>
              のような丸カッコが入っていることはありません（カッコは印字ラベル等での人間向けの表記だけで、
              バーコード自体には数字とこのGS区切りしか入っていません）。
              整形の
              <span className="mx-1 font-mono text-slate-100">cutFrom</span>
              欄に
              <span className="mx-1 font-mono text-slate-100">\x1D</span>
              （またはエイリアスの
              <span className="mx-1 font-mono text-slate-100">\GS</span>
              ）と入力するか、
              <ButtonRef>GS(0x1D)以降を削除</ButtonRef>
              ボタンを押すと、GSより後ろをまとめて捨てられます。
              同様にタブ・改行も
              <span className="mx-1 font-mono text-slate-100">\t</span>
              <span className="mx-1 font-mono text-slate-100">\n</span>
              と入力できます。一覧やプレビューでは、こうした目に見えない文字を
              <span className="mx-1 font-mono text-slate-100">␝</span>
              のような記号にして見えるようにしています（実際の値そのものは変わりません）。
            </p>
          </div>
        </Section>

        <Section title="文字モード（OCR）">
          <p>
            <ButtonRef tone="primary">文字</ButtonRef>
            を選んでいる間は、
            <strong className="text-slate-100">バーコードの自動読み取りは止まります。</strong>
            このモードで一覧に追加されるのは、シャッターを押して明示的に読んだものだけです
            （カメラを向けているだけでは何も追加されません）。
          </p>
          <p>
            水色の枠（「文字を囲む」）は、OCRで読む範囲そのものです。読みたい文字の上にこの枠を合わせてください。
            バーコードモードの枠とは別物で、動かしてもバーコードモード側の枠には影響しません。
          </p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>枠の内側を指でドラッグすると、枠ごと移動します。</li>
            <li>枠のふちにある小さな丸い印をドラッグすると、その辺だけ大きさを変えられます。</li>
            <li>
              触っているうちに分からなくなったら、枠の左上にある
              <ButtonRef>枠をリセット</ButtonRef>
              で、今のモードの枠だけを元の位置・大きさに戻せます（もう一方のモードの枠には影響しません）。
            </li>
          </ul>
          <p>
            枠を合わせたら
            <ButtonRef icon={<ScanIcon className="h-4 w-4" />} tone="primary">
              枠内をOCR
            </ButtonRef>
            を押します。文字認識には Google ML Kit（端末に組み込み済み）を使うため、
            ダウンロードは不要で、電波が無い場所でもそのまま使えます。
          </p>
          <p>
            <strong className="text-amber-300">文字モードはAndroidアプリ（APK）版でのみ使えます。</strong>
            ブラウザ（このページをそのまま開いている場合）では ML Kit が使えないため、
            シャッターボタンが押せない状態になり、その旨の案内が表示されます。
          </p>
          <p>
            結果カードには、読み取り結果のほかにこのアプリで唯一の設定（抽出フィルタ・
            バーコード自動除外）がまとまっています。
            <strong className="text-slate-100">実物の現品票を読ませてみながら調整してください。</strong>
          </p>
        </Section>

        <Section title="紛らわしい文字の手直し">
          <p>
            結果カードの<strong className="text-slate-100">「生の読み取り結果」</strong>
            では、字形が紛らわしく読み間違えやすい文字（
            <span className="mx-1 font-mono text-slate-100">1↔I</span>
            <span className="mx-1 font-mono text-slate-100">0↔O</span>
            <span className="mx-1 font-mono text-slate-100">5↔S</span>
            <span className="mx-1 font-mono text-slate-100">8↔B</span>
            など）に
            <strong className="text-slate-100">下線</strong>
            が引かれ、タップすると見分けにくい別の字形に切り替えられます。もう一度タップすれば
            元に戻ります。直した内容は、結果一覧に積まれたその行の値・コピーする値にそのまま
            反映されます。
          </p>
          <p>
            <strong className="text-slate-100">
              どの文字が実際に読み間違いかは、このアプリには判定できません。
            </strong>
            そのため下線は「怪しいと判定された文字だけ」ではなく、
            <strong className="text-slate-100">対応表に載っている文字すべて</strong>
            に付いています。どこが間違っているかは、実物のラベルを見ているあなたが判断してください。
          </p>
          <p>
            <strong className="text-slate-100">エンジンが実際に返した文字そのもの（生テキスト）は、直した後も変わらず表示され続けます。</strong>
            何を直したのかが後から分からなくならないよう、このアプリでは生の認識結果を隠すことは一切ありません。
          </p>
        </Section>

        <Section title="読み取った画像の見かた">
          <p>
            OCRの結果が出ると、結果の横に小さな画像（サムネイル）が表示されます。これは
            <strong className="text-slate-100">実際に文字認識にかけたのとまったく同じ画像</strong>
            です。結果がおかしいときは、この画像を見れば「枠のずれ」や「ピントのボケ」が原因かどうかを判断できます。
          </p>
          <p>
            バーコード除外の設定を変えたときは、
            <ButtonRef>同じ画像で再認識</ButtonRef>
            を押せば、もう一度狙い直さずに、今の画像のまま読み直せます。抽出フィルタの切り替えだけは読み取り済みの結果を絞り込むだけなので、押さなくても表示がすぐに変わります。
          </p>
        </Section>

        <Section title="OCR設定の比較モード">
          <div className="flex gap-2.5 rounded-lg border border-amber-500/50 bg-amber-950/40 p-3.5">
            <WarningIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <p className="leading-relaxed text-amber-200">
              このアプリには、OCRの精度を数値で測る手段がありません。実物の現品票の画像も正解データも手元に無いためです。
              これまでの前処理の調整はすべて「良くなった気がする」という推論だけで積み重ねてきました。
              <strong className="text-slate-100">この比較モードは、その代わりに現場で実物を使って目で見比べ、判断してもらうための機能です。</strong>
            </p>
          </div>
          <p>
            結果カードの
            <ButtonRef>設定を比較</ButtonRef>
            （読み取り結果が出ているときだけ表示されます）を押すと、
            <strong className="text-slate-100">撮り直しはせず、いま撮った同じ1枚の画像</strong>
            に対して、前処理（罫線除去・バーコードの縞マスク・コントラスト正規化、または前処理なしの素の画像）の組み合わせをいくつも変えながらまとめて読み取り直し、結果を並べて見比べられます。
          </p>
          <p>
            <strong className="text-amber-300">
              どの結果が「正解」かはアプリには判定できません。正解が分かるのは、実物のラベルを見ているあなただけです。
            </strong>
            並んだ結果を見比べて、一番よく読めている設定の
            <strong className="text-slate-100">「この設定を使う」</strong>
            を押してください。押した設定（前処理の組み合わせ）はこのアプリに記憶され、以降のシャッターすべてに使われます。
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
            <li>
              カメラ映像右上の表示（例: <span className="font-mono">1920×1080</span>）は、端末が実際に提供している映像の解像度です。ここが
              <span className="font-mono">640×480</span>
              のように小さい場合、端末が高解像度の映像を出せておらず、小さいバーコードは構造的に読み取りにくくなります。
            </li>
            <li>
              対応機種では、カメラ映像下部に
              <span className="font-semibold text-cyan-200">「ズーム」</span>
              のスライダーが表示されます。小さいバーコードは、枠に近づく代わりにズームで大きく写すことでも読み取りやすくなります。
            </li>
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
          <p>
            QRコードなど、非常に長い値（数百〜数千文字）を読み取ったときは、一覧では先頭の300文字だけを表示し、
            <ButtonRef>全〇〇文字を表示</ButtonRef>
            を押すとその行だけ全文を開けます。
            <strong className="text-slate-100">短く表示しているのは画面表示だけで、コピーされるのは常に全文です</strong>
            （長い値をそのまま画面いっぱいに描画すると端末が重くなるための措置です）。
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

        <Section title="ライセンス情報">
          <p>
            このアプリは、OCRエンジン（Google ML Kit）・バーコード読み取り（zxing-wasm）・React などの
            オープンソースソフトウェアを利用して作られています。それぞれのライセンス本文は
            <strong className="text-slate-100">アプリの中に同梱</strong>してあり、通信できない場所でもそのまま読めます。
          </p>
          <button
            type="button"
            onClick={onOpenLicenses}
            className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-slate-800 text-base font-bold text-slate-100 active:bg-slate-700"
          >
            ライセンス情報を見る
            <ChevronRightGlyph />
          </button>
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
