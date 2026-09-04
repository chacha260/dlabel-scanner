# Android APK 版について

現品票・Dラベルスキャナを、GitHub Pages（ブラウザ版）とは別に、Capacitor で
Android の APK としてパッケージ化したものです。**ホスティング元（サーバー）を
一切介さず、端末内だけで完結して動く**ことがこの APK 版の目的です。HTML / JS /
CSS / WebAssembly（zxing・tesseract）・OCRエンジン一式・アイコンまで、
すべて APK の中に同梱されています。ネットワーク通信の許可（`INTERNET`
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
- [ ] 「枠内をOCR」ボタンでOCR認識が動作する（初回から追加ダウンロードなしで動くこと）
- [ ] OCRの学習データ（eng.traineddata）が読み込めること（OCRモードに入った
      直後、または「枠内をOCR」実行時に「学習データを読み込めませんでした」
      という趣旨のエラーにならないこと。以前 .gz 展開に依存していた頃、
      この読み込みが実機でだけ失敗し OCR が丸ごと使えなくなる不具合があった）
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

## 10. OCRエンジンについて（Web版との違い）

Web版では OCRエンジン（tesseract.js、約9〜16MB）は初回利用時にのみ
ネットワークからダウンロードし、以降は Service Worker のキャッシュで
オフライン動作します。APK 版ではこのエンジン一式が **最初から APK に
同梱**されているため、インストール直後・初回起動時から、通信なしで
即座に OCR が使えます。これは Web版に対する明確な利点です
（そのぶん APK 自体のサイズは大きくなります）。

### 学習データ（eng.traineddata）を非圧縮で同梱している理由

以前は学習データを gzip 圧縮した `eng.traineddata.gz`（約2.95MB、展開後
約5.2MB）として同梱し、tesseract.js の `gzip: true` オプションで、fetch
した内容の先頭バイトが gzip マジックバイト (0x1F 0x8B) であれば
`worker.min.js` にバンドルされた zlibjs（純JS実装）で展開する、という
方式を使っていました。この構成が、**APK 版で OCR がまるごと使えなくなる
不具合の原因**になっていたことが分かっています。

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
します。しかも以前はこの失敗が `ocr.worker.ts` の `handleWarmup` で
`catch {}` により完全に握りつぶされていたため、「OCRモードには入れるのに
認識だけが機能しない」という気付きにくい壊れ方をしていました。

そこで、**学習データを非圧縮のまま `eng.traineddata` として同梱し、
`createWorker` には `gzip: false` を渡す**方式に変更しました。これにより
上記の曖昧な展開経路そのものが無くなり、fetch したバイト列がそのまま
学習データとして使われます。

APK 全体のサイズへの影響はほぼありません。`aapt` はもともと APK 内の
アセット一式を（`.gz` かどうかに関わらず）deflate 圧縮して格納するため、
「非圧縮の `eng.traineddata` を同梱する」場合と「あらかじめ gzip 済みの
`eng.traineddata.gz` を同梱する」場合とで、最終的な APK のファイルサイズ
はほとんど変わりません（二重圧縮という不具合の芽だけが無くなります）。

なお、warmup の失敗を握りつぶしていた問題も合わせて修正しており、
現在は学習データの読み込みに失敗した場合、その旨が
「学習データを読み込めませんでした」という日本語メッセージとともに
呼び出し側（`preloadOcr` の戻り値）に伝わるようになっています
（`preloadOcr` 自体は失敗時も reject しません。既存の
`void preloadOcr(...)` という呼び出し方を壊さないためです）。
