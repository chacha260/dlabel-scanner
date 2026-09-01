// バーコード値の「整形（トリミング）」ルールを編集する全画面パネル。
// HelpSheet.tsx と同じ構造（全画面オーバーレイ・上部に閉じるボタン・下端にも
// 閉じるボタン）に揃えてある。開いている間はカメラがどこを向いているか
// 分からなくなる（＝バーコード読み取りを止めるべき）点も HelpSheet と同じなので、
// SimpleScanScreen.tsx 側では isAnyOverlayOpen の trimPanelOpen フラグで
// 同様に扱う。
//
// テキスト入力欄（接頭辞/接尾辞・cutFrom・cutUpTo・プレビュー欄）は、いずれも
// 「実際の文字」ではなく「ユーザーが打てるエスケープ表記」（\t \n \x1D \GS）を
// そのまま画面上のテキストとして保持する。キー入力のたびに実文字へ変換して
// 表示テキストを作り直す方式にすると、バックスラッシュを打った瞬間に表示が
// 二重化される等カーソル位置が壊れるため、表示用テキスト自体を各欄のローカル
// state として保持し、ルールへ渡す実文字列は unescapeRuleText を通した
// 「派生値」として都度計算する（このコンポーネントが開閉のたびに作り直される
// ため、初期値の同期はマウント時の1回だけで良い）。

import { useState } from 'react'
import {
  applyTrimRules,
  escapeRuleText,
  GS_CUT_FROM,
  previewTrimRules,
  unescapeRuleText,
  visualizeControlChars,
  type TrimRules,
} from '../scan/barcode/trim'
import { CloseIcon, PlusIcon } from './components/Icons'
import { Switch } from './components/Controls'

type TrimPanelProps = {
  rules: TrimRules
  onChange: (next: TrimRules) => void
  /** 一覧にある直近のバーコード値（元の読み取り値）。プレビュー欄の初期値に使う */
  previewSeed: string | null
  onClose: () => void
}

const inputClass =
  'w-full min-h-11 rounded-lg border border-slate-600 bg-slate-900 px-3 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none'

