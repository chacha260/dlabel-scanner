// バーコードの「誤読ガード」設定を編集する全画面パネル。
// TrimPanel.tsx と同じ構造（全画面オーバーレイ・上部と下端に閉じるボタン）に揃えてある。
// 開いている間はカメラがどこを向いているか分からなくなる（＝バーコード読み取りを
// 止めるべき）点も TrimPanel と同じなので、SimpleScanScreen.tsx 側では
// isAnyOverlayOpen のフラグに同様に加えて扱う。
//
// 設定項目が多い（有効シンボロジーのチェックリスト・チェックディジット検証・
// 桁数の範囲・見切れ検出・複数回一致）ため、バーコードモード共通の設定バーに
// 並べると破綻する。専用のパネルとして新規に作り、バーコードモードの設定
// （「読み取り」セグメントの並び）から開けるようにする。

import type { ReactNode } from 'react'
import {
  BARCODE_FORMAT_LABELS,
  DEFAULT_BARCODE_GUARD_RULES,
  type BarcodeGuardRules,
} from '../scan/barcode/guards'
import { SUPPORTED_FORMATS, type SupportedFormat } from '../scan/barcode/types'
import { CloseIcon } from './components/Icons'
import { Switch } from './components/Controls'

type BarcodeGuardPanelProps = {
  rules: BarcodeGuardRules
  onChange: (next: BarcodeGuardRules) => void
  onClose: () => void
}

const inputClass =
  'w-24 min-h-11 rounded-lg border border-slate-600 bg-slate-900 px-3 text-center font-mono text-sm text-slate-100 focus:border-cyan-400 focus:outline-none'

