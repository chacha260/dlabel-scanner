# Android APK 版について

現品票・Dラベルスキャナを、GitHub Pages（ブラウザ版）とは別に、Capacitor で
Android の APK としてパッケージ化したものです。**ホスティング元（サーバー）を
一切介さず、端末内だけで完結して動く**ことがこの APK 版の目的です。HTML / JS /
CSS / WebAssembly（zxing、および OCR エンジンである PaddleOCR 一式）・アイコン
まで、すべて APK の中に同梱されています。ネットワーク通信の許可（`INTERNET`
権限）自体を持たないビルドにしているため、「通信しない設定にしている」では
なく「そもそも外部と通信できない」状態になっています（詳細は下記）。

このリポジトリの開発機には Java も Android SDK も入っていないため、APK の
ビルドは常に GitHub Actions 上（`.github/workflows/apk.yml`）で行います。
ローカルで `./gradlew` を実行することはありません。

## 1. APK をビルドする（ワークフローの起動方法）

GitHub のリポジトリページで以下のいずれかを行います。

- **手動実行**: `Actions` タブ → 左側の `APK ビルド` ワークフローを選択 →
  `Run workflow` ボタンから、対象ブランチを指定して実行します。
- **タグ push**: `v` から始まるタグ（例: `v1.0.0`）を push すると自動的に
  起動します。

```bash
git tag v1.0.0
git push origin v1.0.0
```

### タグ push でリリースする場合の手順と、CI が守っているもの

タグ push は「これを配布物としてリリースする」という宣言に等しいため、
手動実行より一段階多くの手順と注意点があります。

#### リリース手順

1. `android/app/build.gradle` の `versionCode` と `versionName` を
   **両方とも**上げます（同ファイルのコメントに明記されている運用
   ルールです。サイドロードで入れ替える運用のため、端末の
   「設定 → アプリ」でどちらのビルドが入っているか区別できるように
   するのが目的です）。
2. 変更をコミットします。
3. リリースするバージョンに合わせてタグを打ちます（例:
   `versionName` を `"1.3.0"` にしたなら `v1.3.0`）。

   ```bash
   git tag v1.3.0
   git push origin main --follow-tags
   # または、コミットは既に push 済みでタグだけ追加する場合
   git push origin v1.3.0
   ```

**タグ名 `vX.Y.Z` と `versionName` の `X.Y.Z` は必ず一致させてください。**
一致していない場合、後述のゲートにより Android ビルドへ進む前に CI が
落ちます（`v` を付け忘れてタグを打ってしまった、`versionName` の更新を
コミットし忘れた、といったケアレスミスを機械的に検出するためのもの
です）。

#### 重要な注意: タグ push では `ci.yml`（型チェック・Lint・テスト・Web版デプロイ）は走らない

`.github/workflows/ci.yml` は `push: branches: [main]` と Pull Request
でしか起動しません。**タグ push はこの条件に含まれないため、型チェック・
Lint・テスト・GitHub Pages へのデプロイは一切実行されません。** APK
ビルド用の `.github/workflows/apk.yml` はこれとは完全に独立したワーク
フローで、`pnpm run build:apk` が通ることだけは検査しますが、`tsc` /
`lint` / `test` は行いません。

そのため、**タグを打つ前に、必ず main への push（または PR のマージ）で
`ci.yml` を通しておいてください。** タグ push だけでリリースすると、
型エラーや Lint 違反、テスト失敗を抱えたままの APK が出来上がる
可能性があります。

#### APK ビルドで走るゲート一覧

タグ push（および手動実行）で動く `.github/workflows/apk.yml` は、
ビルドが成功するだけでは不十分だという前提で、次のゲートを持って
います。それぞれ、過去に実際へ起こりかねなかった、あるいは起こった
事故に対応しています。

