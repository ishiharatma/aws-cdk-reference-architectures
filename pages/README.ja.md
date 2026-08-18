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
  "image": "your-pattern/overview.png",
  "tags": ["CDK", "TypeScript"],
  "link": "your-pattern",
  "difficulty": "beginner|intermediate|advanced",
  "date": "YYYY-MM-DD",
  "articles": {
    "devto": "https://dev.to/your-article-url",
    "zenn": "https://zenn.dev/your-article-url",
    "qiita": "https://qiita.com/your-article-url"
  }
}
```

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
