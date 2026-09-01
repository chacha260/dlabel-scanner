# GitHub から GitLab へ移す手順

コードの変更は不要です。リモートを追加して push するだけで CI が動きます。

## 1. GitLab 側に空のプロジェクトを作る

README や .gitignore は**追加しない**でください。初回 push が衝突します。

## 2. リモートを追加して push

```bash
cd /home/sosi/app/dlabel-scanner
git remote add gitlab git@<GitLabのホスト>:<グループ>/<プロジェクト>.git
git push -u gitlab main
```

`origin`（GitHub）はそのまま残ります。両方に push したい場合:

```bash
git push origin main && git push gitlab main
```

## 3. CI が動くことを確認

push すると `verify` → `build` → `pages` が自動で走ります。
**GitHub Pages のような「Source を GitHub Actions に変更する」操作は不要**です。
GitLab は `pages` という名前のジョブを自動的に Pages の配信対象として扱います。

配信先の URL は、プロジェクトの **Deploy → Pages** で確認できます。

## 4. APK をビルドする

**Build → Pipelines** から対象のパイプラインを開き、`apk` ジョブを手動実行します。
または `v` で始まるタグを push すると自動で走ります。

```bash
git tag v0.1.0 && git push gitlab v0.1.0
```

完了後、ジョブページの **Artifacts** から APK をダウンロードできます。

---

## GitHub 側をどうするか

| 方針 | 対応 |
|---|---|
| GitLab に一本化する | GitHub のリポジトリを削除、または Archive する |
| 併用する | 両方に push する。設定ファイルは互いに無視されるため競合しません |
| GitHub を非公開にする | Settings → General → Change visibility → Private |

`.github/` と `.gitlab-ci.yml` は**互いに無視される**ため、両方残しても問題ありません。
GitHub は `.gitlab-ci.yml` を、GitLab は `.github/` を見ません。

---

## 移行後に直すべき記載

社内向けの説明文で「GitHub Pages を使っている」と書いている場合、
移行後は事実と異なります。次の点を書き換えてください。

- 配信元が社内 GitLab になり、**外部への接続が発生しなくなった**こと
- ソースコードの公開設定（GitHub で Public だった場合、社内 GitLab では社内限定になる）

移行はこの説明文にとって**良い方向の変更**なので、報告する価値があります。