| ゲート | 何を検査するか | 防いでいる事故 |
| --- | --- | --- |
| ビルドが通ること（`build:apk` → `gradlew assembleDebug`） | JS/TS のビルドと Gradle ビルドが最後まで成功するか | 壊れたコードのまま配布用 APK を作ってしまうこと |
| タグ名と `versionName` の一致 | タグ名から `v` を除いた文字列と `android/app/build.gradle` の `versionName` が同じか | `versionCode`/`versionName` の上げ忘れ（上げ忘れてもビルド自体は成功してしまうため、これまでは何にも守られていなかった） |
| `INTERNET` 権限が含まれていないこと | 依存ライブラリのマニフェストマージで `INTERNET` 権限が黙って復活していないか | このアプリの最も強いプライバシー保証（そもそも通信できない）が、ライブラリ追加のたびに静かに壊れること（詳細は本ドキュメント7節） |
| PaddleOCR 同梱物5ファイルが APK に含まれていること | `assets/public/vendor/` 以下に ONNX モデル2つ・辞書・ONNX Runtime の wasm/mjs が揃っているか | ビルドは成功するのに、実機で「精密読み取り」ボタンを押した瞬間だけモデルの取得に失敗するという、極めて気付きにくい壊れ方 |

いずれかのゲートに引っかかると、その時点でワークフローが失敗し、
APK は生成・アップロードされません。特にタグ名の一致検査は、10分以上
かかる Android ビルドより前（checkout 直後）に行われるため、ビルド
待ちをせずに素早く失敗が分かります。

#### 成果物の取り出し方

ビルドされた APK のダウンロード方法は、次の「2. ビルドされた APK を
ダウンロードする」を参照してください。GitHub Actions の該当 run の
Artifacts（`dlabel-scanner-debug-apk`、保持期間30日）から取得します。
これはデバッグ署名の APK であり、サイドロード用途専用です。Google Play
へは公開できません（詳しくは本ドキュメント9節）。

#### GitLab 側について

GitLab CI（`gitlab/ci/apk.yml`）も同じく `$CI_COMMIT_TAG` が `v` で
始まるタグ push で起動し、上記のうち「タグ名と `versionName` の一致」
「PaddleOCR 同梱物5ファイルの確認」の2つのゲートを同じ内容で持って
います。**ただし GitLab 側のジョブには、GitHub 側にある「`INTERNET`
権限が含まれていないことを確認」ゲートが元々ありません。** 現時点
ではこの差異は解消していないため、GitLab 側を本番運用に使う場合は
別途対応を検討してください。

## 2. ビルドされた APK をダウンロードする

1. GitHub の `Actions` タブから、起動したワークフローの実行（run）を開きます。
2. 実行が完了すると、画面下部の `Artifacts` に
   `dlabel-scanner-debug-apk` という名前の zip があるのでダウンロードします。
3. zip を展開すると `.apk` ファイルが出てきます。
4. 実行のサマリー画面（Summary）に APK のファイルサイズも表示されます。

アーティファクトの保持期間は 30 日です。それを過ぎると自動的に削除される
ため、必要な場合は早めにダウンロードしてください。

## 3. 端末にインストールする（サイドロード）

この APK は **デバッグ署名**（Android のデフォルトのデバッグ用鍵で署名）
されています。Google Play を経由しない「サイドロード」でのインストール専用
であり、Google Play への公開はできません（公開する場合はリリース用の
キーストアで署名し直す必要があります。詳しくは後述）。

1. ダウンロードした `.apk` ファイルを Android 端末に転送します
   （USBケーブル・社内共有ドライブなど、任意の方法で構いません）。
2. 端末のファイルアプリなどから `.apk` ファイルをタップします。
3. 初回は「この提供元のアプリはインストールできません」といった警告が
   出ます。**設定 → セキュリティ（または「アプリ」）→ 特定のアプリ
   （ファイルアプリ・ブラウザなど）に対して「不明なアプリのインストールを
   許可」**（端末やAndroidバージョンにより文言は「提供元不明のアプリ」
   「不明なソース」など）をオンにしてから、再度インストールを実行します。
4. インストール後、アプリ一覧に「Dラベル スキャナ」が表示されます。
5. 初回起動時にカメラの使用許可を求めるダイアログが出るので「許可」を
   選択してください（許可しないとバーコード/OCRスキャンが機能しません）。

## 4. 実機で必ず確認すべきこと

このリポジトリの開発機には実機の Android 端末も Android SDK も無いため、
以下は **すべて実機での確認が必須**です。

### リスク1: BarcodeDetector API が端末の WebView で使えない可能性