function RuleListEditor({
  title,
  hint,
  rows,
  placeholder,
  onChangeRow,
  onAdd,
  onRemove,
}: {
  title: string
  hint: string
  rows: string[]
  placeholder: string
  onChangeRow: (index: number, text: string) => void
  onAdd: () => void
  onRemove: (index: number) => void
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-slate-100">{title}</p>
      <p className="mt-0.5 text-xs leading-snug text-slate-500">{hint}</p>
      <div className="mt-2 space-y-2">
        {rows.map((row, index) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={index} className="flex items-center gap-2">
            <input
              type="text"
              className={inputClass}
              value={row}
              placeholder={placeholder}
              onChange={(e) => onChangeRow(index, e.target.value)}
            />
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={`${title}の${index + 1}行目を削除`}
              className="shrink-0 rounded-full p-1.5 text-slate-400 active:bg-slate-700"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={onAdd}
          className="flex min-h-9 items-center gap-1 rounded-lg bg-slate-800 px-3 text-xs font-semibold text-slate-200 active:bg-slate-700"
        >
          <PlusIcon className="h-3.5 w-3.5" /> 行を追加
        </button>
      </div>
    </div>
  )
}

export default function TrimPanel({ rules, onChange, previewSeed, onClose }: TrimPanelProps) {
  const [prefixRows, setPrefixRows] = useState<string[]>(() => rules.stripPrefixes.map(escapeRuleText))
  const [suffixRows, setSuffixRows] = useState<string[]>(() => rules.stripSuffixes.map(escapeRuleText))
  const [cutFromText, setCutFromText] = useState<string>(() => escapeRuleText(rules.cutFrom))
  const [cutUpToText, setCutUpToText] = useState<string>(() => escapeRuleText(rules.cutUpTo))
  const [previewText, setPreviewText] = useState<string>(() => escapeRuleText(previewSeed ?? ''))

  function pushRules(patch: Partial<TrimRules>): void {
    onChange({ ...rules, ...patch })
  }

  function updatePrefixRow(index: number, text: string): void {
    const next = prefixRows.map((row, i) => (i === index ? text : row))
    setPrefixRows(next)
    pushRules({ stripPrefixes: next.map(unescapeRuleText) })
  }
  function addPrefixRow(): void {
    setPrefixRows((rows) => [...rows, ''])
  }
  function removePrefixRow(index: number): void {
    const next = prefixRows.filter((_, i) => i !== index)
    setPrefixRows(next)
    pushRules({ stripPrefixes: next.map(unescapeRuleText) })
  }

  function updateSuffixRow(index: number, text: string): void {
    const next = suffixRows.map((row, i) => (i === index ? text : row))
    setSuffixRows(next)
    pushRules({ stripSuffixes: next.map(unescapeRuleText) })
  }
  function addSuffixRow(): void {
    setSuffixRows((rows) => [...rows, ''])
  }
  function removeSuffixRow(index: number): void {
    const next = suffixRows.filter((_, i) => i !== index)
    setSuffixRows(next)
    pushRules({ stripSuffixes: next.map(unescapeRuleText) })
  }

  function handleCutFromChange(text: string): void {
    setCutFromText(text)
    pushRules({ cutFrom: unescapeRuleText(text) })
  }
  function handleCutUpToChange(text: string): void {
    setCutUpToText(text)
    pushRules({ cutUpTo: unescapeRuleText(text) })
  }
  function applyGsPreset(): void {
    setCutFromText(escapeRuleText(GS_CUT_FROM))
    pushRules({ cutFrom: GS_CUT_FROM })
  }

  // プレビューは「今の設定でONにしたら」という前提で常に計算する（enabled トグルが
  // OFFの間でもルールを組み立てながら効果を確認できるようにするため）。
  const previewSeedReal = unescapeRuleText(previewText)
  const preview = previewTrimRules(previewSeedReal, { ...rules, enabled: true })
  const previewResult = applyTrimRules(previewSeedReal, { ...rules, enabled: true })

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-slate-950 text-slate-100">
      <div
        className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <h1 className="text-xl font-bold text-slate-100">整形</h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="整形パネルを閉じる"
          className="rounded-full p-2 text-slate-300 active:bg-slate-800"
        >
          <CloseIcon className="h-7 w-7" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <section className="border-b border-slate-800 px-5 py-6">
          <Switch
            checked={rules.enabled}
            onChange={(checked) => pushRules({ enabled: checked })}
            label="バーコード値の整形を有効にする"
            hint="OFFの間は、下のルールを設定していても読み取った値はそのまま一覧に追加されます。"
          />
        </section>

        {/* プレビュー: 一覧の直近のバーコード値（無ければ空欄）を初期値にし、
            ルールを変えるたびに・プレビュー欄自体を書き換えるたびに即座に結果を再計算する。
            削られる部分は薄く・打ち消し線で、残る部分は目立たせて表示する。 */}
        <section className="border-b border-slate-800 bg-slate-900/60 px-5 py-6">
          <p className="text-sm font-semibold text-cyan-300">プレビュー</p>
          <p className="mt-0.5 text-xs leading-snug text-slate-500">
            一覧にある直近のバーコード値を初期値として、今のルールを適用した結果をその場で確認できます。
            制御文字（GSなど）は<span className="font-mono">\x1D</span>のような表記で入力してください。
          </p>
          <input
            type="text"
            className={`${inputClass} mt-2`}
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            placeholder="プレビューしたい値を入力（例: ABC123 DEF）"
            aria-label="プレビュー用の値"
          />
          <div className="mt-2 rounded-lg bg-slate-950 p-3">
            <p className="text-[10px] text-slate-500">結果に反映される部分（削られる部分は打ち消し線）</p>
            <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-sm">
              <span className="text-slate-600 line-through">{visualizeControlChars(preview.removedFront)}</span>
              <span className="font-bold text-cyan-300">{visualizeControlChars(preview.kept)}</span>
              <span className="text-slate-600 line-through">{visualizeControlChars(preview.removedBack)}</span>
              {previewSeedReal === '' && <span className="text-slate-600">(空欄)</span>}
            </pre>
            {preview.fellBackToOriginal && (
              <p className="mt-2 rounded bg-amber-950/60 px-2 py-1 text-[11px] font-semibold text-amber-200">
                ルールを適用すると結果が空文字になるため、元の値をそのまま使います。
              </p>
            )}
            <p className="mt-2 text-[10px] text-slate-500">実際に一覧に追加される値</p>
            <pre className="whitespace-pre-wrap break-all font-mono text-sm text-slate-100">
              {previewResult === '' ? '(空文字)' : visualizeControlChars(previewResult)}
            </pre>
          </div>
        </section>

        <section className="space-y-5 border-b border-slate-800 px-5 py-6">
          <RuleListEditor
            title="前方一致で取り除く接頭辞"
            hint="一致する文字列が複数あるときは、長いものから順に判定します（例: 'A' と 'ABC' なら 'ABC' が優先）。一致した最初の1つだけを1回取り除きます。"
            rows={prefixRows}
            placeholder="例: STORE01-"
            onChangeRow={updatePrefixRow}
            onAdd={addPrefixRow}
            onRemove={removePrefixRow}
          />
          <RuleListEditor
            title="後方一致で取り除く接尾辞"
            hint="接頭辞と同様、長いものから順に判定し、一致した最初の1つだけを1回取り除きます。"
            rows={suffixRows}
            placeholder="例: -END"
            onChangeRow={updateSuffixRow}
            onAdd={addSuffixRow}
            onRemove={removeSuffixRow}
          />
        </section>

        <section className="space-y-4 border-b border-slate-800 px-5 py-6">
          <div>
            <label className="block text-sm font-semibold text-slate-100" htmlFor="trim-cut-up-to">
              ここまでを捨てる（cutUpTo）
            </label>
            <p className="mt-0.5 text-xs leading-snug text-slate-500">
              指定した文字列が最初に現れた位置までを捨て、それより後ろだけを残します（マーカー自体は残りません）。
            </p>
            <input
              id="trim-cut-up-to"
              type="text"
              className={`${inputClass} mt-2`}
              value={cutUpToText}
              onChange={(e) => handleCutUpToChange(e.target.value)}
              placeholder="例: - （ハイフンより後ろを残す）"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-100" htmlFor="trim-cut-from">
              ここから先を捨てる（cutFrom）
            </label>
            <p className="mt-0.5 text-xs leading-snug text-slate-500">
              指定した文字列が最初に現れた位置以降をすべて捨てます。スペースや制御文字などの区切り文字を指定するのに使います。
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                id="trim-cut-from"
                type="text"
                className={inputClass}
                value={cutFromText}
                onChange={(e) => handleCutFromChange(e.target.value)}
                placeholder="例: (スペース) や \x1D"
              />
              <button
                type="button"
                onClick={applyGsPreset}
                className="shrink-0 rounded-lg bg-slate-800 px-3 py-2 text-xs font-semibold text-cyan-200 active:bg-slate-700"
              >
                GS(0x1D)以降を削除
              </button>
            </div>
          </div>

          <p className="text-xs leading-snug text-slate-500">
            タブ・改行・GS(0x1D) などの制御文字は、そのまま貼り付けるのではなく
            <span className="mx-1 font-mono text-slate-300">\t</span>
            <span className="mx-1 font-mono text-slate-300">\n</span>
            <span className="mx-1 font-mono text-slate-300">\x1D</span>
            （エイリアス: <span className="font-mono text-slate-300">\GS</span>）のように入力してください。
          </p>
        </section>

        <section className="border-b border-slate-800 px-5 py-6">
          <Switch
            checked={rules.trimWhitespace}
            onChange={(checked) => pushRules({ trimWhitespace: checked })}
            label="前後の空白を除去する"
            hint="他のルールを適用した後、最後に前後の空白（スペース・タブ等）を取り除きます。"
          />
        </section>

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
