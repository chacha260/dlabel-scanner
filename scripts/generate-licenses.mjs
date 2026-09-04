#!/usr/bin/env node
// 「利用パッケージ類のライセンス情報を同梱すること」を満たすための生成スクリプト。
//
// このアプリは完全オフライン・端末内完結（APK版は INTERNET 権限すら持たない）が
// 売りのため、サードパーティ製ライブラリのライセンス表記も「ビルド成果物に
// 同梱し、オフラインでアプリ内から閲覧できる」必要がある。外部サイト（各npm
// パッケージの GitHub ページなど）へのリンクで済ませる方式は、通信できない
// 前提のこのアプリでは成立しない。
//
// そこで実行時（production）依存として実際にビルドへ取り込まれるパッケージを
// 列挙し、各パッケージの package.json とライセンス本文ファイルを読み集めて、
// TypeScript モジュール `src/licenses/generated.ts` として書き出す。
//
// なぜ JSON を fetch する方式にしないか:
//   このアプリは CSP を厳しめに設定し、かつ完全オフラインで動く前提のため、
//   実行時に別ファイルを fetch する構成は「初回だけキャッシュされるまでは
//   ネットワークが必要」「Service Worker のキャッシュ漏れで真っ白になる」
//   といった失敗モードを増やすだけで嬉しさがない。TypeScript モジュールとして
//   バンドルに静的に取り込めば、アプリ本体と運命を共にするので単純である。
//
// なぜ生成物 (src/licenses/generated.ts) をリポジトリにコミットするか:
//   CI（GitHub Actions / GitLab CI）や APK ビルドの実行環境は、そのつど
//   `pnpm install` した node_modules の状態に依存する。ライセンス収集は
//   node_modules の実ファイル（LICENSE本文など）を読みに行く処理であり、
//   ビルドの都度ここで失敗し得る不安定な処理をビルドの必須経路に置きたくない。
//   生成物をコミットしておけば、ビルドは常に「リポジトリの中身をそのまま
//   固める」だけで完結し、再現性が高い。依存を追加・更新したときに
//   `pnpm run licenses` を手で叩いて再生成し、diff をレビューしてコミットする
//   運用にする（`pnpm run licenses:check` で生成物が最新か CI 上で検知できる）。
//
// 依存追加パッケージなし方針:
//   本スクリプトは Node 24 標準の fs/path/child_process のみで書く。
//   ライセンス収集専用の外部パッケージ（license-checker 等）は追加しない。
//
// 実行方法:
//   node scripts/generate-licenses.mjs
//   （= pnpm run licenses）

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// `--check` を付けると、生成物を書き換えずに「今コミットされている
// src/licenses/generated.ts が最新か」だけを検証して終了コードで返す
// （CI 用）。依存パッケージを追加・更新したのに `pnpm run licenses` を
// 再実行し忘れた場合に検知するための軽量なガードで、通常の `build` /
// `build:apk` の前段には組み込まない（CI 環境の node_modules の解決状況
// 次第で本来落ちるべきではないビルドまで巻き添えで失敗させたくないため。
// 判断の理由は docs/licenses.md を参照）。
const CHECK_ONLY = process.argv.includes('--check')

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const OUTPUT_PATH = join(REPO_ROOT, 'src', 'licenses', 'generated.ts')

// ライセンス本文らしきファイル名の候補。大文字小文字・拡張子のゆらぎ
// （LICENSE / LICENSE.md / LICENSE.txt / LICENCE / license-mit / COPYING …）
// に対応するため、正規表現で緩く判定する。
const LICENSE_FILE_RE = /^(licen[cs]e|copying)([._-].*)?$/i

/**
 * pnpm の依存ツリー（`pnpm ls --prod --depth Infinity --json`）を1段掘り、
 * このプロジェクトが実行時に実際に取り込むパッケージを name@version 単位で
 * 重複なく集める。
 *
 * `--prod` を付けることで devDependencies（vite, typescript, oxlint など、
 * ビルド成果物には含まれないツール類）を除外し、`--depth Infinity` で
 * 推移的依存（tesseract.js が引き連れる bmp-js 等）まで含める。
 */
