# 社内 GitLab（セルフホスト）で動かす前に

社内 GitLab で運用できれば、**配信・CI・ソースコードのすべてが社内で完結**します。
外部サービスを一切経由しなくなるため、GitHub Pages を使っている現在の状態より
要件を強く満たせます。

導入前に確認すべき点が3つあります。1番目は運用可否そのものを左右します。

---

## 1. GitLab Pages が HTTPS で配信されているか ← 最重要

**カメラを使うには HTTPS が必須です。**
ブラウザ側の決まりで、`http://` のページでは Chrome がカメラを拒否します。
社内 GitLab の Pages が `http://` で提供されている場合、**このアプリはカメラを起動できません。**
アプリの作りの問題ではないため、コード側では回避できません。

### 確認方法

社内 GitLab で適当なプロジェクトの Pages を開き、URL が `https://` で始まり、
かつブラウザが証明書の警告を出さないことを確認してください。

### `http://` だった場合の選択肢

| 対処 | 内容 |
|---|---|
| Pages を HTTPS 化する | 社内CAの証明書でも可。ただし**利用する端末がその CA を信頼している**必要があります |
| APK を配布する | Pages を使いません。この問題自体が消えます（後述） |
| 端末側で例外設定する | Chrome の `chrome://flags/#unsafely-treat-insecure-origin-as-secure` に対象URLを登録。端末ごとの手作業になるため**検証用途向け**です |

**APK 配布は、この問題への最も確実な回答です。**
アプリ内に資産を同梱するため配信元が存在せず、HTTPS も証明書も不要になります。
`docs/apk.md` を参照してください。

---

## 2. Runner があるか

CI を動かすには Runner が必要です。Docker executor を推奨します。

| ジョブ | 使用イメージ |
|---|---|
| `verify` / `build` / `pages` | `node:24` |
| `apk` | `eclipse-temurin:21-jdk` |

Runner が無い場合でも、ビルド自体は手元で実行して成果物を配置できます。

```bash
pnpm install
BASE_PATH=/<Pagesのパス>/ pnpm build   # dist/ を Pages の配信先へ
```

---

## 3. Runner が外部に出られるか（APK ビルドのみ）

`apk` ジョブは **Android SDK（約1GB）を Google のサーバーから取得**します。
`verify` / `build` / `pages` は npm パッケージの取得だけで済むため、
社内ミラーがあれば閉じた環境でも動きます。

### 閉じた環境での選択肢

- **Android SDK を同梱した社内イメージを用意する** — `gitlab/ci/apk.yml` の `image:` を差し替え、
  `before_script` の SDK 取得部分を削除します
- **APK ビルドだけ外部に出られる環境で行う** — 一度ビルドすれば APK 自体は社内で配布できます

**この制約はビルド時のみ**です。できあがった APK は通信を行いません
（INTERNET 権限を持たないため、OS レベルで通信できません）。

---

## 確認が済んだら

`gitlab/docs/migration.md` に移行手順があります。