このアプリはバーコード検出に、まず OS 標準の `BarcodeDetector` API
（ネイティブ実装、高速）を試し、使えない場合は自動的に同梱の zxing-wasm
エンジンにフォールバックします（`src/scan/barcode/index.ts` の
`createBarcodeReader()` を参照）。

`BarcodeDetector` は元々 Chrome の機能であり、Android System WebView
（Capacitor アプリが内部で使う描画エンジン）でどこまで有効になっているかは
WebView のバージョンや端末・OSバージョンによって差があります。

- 使える場合: そのまま高速なネイティブ実装で動きます。
- 使えない場合: 自動的に zxing-wasm にフォールバックするため**アプリは
  問題なく動作しますが、認識速度が体感で落ちる可能性があります**。

どちらの経路を通っているかは、このリポジトリの環境からは判定できません。
実機でスキャンの反応速度を確認し、遅いと感じる場合はフォールバック経路に
入っている可能性がある、という前提で評価してください。

### リスク2: カメラ権限のフロー（`getUserMedia` と Android のランタイム権限）

Web版のカメラ起動は `navigator.mediaDevices.getUserMedia()`
（`src/camera/useCamera.ts`）を使っています。Capacitor の WebView
（`BridgeWebChromeClient`）のソースを確認したところ、次のように
**素の状態で正しく配線されている**ことを確認済みです。

- WebView が `getUserMedia` を検知すると `onPermissionRequest` が呼ばれ、
  要求リソースに `VIDEO_CAPTURE` が含まれる場合、Android の
  `CAMERA` ランタイム権限をダイアログで要求します（
  `PermissionRequest` → `ActivityResultContracts.RequestMultiplePermissions`）。
- ユーザーが許可すると `request.grant(...)` が呼ばれ、`getUserMedia` が
  解決されます。拒否すると `request.deny()` が呼ばれ、Web側は
  `NotAllowedError` を受け取ります（アプリ側は「カメラの使用が許可されて
  いません」と表示します）。

この配線自体はアプリ側で何もしなくても Capacitor のブリッジが標準で
面倒を見てくれます。ただし、以下は実機でしか確認できません。

- 実際に権限ダイアログが期待通り表示されるか
- 許可後にカメラ映像が `<video>` に表示され、トーチ・ズームなど
  `useCamera.ts` の各機能が動くか
- 端末を回転させても画面が縦向きに固定されるか（`AndroidManifest.xml` の
  `android:screenOrientation="portrait"` を指定済み）

### その他、実機で確認すべき項目一覧

- [ ] アプリが正常に起動し、白画面やクラッシュが発生しない
- [ ] カメラ権限ダイアログが表示され、許可後にカメラ映像が表示される
- [ ] バーコードのスキャンが実際に動作する（ネイティブ / zxing-wasm どちらでも可）
- [ ] **「枠内をOCR」ボタンで PaddleOCR による文字認識が動作すること**（重要）。
      初回は約35MB（モデル21MB + ONNX Runtime の wasm 14MB）の読み込みが
      走るので、進捗表示が出たうえで最終的に文字が読めることを確認する。
      数百ms〜数秒かかるのは仕様。なおこの経路はブラウザでも動くため、
      APK を焼く前に `pnpm dev` で先に確認しておくと切り分けが早い
- [ ] トーチ（フラッシュ）・ズームの操作が動作する端末では機能する
- [ ] コピー・削除・全部コピー・クリアなど一覧操作が動作する
- [ ] 画面回転しても縦向きに固定されている
- [ ] 機内モード（Wi-Fi・モバイル通信オフ）でも一切問題なく動作する
      （このアプリは `INTERNET` 権限自体を持たないため、通信が発生し
      ようがないことの再確認）
- [ ] アプリを再インストール・アップデートしても、古いキャッシュに
      引きずられた挙動（表示が更新されない等）が起きない
      （Service Worker を同梱していないため理論上は起こり得ないが、実機で確認）

## 5. なぜ Service Worker を APK に入れていないか

Web版（GitHub Pages）は `vite-plugin-pwa` による Service Worker で
オフラインキャッシュを実現していますが、APK 版ではアセット一式が
最初から端末内（APK 内）に同梱されているため、Service Worker による
キャッシュ機構そのものが不要です。それどころか、アプリをアップデート
（新しい APK を再インストール）した後も、前バージョンの Service Worker が
古いキャッシュを配信し続けてしまうリスクがあるため、あえて完全に無効化して
います。

