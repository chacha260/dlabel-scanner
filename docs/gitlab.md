# GitLab で運用する場合

GitHub Actions と同じことを GitLab CI で行う定義を `.gitlab-ci.yml` に用意しています。
リポジトリを GitLab に移すだけで、追加の設定なしにそのまま動きます。

## ジョブ構成

| ジョブ | 内容 | 実行条件 |
|---|---|---|
| `verify` | 型チェック / Lint / テスト | push・マージリクエスト |
| `build` | ビルド + Service Worker の検査 | `verify` 成功後 |
| `pages` | GitLab Pages へ配信 | 既定ブランチのみ |
| `apk` | Android APK のビルド | 手動、または `v` 始まりのタグ |

## セルフホスト GitLab（社内 GitLab）の場合

社内 GitLab で運用できれば、**配信・CI・ソースコードのすべてが社内で完結**します。
外部サービスを一切経由しなくなるため、GitHub Pages を使っている現在の状態より要件を強く満たせます。

事前に確認が必要な点は3つです。

### 1. GitLab Pages が有効か、HTTPS で配信されているか（最重要）

**カメラを使うには HTTPS が必須です。** ブラウザ側の決まりで、`http://` のページでは Chrome がカメラを拒否します。
社内 GitLab の Pages が `http://` で提供されている場合、**このアプリはカメラを起動できません。**

その場合の選択肢:

- Pages を HTTPS 化する（社内CAの証明書でも可。端末がその CA を信頼していること）
- Pages を使わず、APK を配布する（後述。この問題自体が無くなります）

### 2. Runner があるか

CI を動かすには Runner が必要です。Docker executor を推奨します。
`verify` / `build` / `pages` は `node:24` イメージで動きます。

### 3. APK ビルドは外部への接続が必要

`apk` ジョブは Android SDK（約 1GB）を Google のサーバーから取得します。
Runner が外部に出られない環境では、次のいずれかが必要です。

- Android SDK を同梱した社内イメージを用意し、`apk` ジョブの `image:` を差し替える
- APK ビルドだけ外部に出られる端末で行う

一度ビルドすれば APK 自体は社内で配布できるため、この制約は**ビルド時のみ**の話です。

## 配信パスについて

GitLab Pages は `https://<グループ>.gitlab.io/<プロジェクト>/` のようにサブパス配信になります。
`build` ジョブが `CI_PAGES_URL` からパス部分を取り出して `BASE_PATH` に渡すため、
**プロジェクト名やグループ構成が変わっても設定を直す必要はありません。**

| `CI_PAGES_URL` | 導出される `BASE_PATH` |
|---|---|
| `https://example.gitlab.io/dlabel-scanner` | `/dlabel-scanner/` |
| `https://example.gitlab.io/grp/sub/dlabel` | `/grp/sub/dlabel/` |
| `https://pages.example.co.jp` | `/` |

## `public/` の扱いについて

GitLab Pages は成果物が `public/` にあることを前提とします。
このリポジトリには Vite の入力用 `public/`（OCRエンジンを含む）が既にあるため、
`pages` ジョブでビルド結果に置き換えています。**置き換わるのは CI の作業コピーだけ**で、
リポジトリのファイルには影響しません。

GitLab 17.9 以降を使っている場合は、`pages` ジョブを次のように書き換えると
置き換え処理そのものが不要になります。

```yaml
pages:
  stage: deploy
  needs: [build]
  before_script: []
  script:
    - echo "dist をそのまま配信する"
  pages:
    publish: dist
  artifacts:
    paths:
      - dist
```

## GitHub と GitLab の対応

| GitHub | GitLab |
|---|---|
| `.github/workflows/ci.yml` | `.gitlab-ci.yml` の `verify` / `build` / `pages` |
| `.github/workflows/apk.yml` | `.gitlab-ci.yml` の `apk` |
| GitHub Pages | GitLab Pages |
| Actions の Artifacts | ジョブの Artifacts |
| Settings → Pages → Source | 設定不要（`pages` という名前のジョブが自動的に対象） |

両方のファイルを残しておいても競合しません。GitHub は `.gitlab-ci.yml` を、
GitLab は `.github/` を、それぞれ無視します。移行期間中は併用できます。