function collectProductionDependencies() {
  const raw = execFileSync(
    'pnpm',
    ['ls', '--prod', '--depth', 'Infinity', '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const tree = JSON.parse(raw)
  const root = tree[0]

  // key: "name@version" → package.json のあるディレクトリの絶対パス。
  // 同じパッケージが複数の経路から依存される場合（例: tslib）は同一の
  // name@version に収束するため、Map で自然に重複排除される。
  const packages = new Map()

  function walk(dependencies) {
    if (!dependencies) return
    for (const [name, info] of Object.entries(dependencies)) {
      if (info.path && info.version) {
        packages.set(`${name}@${info.version}`, info.path)
      }
      walk(info.dependencies)
    }
  }
  walk(root.dependencies)

  return packages
}

/** author フィールド（文字列 / {name,email,url} オブジェクト / 欠落）を表示用の1行に正規化する。 */
function normalizeAuthor(author) {
  if (!author) return ''
  if (typeof author === 'string') return author.trim()
  const parts = []
  if (author.name) parts.push(author.name)
  if (author.email) parts.push(`<${author.email}>`)
  if (author.url) parts.push(`(${author.url})`)
  return parts.join(' ')
}

/** homepage が無い場合は repository.url を代わりに使う（git+ プレフィックスや .git 拡張子を除去）。 */
function normalizeHomepage(pkgJson) {
  if (typeof pkgJson.homepage === 'string' && pkgJson.homepage.length > 0) {
    return pkgJson.homepage
  }
  const repo = pkgJson.repository
  const repoUrl = typeof repo === 'string' ? repo : repo?.url
  if (typeof repoUrl === 'string' && repoUrl.length > 0) {
    // "owner/repo" 形式（npm の repository 省略記法）は GitHub の URL に展開する。
    if (/^[\w.-]+\/[\w.-]+$/.test(repoUrl)) {
      return `https://github.com/${repoUrl}`
    }
    return repoUrl.replace(/^git\+/, '').replace(/\.git$/, '')
  }
  return ''
}

/**
 * パッケージディレクトリ直下からライセンス本文ファイルを探す（サブディレクトリは見ない。
 * ライセンス本文は npm パッケージの慣習としてルート直下に置かれるため）。
 * 稀に MIT と CC0 のように複数のライセンス本文ファイルを持つパッケージ
 * （例: type-fest の license-mit / license-cc0）があるため、見つかった
 * ものは全て連結して収録する（どちらか一方を勝手に選んで情報を落とさない）。
 */
function findLicenseTexts(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const fileNames = entries
    .filter((name) => LICENSE_FILE_RE.test(name))
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()

  return fileNames.map((name) => ({
    name,
    text: readFileSync(join(dir, name), 'utf8').trimEnd(),
  }))
}

/** SPDX識別子が取れなかった場合に本文欄へ差し込む日本語の注記。 */
function missingLicenseTextNote(spdx) {
  const id = spdx || '不明'
  return `（このパッケージにはライセンス本文ファイルが同梱されていません。SPDX識別子: ${id}）`
}

function buildEntryFromPackageDir(name, version, dir) {
  const pkgJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const spdx = typeof pkgJson.license === 'string' ? pkgJson.license : ''
  const licenseFiles = findLicenseTexts(dir)

  const licenseText =
    licenseFiles.length > 0
      ? licenseFiles
          .map((f) =>
            licenseFiles.length > 1 ? `# ${f.name}\n\n${f.text}` : f.text,
          )
          .join('\n\n---\n\n')
      : missingLicenseTextNote(spdx)

  return {
    name,
    version,
    spdx: spdx || '不明',
    author: normalizeAuthor(pkgJson.author),
    homepage: normalizeHomepage(pkgJson),
    licenseText,
  }
}

// ---------------------------------------------------------------------------
// public/vendor/ 以下に手動でベンダリングされている配布物向けの手書きエントリ。
//
// これらは npm の依存解決（pnpm ls）には出てこない（ビルド時に vite が
// node_modules から拾うのではなく、開発者が事前にダウンロードして
// public/vendor/tesseract/ に置いたバイナリ／学習データのため）。しかし
// APK / PWA の成果物には実際に同梱され、かつサイズが大きいためユーザーが
// 実体を意識する対象でもあるので、npm パッケージと同格に一覧へ混ぜ込む。
//
// 出自:
//   - worker.min.js              … tesseract.js（Apache-2.0）の配布物
//   - tesseract-core-*.wasm(.js) … tesseract.js-core（Apache-2.0）の配布物
//   - tessdata/eng.traineddata   … tessdata_best 由来（Apache-2.0, Google /
//                                   tesseract-ocr）の英語学習データ
//   - zxing-wasm 同梱の zxing_reader.wasm … zxing-cpp（Apache-2.0）由来
//
// 本文は各プロジェクトが採用している Apache License 2.0 の正式な全文
// （どのプロジェクトも同一の定型文）をそのまま収録する。
// ---------------------------------------------------------------------------

const APACHE_2_0_TEXT = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS`

const MANUAL_VENDOR_ENTRIES = [
  {
    name: 'tesseract.js (worker.min.js)',
    version: '7.0.0',
    spdx: 'Apache-2.0',
    author: 'tesseract.js contributors (naptha)',
    homepage: 'https://github.com/naptha/tesseract.js',
    licenseText: `【同梱物について】\npublic/vendor/tesseract/worker.min.js は npm パッケージ tesseract.js の\n配布物（Web Worker 本体）を手動でダウンロードして同梱したものです。\npnpm の依存解決には出てきませんが、実際にビルド成果物へ含まれるため\n本一覧に手書きで追加しています。ライセンス本文は tesseract.js 本体と\n同じ Apache License 2.0 です。\n\n${APACHE_2_0_TEXT}`,
  },
  {
    name: 'tesseract.js-core (tesseract-core-*.wasm)',
    version: '7.0.0',
    spdx: 'Apache-2.0',
    author: 'tesseract.js-core contributors (naptha)',
    homepage: 'https://github.com/naptha/tesseract.js-core',
    licenseText: `【同梱物について】\npublic/vendor/tesseract/ 以下の次の4ファイルは、npm パッケージ\ntesseract.js-core の配布物（WebAssembly 版 Tesseract OCR エンジン本体）を\n手動でダウンロードして同梱したものです。pnpm の依存解決には出てきませんが、\n実際にビルド成果物へ含まれるため本一覧に手書きで追加しています。\n\n  - tesseract-core-lstm.wasm\n  - tesseract-core-lstm.wasm.js\n  - tesseract-core-simd-lstm.wasm\n  - tesseract-core-simd-lstm.wasm.js\n\nライセンス本文は tesseract.js-core 本体と同じ Apache License 2.0 です。\n\n${APACHE_2_0_TEXT}`,
  },
  {
    name: 'eng.traineddata (tessdata_best)',
    version: 'tessdata_best',
    spdx: 'Apache-2.0',
    author: 'Google / tesseract-ocr contributors',
    homepage: 'https://github.com/tesseract-ocr/tessdata_best',
    licenseText: `【同梱物について】\npublic/vendor/tesseract/tessdata/eng.traineddata は、Tesseract OCR の\n英語用学習済みモデル（tessdata_best リポジトリ由来）を手動でダウンロード\nして同梱したものです。npm パッケージではなく pnpm の依存解決には出てきま\nせんが、OCR機能の実行に必須のバイナリであり、実際にビルド成果物へ含まれる\nため本一覧に手書きで追加しています。ライセンスは配布元 tessdata_best と\n同じ Apache License 2.0 です。\n\n${APACHE_2_0_TEXT}`,
  },
  {
    name: 'zxing-cpp (zxing_reader.wasm)',
    version: 'zxing-wasm 3.1.3 同梱版',
    spdx: 'Apache-2.0',
    author: 'ZXing-C++ contributors',
    homepage: 'https://github.com/zxing-cpp/zxing-cpp',
    licenseText: `【同梱物について】\nnpm パッケージ zxing-wasm（本一覧に別項目あり、MITライセンス）が内部で\n同梱している zxing_reader.wasm は、zxing-wasm 自体のコードではなく、\nC++ 製バーコード読み取りライブラリ zxing-cpp を WebAssembly にビルドした\nものです。zxing-cpp 本体のライセンスは Apache License 2.0 であり、\nzxing-wasm のライセンス（MIT）とは別物のため、区別して掲載しています。\n\n${APACHE_2_0_TEXT}`,
  },
]

function toTsStringLiteral(value) {
  return JSON.stringify(value)
}

function formatEntry(entry) {
  return `  {
    name: ${toTsStringLiteral(entry.name)},
    version: ${toTsStringLiteral(entry.version)},
    spdx: ${toTsStringLiteral(entry.spdx)},
    author: ${toTsStringLiteral(entry.author)},
    homepage: ${toTsStringLiteral(entry.homepage)},
    licenseText: ${toTsStringLiteral(entry.licenseText)},
  },`
}

function main() {
  const packages = collectProductionDependencies()

  const npmEntries = [...packages.entries()].map(([key, dir]) => {
    const atIndex = key.lastIndexOf('@')
    const name = key.slice(0, atIndex)
    const version = key.slice(atIndex + 1)
    return buildEntryFromPackageDir(name, version, dir)
  })

  const allEntries = [...npmEntries, ...MANUAL_VENDOR_ENTRIES].sort((a, b) =>
    a.name.localeCompare(b.name),
  )

  const header = `// このファイルは \`pnpm run licenses\`（scripts/generate-licenses.mjs）による自動生成物です。
// 手で編集しないでください。依存パッケージを追加・更新したときは、このコマンドを
// 再実行してから diff をレビューし、コミットしてください。
//
// 生成物をリポジトリにコミットする理由や、public/vendor/ 配下の手動ベンダリング物を
// 手書きエントリで補っている理由は docs/licenses.md を参照してください。
// このアプリは完全オフラインで動くことが要件のため、ライセンス情報は
// （外部サイトへのリンクではなく）このモジュールとしてビルド成果物に静的に
// 同梱し、src/ui/LicenseSheet.tsx から表示します。
//
// 再生成コマンド: pnpm run licenses

export type LicenseEntry = {
  /** パッケージ名（手書きエントリは "パッケージ名 (同梱ファイル名)" の形式） */
  name: string
  /** パッケージのバージョン */
  version: string
  /** SPDX ライセンス識別子（取得できない場合は "不明"） */
  spdx: string
  /** 著作権者・作者表記 */
  author: string
  /** 配布元URL（参考情報。アプリ自体はオフライン動作のためリンクとしては使わない） */
  homepage: string
  /** ライセンス本文全文（原文のまま。日本語訳・改変はしない） */
  licenseText: string
}

export const LICENSES: LicenseEntry[] = [
${allEntries.map(formatEntry).join('\n')}
]
`

  if (CHECK_ONLY) {
    const current = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, 'utf8') : null
    if (current !== header) {
      console.error(
        'src/licenses/generated.ts が最新ではありません。`pnpm run licenses` を実行し、\n' +
          'diff をレビューしてコミットしてください（依存パッケージの追加・更新時は再生成が必要です）。',
      )
      process.exit(1)
    }
    console.log('src/licenses/generated.ts は最新です。')
    return
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, header, 'utf8')

  console.log(
    `生成しました: ${OUTPUT_PATH} (${allEntries.length} 件, うち手書きエントリ ${MANUAL_VENDOR_ENTRIES.length} 件)`,
  )
}

main()