`vite.config.ts` に `PACKAGED=1` というビルド時フラグを追加し、これが
立っているときは `vite-plugin-pwa` プラグイン自体をビルドから除外します。
`pnpm build:apk`（= `PACKAGED=1 pnpm build && cap sync android`）が
このフラグ付きビルドを行うコマンドです。通常の `pnpm build`
（GitHub Pages 向け）は今まで通り Service Worker を生成します。

## 6. CSP（Content-Security-Policy）について

`index.html` には外部通信を完全に遮断する厳格な CSP を meta タグで
設定しています。Capacitor の WebView は、index.html を配信する際に
ブリッジ用の JavaScript を **nonce なしのインライン `<script>` タグ**として
`<head>` の直後に注入します（`@capacitor/android` パッケージの
`JSInjector#getInjectedStream` を確認済み。サーバー側（`WebViewLocalServer`）
がレスポンスの HTML 文字列に直接文字列挿入する実装のため、静的な
ファイルとして配信されるわけではなく、nonce や `unsafe-inline` を使わずに
許可する方法がありません）。

Web版の CSP（`script-src 'self' 'wasm-unsafe-eval' blob:`）のままでは、
このインラインスクリプトがブロックされ、Capacitor のブリッジ機能
（プラグイン呼び出しなど）が動かなくなります。

そのため、**APK 用ビルド（`PACKAGED=1`）のときだけ**、ビルド後の
`dist/index.html` の CSP に `'unsafe-inline'` を `script-src` へ追加する
処理を `vite.config.ts` に実装しています（`packagedCspPlugin`）。
Web版のソース（`index.html` そのもの）や Web版のビルド成果物の CSP は
一切変更していません。それ以外のディレクティブ（`connect-src 'self'` など、
外部との通信を遮断する部分）はどちらのビルドでも変わりません。

## 7. `INTERNET` 権限について

`AndroidManifest.xml` から `android.permission.INTERNET` を削除しています。
根拠は次の通りです（`node_modules/@capacitor/android` 内の実際のソースを
確認済み）。

- Capacitor のコア（`@capacitor/android` の `capacitor` モジュール）の
  `AndroidManifest.xml` には権限宣言が一切ありません。
- `capacitor-cordova-android-plugins` の `AndroidManifest.xml` にも
  権限宣言はありません。
- WebView がアプリのアセットを読み込む仕組み（`WebViewLocalServer`）は、
  実際にソケット通信をするのではなく `shouldInterceptRequest` で
  リクエストを横取りして端末内のファイルを直接返しています。
- `CapacitorHttp` のような実際にネットワーク通信を行うプラグインは
  このアプリでは導入・使用していません。
- `capacitor.config.json` に `server.url`（開発時のライブリロード用の
  リモートURL指定）は設定されていません。

以上から、`INTERNET` 権限が無くても Capacitor のブリッジは問題なく
動作します。この APK は端末の設定を一切開かなくても「そもそもネットワークに
アクセスできない」ため、プライバシー要件に対する最も強い裏付けになります。

### マニフェストマージによる権限の「静かな復活」への対策

**「このアプリのマニフェストに書かない」だけでは不十分です。** Android の
マニフェストマージャは、依存ライブラリ（AAR）のマニフェストに書かれた
`<uses-permission>` を最終的なアプリのマニフェストへ**自動的に合流させます**。
つまりライブラリを1つ追加しただけで `INTERNET` が黙って復活し得ます。しかも
ビルドは成功するため、気付かないまま配布してしまいます。

以前 OCRエンジンとして ML Kit（`com.google.mlkit:text-recognition`。利用者の
判断で PaddleOCR 一本化に伴い削除済み、詳細は下記「10」）を追加した際、
このライブラリのマニフェストが `INTERNET` を宣言していないことを公式
ドキュメントから確認できませんでした。そこで2段構えで対策しています。
この対策自体は ML Kit を削除した現在も、将来どのライブラリを追加しても
権限が静かに復活しないための一般的な安全網として残しています。

1. `android/app/src/main/AndroidManifest.xml` で
   `<uses-permission android:name="android.permission.INTERNET" tools:node="remove" />`
   を宣言し、**合流してきても必ず取り除く**。
