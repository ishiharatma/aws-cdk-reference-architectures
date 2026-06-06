# AWS ECS Fargate用 サンプルNode.js API

AWS ECS Fargateで動作するように設計されたサンプルNode.js REST APIサーバーです。

## 機能

- Express.jsベースのREST API
- ALBターゲットグループ用のヘルスチェックエンドポイント
- Helmetによるセキュリティヘッダー
- CORSサポート
- Morganによるリクエストログ
- マルチステージDockerビルドによる小さいイメージサイズ
- セキュリティのための非rootユーザー実行
- グレースフルシャットダウン対応
- Dockerヘルスチェック

## APIエンドポイント

### ヘルスチェック
- `GET /health` - サービスのヘルス状態を返す（ALBヘルスチェックで使用）

### メインエンドポイント
- `GET /` - API情報
- `GET /api/v1/items` - 全アイテムを取得
- `GET /api/v1/items/:id` - IDでアイテムを取得
- `POST /api/v1/items` - 新しいアイテムを作成
- `GET /api/v1/info` - システムと環境情報を取得

## ローカル開発

### 依存関係のインストール
```bash
npm install
```

### 開発モードで実行
```bash
npm run dev
```

### 本番モードで実行
```bash
npm start
```

サーバーはデフォルトでポート8080で起動します。

## Docker

### イメージのビルド
```bash
docker build -t example-nodejs-api .
```

### コンテナの実行
```bash
docker run -p 8080:8080 example-nodejs-api
```

### APIのテスト
```bash
curl http://localhost:8080/health
curl http://localhost:8080/api/v1/items
```

## ECS Fargateへのデプロイ

このアプリケーションは以下の機能を持つAWS ECS Fargateで動作するように設計されています：
- ポート8080を公開
- `/health`でのヘルスチェックエンドポイント
- グレースフルシャットダウンサポート
- 非rootユーザーでの実行
- 最適化されたマルチステージビルド

### 環境変数

- `PORT` - サーバーポート（デフォルト: 8080）
- `NODE_ENV` - 環境（development/production）
- `AWS_REGION` - AWSリージョン（ECSによって設定）
- `AWS_AVAILABILITY_ZONE` - アベイラビリティゾーン（オプション）

## セキュリティ機能

- Helmet.jsによるセキュリティヘッダー
- Dockerコンテナ内での非rootユーザー実行
- CORS有効化
- リクエストログ
- 入力検証
- エラーハンドリング

## コンテナヘルスチェック

Dockerイメージには30秒ごとに実行されるヘルスチェックが含まれています：
```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', ...)"
```

これはDockerとECSの両方でコンテナの健全性を監視するために使用されます。
