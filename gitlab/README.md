# GitLab 用の定義とドキュメント

GitLab で運用するために必要なものをこのフォルダにまとめています。
アプリ本体のコードは変更不要です。

## 構成

```
.gitlab-ci.yml          ← 入口（GitLab が直下から読むため移動できない）
gitlab/
  README.md             ← このファイル
  ci/
    base.yml            ステージ順序、Node/pnpm の共通設定
    verify.yml          型チェック / Lint / テスト
    build.yml           ビルド + Service Worker の検査
    pages.yml           GitLab Pages への配信
    apk.yml             Android APK のビルド
  docs/
    self-hosted.md      社内GitLabで動かす前の確認事項（3点）
    migration.md        GitHub からの移行手順
  templates/
    pages-publish.yml   GitLab 17.9 以降向けの pages ジョブ
```

ルートの `.gitlab-ci.yml` は `include` だけの薄いファイルです。
定義を変えるときは `gitlab/ci/` 以下を編集してください。

## ジョブ

| ジョブ | 内容 | 実行条件 |
|---|---|---|
| `verify` | 型チェック / Lint / テスト | push・マージリクエスト |
| `build` | ビルド + Service Worker の検査 | `verify` 成功後 |
| `pages` | GitLab Pages へ配信 | 既定ブランチのみ |
| `apk` | Android APK のビルド | 手動、または `v` 始まりのタグ |

## 最初に読むもの

- **社内 GitLab で動かす場合** → [`docs/self-hosted.md`](docs/self-hosted.md)
  （**Pages が HTTPS でないとカメラが起動しません**。運用可否に直結するため必ず確認してください）
- **GitHub から移す場合** → [`docs/migration.md`](docs/migration.md)

## 配信パスについて

GitLab Pages はサブパス配信になりますが、`build` ジョブが `CI_PAGES_URL` から
パス部分を導出して `BASE_PATH` に渡します。
**プロジェクト名やグループ構成が変わっても、定義を直す必要はありません。**

| `CI_PAGES_URL` | 導出される `BASE_PATH` |
|---|---|
| `https://example.gitlab.io/dlabel-scanner` | `/dlabel-scanner/` |
| `https://example.gitlab.io/grp/sub/dlabel` | `/grp/sub/dlabel/` |
| `https://pages.example.co.jp` | `/` |

## GitHub Actions との対応

| GitHub | GitLab |
|---|---|
| `.github/workflows/ci.yml` の verify / build / deploy | `verify` / `build` / `pages` |
| `.github/workflows/apk.yml` | `apk` |
| Settings → Pages → Source の設定 | 設定不要（`pages` という名前のジョブが対象になる） |
| Actions の Artifacts | ジョブの Artifacts |

両方のファイルを残しても競合しません。GitHub は `.gitlab-ci.yml` を、
GitLab は `.github/` を、それぞれ無視します。移行期間中は併用できます。
