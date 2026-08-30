# AWS CDK Reference Architectures - Pattern Gallery

このディレクトリには、AWS CDKアーキテクチャパターンを表示するGitHub Pagesのサイトが含まれています。

## 📁 ファイル構成

- `index.html` - メインのHTMLファイル
- `app.js` - パターンの動的レンダリング用JavaScript
- `patterns.json` - アーキテクチャパターンのデータ

## 🚀 使い方

### ローカルでの確認

ローカルで確認する場合は、HTTPサーバーを起動してください：

```bash
# Python 3の場合
cd pages
python -m http.server 8000

# Node.jsの場合
npx http-server pages -p 8000
```

ブラウザで `http://localhost:8000` にアクセスしてください。

### GitHub Pagesへのデプロイ

1. GitHubリポジトリの Settings > Pages に移動
2. Source を `main` ブランチの `/pages` フォルダに設定
3. Save をクリック

数分後、GitHub PagesのURLでサイトが公開されます。

## ✨ 機能

- **検索機能**: タイトル、説明、タグで検索可能
- **フィルタリング**: 難易度やタグでフィルタリング
- **レスポンシブデザイン**: モバイル、タブレット、デスクトップに対応
- **AWS風デザイン**: Tailwind CSSを使用したAWSスタイルのUI

## 📝 新しいパターンの追加方法

`patterns.json` に新しいエントリを追加してください：

```json
{
  "id": "unique-pattern-id",
  "title": "パターンのタイトル",
  "description": "パターンの説明文",
  "image": "your-pattern/overview.drawio.svg",
  "tags": ["CDK", "TypeScript"],
  "link": "your-pattern",
  "difficulty": "beginner|intermediate|advanced",
  "level": 100,
  "date": "YYYY-MM-DD",
  "draft": false,
  "articles": {
    "devto": "https://dev.to/your-article-url",
    "zenn": "https://zenn.dev/your-article-url",
    "qiita": "https://qiita.com/your-article-url"
  }
}
```

### フィールド一覧

| フィールド | 必須 | 説明 |
| ---------- | ---- | ---- |
| `id` | ○ | パターンの一意な識別子（kebab-case）。表示はされず、エントリを区別するために使用。 |
| `title` | ○ | カードに表示されるタイトル。検索対象。 |
| `description` | ○ | カードに表示される短い説明。検索対象。 |
| `image` | - | 構成図。相対パス（`<id>/overview.drawio.svg`、このリポジトリ内で解決）または外部ホストの画像を指す `https://` フルURL。省略すると画像なしのカードになる。 |
| `tags` | ○ | タグ文字列の配列。検索とタグフィルタで使用。 |
| `link` | ○ | 「View Pattern」ボタンのリンク先。相対スラッグはこのリポジトリの `infrastructure/workspaces/<slug>` に解決される（末尾に `#readme` が付く）。`https://` フルURLはそのまま使われ、別リポジトリのパターンとして扱われる（下記参照）。 |
| `difficulty` | ○ | `beginner` / `intermediate` / `advanced`。難易度バッジと難易度フィルタを制御。 |
| `level` | - | AWSコンテンツレベル：`100` / `200` / `300` / `400` / `500`。`Lv.` バッジを制御。省略するとバッジ非表示。 |
| `date` | ○ | `YYYY-MM-DD`。ギャラリーのソート（新しい順）と `NEW` リボン（この日付から7日間表示）を制御。 |
| `draft` | - | `true` で `DRAFT` リボンを表示し、「View Pattern」ボタンをクリック不可の「Coming Soon」に切り替える。デフォルトは `false`。 |
| `articles` | - | `devto` / `zenn` / `qiita` の記事URLを持つ任意オブジェクト。設定されたキーごとにアイコンリンクを表示。 |

### 別リポジトリのパターンを参照する