// 複数回一致の回数。既定2、1で実質無効化、3までを選択肢として提示する
// （設計上の上限。README・guards.ts の DEFAULT_BARCODE_GUARD_RULES 参照）。
const AGREEMENT_COUNT_OPTIONS = [1, 2, 3] as const

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-b border-slate-800 px-5 py-6">
      <div>
        <p className="text-sm font-semibold text-slate-100">{title}</p>
        {hint !== undefined && <p className="mt-0.5 text-xs leading-snug text-slate-500">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

export default function BarcodeGuardPanel({ rules, onChange, onClose }: BarcodeGuardPanelProps) {
  function pushRules(patch: Partial<BarcodeGuardRules>): void {
    onChange({ ...rules, ...patch })
  }

  // シンボロジーを1つも許可しない状態（＝バーコードが一切読めなくなる）は
  // 現場を詰ませるだけの壊れた設定なので、UI側でも最後の1つは外せないようにする
  // （prefs.ts の sanitizeEnabledFormats も、保存値がその状態になった場合は
  // 既定値へ戻す形で同じ方針を保険として持たせてある）。
  function toggleFormat(format: SupportedFormat): void {
    const enabled = rules.enabledFormats.includes(format)
    if (enabled) {
      if (rules.enabledFormats.length <= 1) return
      pushRules({ enabledFormats: rules.enabledFormats.filter((f) => f !== format) })
    } else {
      pushRules({ enabledFormats: [...rules.enabledFormats, format] })
    }
  }

  function handleMinLengthChange(text: string): void {
    const value = text === '' ? 0 : Math.max(0, Math.round(Number(text)))
    if (Number.isFinite(value)) pushRules({ minLength: value })
  }
  function handleMaxLengthChange(text: string): void {
    const value = text === '' ? 0 : Math.max(0, Math.round(Number(text)))
    if (Number.isFinite(value)) pushRules({ maxLength: value })
  }

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-slate-950 text-slate-100">
      <div
        className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <h1 className="text-xl font-bold text-slate-100">誤読ガード</h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="誤読ガード設定を閉じる"
          className="rounded-full p-2 text-slate-300 active:bg-slate-800"
        >
          <CloseIcon className="h-7 w-7" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <section className="border-b border-slate-800 bg-slate-900/60 px-5 py-6">
          <p className="text-xs leading-relaxed text-slate-400">
            バーコードが切れている等の際に、規格上は妥当だが実際とは違う値が読み取られてしまうことがあります。
            ここではその誤読を止めるための検証を設定します。
            <strong className="text-slate-100">QR・DataMatrix・PDF417（2次元シンボル）には適用しません</strong>
            （強力な誤り訂正を内蔵しており、デコードが成功した時点で内容が保証されているためです）。
          </p>
        </section>

        <Section
          title="有効なシンボロジー"
          hint="ここでチェックを外したフォーマットは、たとえ正しく読めていても読み取り結果に採用しません。現場のラベルで実際に使っているものだけに絞り込めます（既定は全種類ON）。"
        >
          <div className="flex flex-wrap gap-2">
            {SUPPORTED_FORMATS.map((format) => {
              const active = rules.enabledFormats.includes(format)
              return (
                <button
                  key={format}
                  type="button"
                  onClick={() => toggleFormat(format)}
                  aria-pressed={active}
                  className={`min-h-9 rounded-full border px-3 text-xs font-semibold ${
                    active
                      ? 'border-cyan-400 bg-cyan-400/10 text-cyan-300'
                      : 'border-slate-700 bg-slate-800 text-slate-500'
                  }`}
                >
                  {BARCODE_FORMAT_LABELS[format] ?? format}
                </button>
              )
            })}
          </div>
        </Section>

        <Section title="チェックディジット（数学的検算）">
          <Switch
            checked={rules.verifyGtinChecksum}
            onChange={(checked) => pushRules({ verifyGtinChecksum: checked })}
            label="GTINの検算（EAN-13・EAN-8・UPC-A・UPC-E・ITF）"
            hint="読み取った値のチェックディジットを検算し、合わないものは読み取りません。ITFは14桁（ITF-14/GTIN-14）のときだけ検算します。それ以外の桁数のITFはチェックディジットを持たない運用があるため対象外です。"
          />
          <Switch
            checked={rules.verifyCode39Checksum}
            onChange={(checked) => pushRules({ verifyCode39Checksum: checked })}
            label="Code39の検算"
            hint="Code39のチェックディジットは規格上「任意」で、付けていない運用の方が多いため既定はOFFです。チェックディジットを付けて運用している現場だけONにしてください。"
          />
          <p className="text-xs leading-snug text-slate-500">
            Code128は、チェックディジット（mod-103）がシンボロジー自体に内蔵されており、どのデコーダでも必ず検証済みのため、ここでの設定はありません。
          </p>
        </Section>

        <Section
          title="見切れ検出"
          hint="検出したバーコードの枠が、解析した画像の縁ぎりぎりにある場合は「見切れている」とみなして読み取りません。バーコードの一部だけが写って別の値に誤読されるケースに効きます。"
        >
          <Switch
            checked={rules.rejectTruncatedBox}
            onChange={(checked) => pushRules({ rejectTruncatedBox: checked })}
            label="見切れたバーコードを読み取らない"
          />
        </Section>

        <Section
          title="桁数の範囲"
          hint="読み取った値の文字数がこの範囲外なら読み取りません。0は無制限（未設定）を意味します。部分読みは本来より短い値になることが多いため、下限の設定が特に効きます。"
        >
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              下限
              <input
                type="number"
                inputMode="numeric"
                min={0}
                className={inputClass}
                value={rules.minLength === 0 ? '' : rules.minLength}
                placeholder="無制限"
                onChange={(e) => handleMinLengthChange(e.target.value)}
                aria-label="受け入れる値の最小文字数"
              />
            </label>
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              上限
              <input
                type="number"
                inputMode="numeric"
                min={0}
                className={inputClass}
                value={rules.maxLength === 0 ? '' : rules.maxLength}
                placeholder="無制限"
                onChange={(e) => handleMaxLengthChange(e.target.value)}
                aria-label="受け入れる値の最大文字数"
              />
            </label>
          </div>
        </Section>

        <Section
          title="複数回一致"
          hint="同じ値を連続してこの回数デコードできて初めて採用します。1回だけの偶発的な誤読に効きます（10fpsなので2回でも遅延は約100msです）。切れたバーコードを毎回同じように誤読する場合には効きません（その場合はチェックディジットや見切れ検出が効きます）。複数のバーコードが同時に画角に写っていても、値ごとに独立して数えます。"
        >
          <div role="radiogroup" aria-label="複数回一致の回数" className="inline-flex overflow-hidden rounded-lg border border-slate-600">
            {AGREEMENT_COUNT_OPTIONS.map((count) => (
              <button
                key={count}
                type="button"
                role="radio"
                aria-checked={rules.requiredAgreementCount === count}
                onClick={() => pushRules({ requiredAgreementCount: count })}
                className={`min-h-10 min-w-14 px-3 text-sm font-bold ${
                  rules.requiredAgreementCount === count
                    ? 'bg-cyan-500 text-slate-950'
                    : 'bg-slate-800 text-slate-300 active:bg-slate-700'
                }`}
              >
                {count}回
              </button>
            ))}
          </div>
          {rules.requiredAgreementCount <= 1 && (
            <p className="text-[11px] font-semibold text-amber-300">1回に設定すると、この機能は実質的に無効になります。</p>
          )}
        </Section>

        <div className="px-5 py-6">
          <button
            type="button"
            onClick={() => onChange(DEFAULT_BARCODE_GUARD_RULES)}
            className="flex min-h-11 w-full items-center justify-center rounded-lg bg-slate-800 text-xs font-bold text-slate-200 active:bg-slate-700"
          >
            既定値に戻す
          </button>
        </div>

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