2. それが実際に効いているかは成果物を見るしかないため、`.github/workflows/apk.yml`
   に検証ステップ（「INTERNET 権限が含まれていないことを確認」）を追加し、
   **ビルドした APK の権限一覧を `aapt2 dump permissions` で実際に検査**して、
   `INTERNET` が含まれていたらビルドを失敗させる。

これにより、将来どのライブラリを追加しても、権限が静かに復活すれば必ず CI が
落ちます。この検証ステップは絶対に外さないでください。

## 8. アイコンについて

ランチャーアイコンは `public/icons/pwa-512x512.png`
（Web版 PWA と共通のロゴ）を各解像度（48/72/96/144/192px）にリサイズし、
`android/app/src/main/res/mipmap-*/ic_launcher*.png` として単純に配置した
ものです。Android のアダプティブアイコン（前景・背景レイヤーに分けて
ランチャーごとに形を変える仕組み）には対応させておらず、
`mipmap-anydpi-v26` の XML 定義は削除して、すべての Android バージョンで
この単純な正方形アイコンがそのまま使われるようにしています
（円形ランチャーでは角が見える場合がありますが、機能的な問題はありません）。

## 9. リリース署名について（今回は対象外）

今回ビルドしているのは **デバッグ署名の APK** です。Android SDK に
標準で入っているデバッグ用の鍵で署名されており、鍵の管理や GitHub
Secrets の登録が不要なぶん手軽ですが、次の制約があります。

- 同じ端末に別のデバッグ署名 APK（例: 他の開発者がビルドしたもの）を
  入れる場合、署名が異なると上書きインストールができず、
  一度アンインストールしてから入れ直す必要があります。
- **Google Play には公開できません。** Play ストアで配布する場合は、
  リリース用のキーストア（`keytool` で作成する秘密鍵）を用意し、
  GitHub Secrets に登録した上で `assembleRelease` ないし
  `bundleRelease` を使うようにワークフローを変更する必要があります。
  このリポジトリでは、社内配布（サイドロード）用途に限定して
  デバッグ署名のみをサポートしています。

## 10. OCRエンジンについて