`link` と `image` は既定でこのリポジトリ内で解決されます。自分の別の**公開**リポジトリにあるパターンを掲載したい場合は、フルURLを指定します：

```json
{
  "id": "my-external-pattern",
  "title": "My External Pattern",
  "description": "別の公開リポジトリで管理しているパターン。",
  "image": "https://cdn.jsdelivr.net/gh/ishiharatma/other-repo@main/docs/overview.drawio.svg",
  "tags": ["CDK", "TypeScript"],
  "link": "https://github.com/ishiharatma/other-repo",
  "difficulty": "advanced",
  "level": 300,
  "date": "2026-09-01",
  "articles": {}
}
```

- `link`：`http(s)://` のURLはそのまま使われる（`#readme` は付与されない）。カードに **External repo** バッジが表示される。
- `image`：`http(s)://` のURLはそのまま使われる。ただし `raw.githubusercontent.com` は `.svg` を `Content-Type: text/plain` で返すため `<img>` で表示されない。jsDelivr（`https://cdn.jsdelivr.net/gh/<user>/<repo>@<ref>/<path>`）、相手リポジトリの GitHub Pages URL、またはこのリポジトリの `pages/<id>/` に構成図をコピーする方法を使うこと。
- `pages.yml` のデプロイワークフローは `infrastructure/workspaces/*/` の構成図しかコピーしないため、外部画像は実行時にフルURLで到達可能である必要がある。

### 画像について

各パターンには `overview.png` を配置してください。画像は以下のように表示されます：
- カードの上部に200pxの高さで表示
- アスペクト比を保持して縮小表示（`object-fit: contain`）
- 背景色：ライトグレー（`#f8f9fa`）
- 画像をクリックするとモーダルで拡大表示されます

### 記事リンクについて

各パターンに関連する記事がある場合、`articles` フィールドでリンクを追加できます：

- **dev.to**: DEV Communityの記事URL
- **zenn**: Zennの記事URL
- **qiita**: Qiitaの記事URL

記事リンクが設定されている場合、カード内に各プラットフォームのアイコンリンクが表示されます。
リンクがないプラットフォームは非表示になります（全て省略可能）。

**表示されるアイコン:**
- **DEV** - 黒いアイコン（dev.to）
- **Z** - 青いアイコン（Zenn）
- **Q** - 緑のアイコン（Qiita）

## 📱 QRコード

ヘッダーの「QRコード」ボタンをクリックすると、ページURL（`https://ishiharatma.github.io/aws-cdk-reference-architectures/`）を指す`qr-code.svg`をモーダル表示します。ビルド時に事前生成した静的画像を埋め込んでいるだけなので、実行時に外部APIやクライアントサイドのJSライブラリは使用していません。

### URL変更時の再生成方法

GitHub PagesのURLが変わった場合は、[`qrcode`](https://www.npmjs.com/package/qrcode) npmパッケージでSVGを再生成してください：

```bash
npx qrcode -t svg -e M -q 1 -o pages/qr-code.svg "https://new-url-here/"
```

あわせて、モーダル内に表示しているURLテキスト（`index.html`の`.qr-modal-url`要素）も更新してください。

## 🎨 デザインのカスタマイズ

### カラーパレット

AWS風のカラーパレットを使用しています：

- AWS Orange: `#FF9900`
- AWS Squid (ダーク): `#232F3E`
- AWS Squid Light: `#37475A`

### 難易度バッジ

- **初級（beginner）**: 緑色
- **中級（intermediate）**: 黄色
- **上級（advanced）**: 赤色

## 🔧 開発

サイトは純粋なHTML/CSS/JavaScriptで構築されており、ビルドプロセスは不要です。

### 技術スタック

- HTML5
- Tailwind CSS (CDN)
- Vanilla JavaScript
- JSON for data storage

## 📄 ライセンス

このプロジェクトのライセンスについては、リポジトリのルートディレクトリにある LICENSE ファイルを参照してください。