**OCRエンジンは PaddleOCR（[onnxruntime-web](https://onnxruntime.ai/) による
WASM 実装）1本で、Web版（`pnpm dev` / GitHub Pages）・APK版のどちらでも
まったく同じように動作します。** 初回だけ約35MBの読み込みが走ります
（進捗はトーストで案内されます）。詳細は [`README.md`](../README.md) の
「3.5. 読めないとき用に PaddleOCR を追加」「9. ML Kit の削除・PaddleOCR
一本化」を参照してください。

以前は既定のOCRエンジンが Google ML Kit（`com.google.mlkit:text-recognition`、
Androidのネイティブ依存として APK に静的リンク）で、Capacitor の
ネイティブプラグイン経由でしか呼び出せないため APK 版でのみ動作し、
Web版では読めなかったとき用の第2のエンジンだった PaddleOCR に自動で
切り替えていました。実機比較の結果 PaddleOCR が ML Kit より明確に高精度
だったため、利用者の判断で ML Kit を完全に削除し、PaddleOCR 一本にして
います。これにより「Web版とAPK版でエンジンが違う」という状態自体が
無くなりました。

### 過去の経緯: tesseract.js を使っていた頃の学習データ同梱問題

このアプリは以前、tesseract.js（ブラウザ・APK両方で動くJS実装のOCR
エンジン）を使っており、Web版は学習データを初回利用時にネットワークから
ダウンロードし、APK版は学習データ一式を最初から APK に同梱していました。
このとき APK 版でだけ **OCR がまるごと使えなくなる不具合** が起きたことが
あり、その原因と対処を記録として残しておきます（tesseract.js は
実機比較の結果 ML Kit に精度で劣ることが分かり削除し、その ML Kit も
その後の実機比較で PaddleOCR に精度で劣ることが分かって削除済みです。
以下は tesseract.js を使っていた当時の話です）。

以前は学習データを gzip 圧縮した `eng.traineddata.gz`（約2.95MB、展開後
約5.2MB）として同梱し、tesseract.js の `gzip: true` オプションで、fetch
した内容の先頭バイトが gzip マジックバイト (0x1F 0x8B) であれば
`worker.min.js` にバンドルされた zlibjs（純JS実装）で展開する、という
方式を使っていました。

`.gz` を HTTP 相当の経路（Web版なら実際の HTTP、APK 版なら
`WebViewLocalServer#shouldInterceptRequest` によるアセット直接配信）で
運ぶ場合、fetch が受け取るバイト列が「gzip のまま」なのか「経路のどこかで
既に展開済み」なのかは、サーバーや WebView が `Content-Encoding: gzip`
を付与するかどうかに依存し、必ずしも一意に決まりません。特に APK 版では
次の2つの層が重なっていました。

- `WebViewLocalServer#shouldInterceptRequest` は端末内の APK 同梱アセット
  を直接返す実装で、レスポンスの MIME は
  `URLConnection.guessContentTypeFromName()` 任せ（`.gz` は
  `application/gzip` 等になる）になっており、Web版のような明示的な
  `Content-Encoding` の制御ができません。
- さらに `aapt`（Android のリソースパッケージングツール）が APK 内で
  `.gz` ファイルをもう一度 deflate 圧縮するため、実際には**二重に圧縮
  された状態**のバイト列がストリームとして配信されていました。

このどちらかの層で崩れると、約5MB分の純JS（zlibjs）による展開が
失敗し、学習データが読み込めないまま OCR エンジンの初期化自体が失敗
します。しかも当時はこの失敗が `ocr.worker.ts` の `handleWarmup` で
`catch {}` により完全に握りつぶされていたため、「OCRモードには入れるのに
認識だけが機能しない」という気付きにくい壊れ方をしていました。

そこで、学習データを非圧縮のまま `eng.traineddata` として同梱し、
`createWorker` に `gzip: false` を渡す方式に変更して当座をしのぎ、
最終的には tesseract.js 自体を削除して ML Kit に一本化しました。
ML Kit は Android のネイティブモデルであり、この種の「fetch 経路での
展開の曖昧さ」は構造的に発生し得ません。

### APK サイズについて

PaddleOCR（唯一のOCRエンジン）により、APK には次のものが同梱されます。

| 内訳 | サイズ |
| --- | --- |
| PaddleOCR 検出モデル（ONNX） | 4.7MB |
| PaddleOCR 認識モデル（ONNX） | 16.5MB |
| PaddleOCR 文字辞書 | 0.1MB |
| ONNX Runtime の wasm | 14MB |

合計約35MBです。以前は ML Kit（約4MB）と PaddleOCR（約35MB）を両方
同梱しており「読めないとき用の第2の手段」のために約35MBを追加で
背負っている構成でしたが、ML Kit を削除した現在は PaddleOCR 分の
約35MBだけが必要です。

**修正前は、この表の「ONNX Runtime の wasm 14MB」がもう1部余計に APK へ入っていました。** `onnxruntime-web` パッケージ内の「`wasmPaths` 未設定時のフォールバック」記述（`new URL("ort-wasm-simd-threaded.wasm", import.meta.url)`）を Vite が静的アセット参照として解決してしまい、`public/vendor/onnxruntime/` に置いた14MBのwasmと中身が同じファイルが `dist/assets/` 側にもう1部生成され、`PACKAGED=1`（APK版）のビルドでもそのまま同梱されていました。つまりこの表のPaddleOCR関連の合計はかつて実質**約49MB**（14MB分は完全な無駄）で、APKは今より14MB太っていたことになります。`vite.config.ts` に静的解決を回避する `patchOnnxruntimeWasmUrlPlugin` を追加して塞ぎ、上の表は現在の（重複が無い）実測値です。経緯の詳細は [`README.md`](../README.md) の「3.6. precache への14MBの二重同梱事故」を参照してください（この節はWeb版のService Worker precacheの文脈で書かれていますが、`dist/assets/` への二重生成自体はWeb版・APK版共通の欠陥でした）。

なお ML Kit を使っていた頃は、未使用スクリプト4種（中国語・デーヴァナーガリー・
日本語・韓国語、計約16MB）を `android/app/build.gradle` の
`configurations.all` で除外していましたが、ML Kit 自体の削除に伴って
この除外設定ごと削除しています。
