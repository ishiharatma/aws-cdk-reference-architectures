# API Gateway + Lambda Web Adapter (Express.js) - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **レベル: 300 (中級)**

Todos REST API を、**標準的な Express.js の HTTP サーバー**を動かす **1 つの** Lambda 関数で提供します。[AWS Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter) レイヤーがランタイムの前段に入り、API Gateway のプロキシイベントを `http://localhost:8080` への本物の HTTP リクエストに変換し、その HTTP レスポンスを Lambda の結果に戻します。アプリケーションコードには **`handler(event, context)` が存在せず**、AWS Lambda の型も出てきません。Fargate で `docker run` する場合やローカルで `node` する場合とまったく同じ `app` です。

これは、**同じ API** を 3 通りに実装して API Gateway + Lambda の統合スタイルを直接比較するための 3 つのワークスペースのうちの 1 つです。

| ワークスペース | 関数の数 | ルーティング | 一言で言うと |
|-----------|-----------|---------|------------------|
| [`apigw-single-purpose-lambda`](../apigw-single-purpose-lambda/) | ルートごとに 1 つ | API Gateway | 最大の分離：ルートごとに専用の関数・ロール・権限。 |
| [`apigw-lambdalith`](../apigw-lambdalith/) | 1 つ | Hono（プロセス内） | 1 関数・1 デプロイ単位・フレームワークによるルーティング。 |
| **`apigw-lambda-web-adapter`**（本書） | 1 つ | Express（プロセス内） | Lambda Web Adapter レイヤーの背後で動く標準的な Express サーバー。 |

## 📑 目次

- [アーキテクチャ概要](#-アーキテクチャ概要)
- [Lambda Web Adapter の仕組み](#-lambda-web-adapter-の仕組み)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [パターン比較](#-パターン比較)
- [Well-Architected との対応](#-well-architected-との対応)
- [コスト最適化](#-コスト最適化)
- [セキュリティに関する考慮事項](#-セキュリティに関する考慮事項)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [使い方](#使い方)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![アーキテクチャ図](overview.drawio.svg)

### 主要コンポーネント

- **Amazon API Gateway (REST API)** — 単一の貪欲プロキシリソース `ANY /{proxy+}`（`LambdaRestApi` の `proxy: true`）。ルーティング・検証・メソッド単位設定はなく、すべてのリクエストが `AWS_PROXY` イベントになります。
- **AWS Lambda (`WebAdapterHandler`)** — Node.js 22 / ARM64 の関数 1 つ。バンドルされるコード（`src/index.ts`）は実質 `app.listen(8080)` を呼ぶだけ。エクスポートされた `handler` は決して呼ばれないプレースホルダーです。
- **Lambda Web Adapter レイヤー** — `arn:aws:lambda:<region>:753240598075:layer:LambdaAdapterLayerArm64:24` を `LayerVersion.fromLayerVersionArn` で参照。`AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap` と組み合わさり、通常の Node ハンドラーループを、イベントをローカル HTTP サーバーへプロキシするループに置き換えます。
- **Express アプリ (`src/app.ts`, `src/routes/todos.ts`)** — ふつうの Express：`express.json()` のボディパース、`GET /health` の readiness ルート、5 つの CRUD ハンドラーを持つ `/todos` ルーター。AWS 固有のコードはありません。
- **Amazon DynamoDB (`TodosTable`)** — オンデマンド、パーティションキー `todoId`、SSE（AWS マネージドキー）、PITR 有効。関数ロールへ `grantReadWriteData` を 1 回。
- **可観測性** — 関数専用ロググループ（保持 1 週間）+ API Gateway アクセスログ（JSON・標準フィールド）+ ステージの `INFO` メソッドログ。

### アダプターを配線する環境変数

| 変数 | 値 | 目的 |
|----------|-------|---------|
| `AWS_LAMBDA_EXEC_WRAPPER` | `/opt/bootstrap` | Lambda ランタイムに、既定の Node ブートストラップではなくアダプターのラッパースクリプト経由で起動するよう指示。 |
| `PORT` | `8080` | アダプターが転送するポート。Express は `app.listen(process.env.PORT)` を呼ぶ。 |
| `READINESS_CHECK_PATH` | `/health` | サンドボックスを ready にする前にアダプターがこのパスをポーリングし、`2xx` を待つ。最初の実リクエストがアプリ起動と競合しない。 |
| `TABLE_NAME` | *(参照)* | `src/utils/dynamodb.ts` の DynamoDB SDK クライアントに渡される。 |

## 🔌 Lambda Web Adapter の仕組み

```
API Gateway ──AWS_PROXY イベント──▶ Lambda サンドボックス
                                    ├─ /opt/bootstrap（アダプター）  ◀─ AWS_LAMBDA_EXEC_WRAPPER
                                    │     1. コールドスタート時: `node src/index.js` を起動 → app.listen(8080)
                                    │     2. GET :8080/health が 2xx になるまでポーリング（READINESS_CHECK_PATH）
                                    │     3. 呼び出しごと: イベント → HTTP リクエスト → :8080 → HTTP レスポンス → 結果
                                    └─ :8080 の Express アプリ
```

アダプターは Rust 製の Lambda **拡張機能**です。リクエストごとの遅延は実測でほぼ増えず（ループバックの HTTP 呼び出し）、コールドスタート時に HTTP サーバーの起動と readiness チェック通過分の一度きりのコストが加わります。

## 🎯 設計判断とベストプラクティス

### 1. Lambda ハンドラーを書かず、本物の HTTP サーバーを動かす

**判断**: ふつうの Express アプリをパッケージし、イベントモデルの橋渡しは Lambda Web Adapter に任せる（`hono/aws-lambda`（[`apigw-lambdalith`](../apigw-lambdalith/)）や手書きの `handler(event)` ではなく）。

**根拠**:
- ✅ **アプリケーションコードに AWS への結合がゼロ** — `@types/aws-lambda` も `APIGatewayProxyEvent` もない。同じイメージが Lambda・App Runner・ECS/Fargate・ノート PC 上の `node` で**ビルドの分岐なし**に動く。
- ✅ **リフト & シフト** — 既存の Express/Fastify/Koa/Next.js サービスは、エントリポイントを書き直すのではなく、レイヤー 1 つと環境変数 3 つを足すだけで Lambda に移る。
- ✅ **馴染みのあるローカル開発** — `npm start` が実際の本番コードパス（実ポート上の実サーバー）であり、エミュレーターではない。
- ✅ フレームワークのエコシステム（ミドルウェア・ルーター・エラーハンドラー）がそのまま動く。

**トレードオフ**:
- ❌ **3 パターン中もっとも大きいコールドスタート** — バンドルは約 1 MB（Express + 依存）で、最初のレスポンスの前にアダプターがサーバー起動と readiness チェックを終える必要がある。レイテンシ重視なら SnapStart（Node 22）やプロビジョンド同時実行で緩和する。
- ❌ 可動部（レイヤー）が 1 つ増え、そのバージョンを追う必要がある。レイヤー ARN はリージョンとアーキテクチャ固有。
- ❌ IAM が粗く、デプロイの影響範囲も粗い（Lambdalith と同じく 1 ロール・1 デプロイ単位）。
- ❌ ストリーミングレスポンスには Lambda レスポンスストリーミングと対応するアダプターモードが必要。素のバッファ統合は 6 MB が上限。

### 2. レイヤー ARN をリージョンとバージョンで固定する

```typescript
const webAdapterLayer = lambda.LayerVersion.fromLayerVersionArn(
  this, 'LambdaWebAdapterLayer',
  `arn:aws:lambda:${cdk.Stack.of(this).region}:753240598075:layer:LambdaAdapterLayerArm64:24`,
);
```

**根拠**:
- ✅ `753240598075` はすべての商用リージョンでアダプターを公開している AWS 所有のアカウント。`region` を差し込むことでスタックはリージョン可搬になる。
- ✅ バージョン（`:24`）を固定してデプロイを再現可能にする。新しいアダプターのリリースで挙動が黙って変わらない。
- ⚠️ レイヤー名の `Arm64` は関数の `architecture: lambda.Architecture.ARM_64` と**一致していなければならない**。現在のバージョンと `X86_64` バリアントは[リリースページ](https://github.com/awslabs/aws-lambda-web-adapter/releases)で確認する。

### 3. `READINESS_CHECK_PATH=/health`

**判断**: `GET /health` を公開し、アダプターをそこに向ける。

**根拠**:
- ✅ アダプターはサーバーが `2xx` を返すまで最初の呼び出しを保留するため、Express がポートをバインドしている最中のコールドスタートで接続拒否エラーを返さない。
- ✅ 同じエンドポイントは、イメージを後でコンテナとして動かす場合の ALB/App Runner ヘルスチェックの自然なターゲットになる。

### 4. `LambdaRestApi` プロキシ + ステージログ

Lambdalith と同一：`ANY /{proxy+}` 1 つ、`cloudWatchRole: true`、ステージにアクセスログ（`jsonWithStandardFields`）と `INFO` メソッドログ。ルート追加は Express の変更のみで、**CloudFormation の差分はなし**。

### 5. 環境固有パラメータ

リージョン/アカウントは `EnvParams`（`parameters/<env>-params.ts`）から取得。`isAutoDeleteObject`（`dev` のみ）が DynamoDB の `RemovalPolicy` を制御し、`terminationProtection` は `prd` で有効。

## 🔀 パターン比較

| 観点 | Single-Purpose Lambda | Lambdalith (Hono) | **Lambda Web Adapter（本書）** |
|--------|----------------------|-------------------|-------------------------------|
| Lambda 関数の数 | ルートごとに 1（5 個） | 1 個 | **1 個** |
| ルーティング担当 | API Gateway | Hono（プロセス内） | **Express（プロセス内）** |
| アプリ ↔ AWS の結合 | ハンドラーごとに `APIGatewayProxyEvent` | `hono/aws-lambda` のエントリファイル | **なし — 素の Express** |
| API Gateway の形 | 明示的なリソース + メソッド | `ANY /{proxy+}` | **`ANY /{proxy+}`** |
| IAM の粒度 | ルート単位 | 1 ロール = 和集合 | **1 ロール = 和集合** |
| コールドスタートの重さ | 最軽量（極小バンドル） | 軽量（小バンドル） | **最重量（サーバー + レイヤー + readiness）** |
| Fargate / ローカルで無変更で動くか | 不可 | アダプター差し替え | **可** |
| 追加のインフラ可動部 | なし | なし | **アダプターレイヤー（バージョン管理・リージョン別）** |
| デプロイの影響範囲 | 1 関数 | API 全体 | **API 全体** |
| 向いている場面 | ルートごとに異なるスケール / セキュリティ / 所有 | 小〜中規模 API、単一チーム | **既存の Node Web アプリの移行、複数ターゲットへのデプロイ** |

## 🏛️ Well-Architected との対応

| 柱 | 実装 |
|--------|---------------|
| **運用上の優秀性** | 成果物 1 つ・デプロイ 1 回。ローカルの `npm start` が本番のコードパス。ステージにアクセス + `INFO` ログ。保持期間付きの関数専用ロググループ。 |
| **セキュリティ** | 1 つの DynamoDB テーブルに限定した最小権限ロール 1 つ。SSE + PITR。TLS のみのエンドポイント。認証認可と WAF はドキュメント化された追加項目。 |
| **信頼性** | マネージドの API Gateway + Lambda + DynamoDB、マルチ AZ。PITR で復元。readiness チェックでコールドスタート時のリクエスト競合を防止。オンデマンド課金がスパイクを吸収。 |
| **パフォーマンス効率** | ARM64 / Graviton。アダプターのオーバーヘッドはループバック呼び出し。コールドスタートが問題なら SnapStart / プロビジョンド同時実行。 |
| **コスト最適化** | アイドル時のコンピュートなし。`PAY_PER_REQUEST` DynamoDB。ログ/メトリクスは 1 関数分。 |
| **持続可能性** | Graviton。ゼロにスケール。過剰プロビジョニングなし。 |

## 💰 コスト最適化

### 月額コスト概算（ap-northeast-1 / 東京）

#### 軽い利用（月間約 100,000 リクエスト）
```
API Gateway REST API:  100,000 req x $4.25 / 1,000,000        = $0.43
Lambda リクエスト:      100,000 req x $0.20 / 1,000,000        = $0.02
Lambda コンピュート:    100,000 x 200 ms x 256 MB (arm64)      ≈ $0.02
DynamoDB オンデマンド:  約 300,000 RRU/WRU                      ≈ $0.10
CloudWatch Logs:        50 MB 未満                              ≈ $0.02
-------------------------------------------------------------------
合計:                                                          約 $0.59/月
```

#### 中程度の利用（月間約 5,000,000 リクエスト）
```
API Gateway REST API:  5,000,000 req x $4.25 / 1,000,000       = $21.25
Lambda リクエスト:      5,000,000 req x $0.20 / 1,000,000       = $1.00
Lambda コンピュート:    5,000,000 x 200 ms x 256 MB (arm64)     ≈ $0.80
DynamoDB オンデマンド:  約 1,500 万 RRU/WRU                     ≈ $5.00
CloudWatch Logs:        約 2 GB                                 ≈ $1.50
-------------------------------------------------------------------
合計:                                                          約 $30.5/月
```

*（料金は 2026 年時点・ap-northeast-1、無料枠は除く。[AWS 料金計算ツール](https://calculator.aws/)で確認してください。）*

### このパターン固有のコスト観点

1. **アダプター自体は無料** — 計測されるサービスではなくレイヤー。コストは他の単一関数 API と同じで、違いはコールドスタート時の課金時間がわずかに長いことだけ。
2. **コールドスタートの時間** — バンドルが大きく readiness ポーリングがある分、コールド呼び出しの課金時間が数十 ms 増える。低ボリュームでは誤差。高ボリュームではプロビジョンド同時実行で、平坦な時間課金と引き換えに予測可能なレイテンシを得る。
3. **ARM64 / Graviton** と **`PAY_PER_REQUEST` DynamoDB** — 兄弟パターンと同じレバー。

## 🔒 セキュリティに関する考慮事項

### 実装済み

- ✅ **最小権限 IAM** — カスタムステートメントは 1 つ、`TodosTable` への `grantReadWriteData` のみ。`cdk-nag` は `table/index/*` リソースと `AWSLambdaBasicExecutionRole` を指摘しますが、いずれも [`test/compliance/cdk-nag.test.ts`](test/compliance/cdk-nag.test.ts) で理由付きで抑制。
- ✅ **保管時の暗号化** — DynamoDB SSE + PITR。
- ✅ **転送時の TLS** — HTTPS のみの `execute-api` エンドポイント。
- ✅ ステージの**アクセスログ + 実行ログ**。
- ✅ **信頼できるレイヤー提供元** — レイヤーは AWS 所有アカウント `753240598075` が公開し、特定バージョンに固定。

### 意図的に対象外（環境ごとに追加）

コンプライアンステストで抑制しています。**本番 API にそのままコピーしないでください。**

- **認可**（`AwsSolutions-APIG4` / `COG4`）— `LambdaRestApi` の `defaultMethodOptions` でオーソライザーを追加するか、Express ミドルウェアでベアラートークンを検証する。
- **WAF**（`AwsSolutions-APIG3`）— `wafv2.CfnWebACLAssociation` をステージ ARN に関連付ける。
- **リクエスト検証**（`AwsSolutions-APIG2`）— `proxy: true` では API Gateway モデルがないため、Express（`zod`、`express-validator` など）で検証する。

### CDK Nag

```bash
npm run test:compliance -w workspaces/apigw-lambda-web-adapter
```

## 📋 前提条件

- API Gateway・Lambda・DynamoDB・IAM・CloudWatch Logs の権限を持つ AWS アカウント
- `${PROJECT}-${ENV}`（例: `apigw-lambda-web-adapter-dev`）という名前のプロファイルで構成した AWS CLI v2.x
- Node.js 20.x 以降、AWS CDK 2.x
- **Docker は不要** — `NodejsFunction` はローカルの `esbuild` でバンドルし、アダプターはデプロイ時にレイヤーとして取り込まれます

## 🚀 デプロイ手順

```bash
cd infrastructure
npm install

export PROJECT=apigw-lambda-web-adapter
export ENV=dev

npm run bootstrap  -w workspaces/apigw-lambda-web-adapter   # アカウント/リージョンごとに初回のみ
npm run synth      -w workspaces/apigw-lambda-web-adapter
npm run deploy:all -w workspaces/apigw-lambda-web-adapter
```

スタックは `ApiUrl` と `TodosTableName` を出力します。

> 関数を `x86_64` に切り替える場合は、レイヤー名も `LambdaAdapterLayerX86_64` に変更し、現在のバージョンを[リリースページ](https://github.com/awslabs/aws-lambda-web-adapter/releases)で確認してください。

## 使い方

```bash
API_URL="<ApiUrl の出力>"   # 例: https://abc123.execute-api.ap-northeast-1.amazonaws.com/dev/

curl -s "${API_URL}health"                                   # {"status":"ok"}
curl -s -X POST "${API_URL}todos" -H 'content-type: application/json' -d '{"title":"buy milk"}' | jq .
curl -s "${API_URL}todos" | jq .
curl -s "${API_URL}todos/<todoId>" | jq .
curl -s -X PUT "${API_URL}todos/<todoId>" -H 'content-type: application/json' -d '{"title":"buy oat milk","completed":true}' | jq .
curl -s -i -X DELETE "${API_URL}todos/<todoId>"
```

### 同じサーバーをローカルで実行

```bash
npm start -w workspaces/apigw-lambda-web-adapter   # express が http://localhost:8080 で起動
curl -s localhost:8080/todos | jq .
```

これは Lambda で動くのと**まったく同じ**コードパスで、違いは前段のアダプターだけです。

## 🧪 テスト戦略

```
test/
├── compliance/
│   └── cdk-nag.test.ts                        # AWS Solutions パック + 理由付き抑制
├── parameters/
│   └── test-params.ts                         # 決定的な Environment.TEST パラメータ
├── snapshot/
│   └── snapshot.test.ts                       # テンプレート全体 + リソース数のスナップショット
└── unit/
    └── apigw-lambda-web-adapter-stack.test.ts # テーブル、単一関数、アダプターレイヤー + 環境変数、プロキシメソッド、ステージログ、出力
```

```bash
npm test                -w workspaces/apigw-lambda-web-adapter   # すべて
npm run test:snapshot   -w workspaces/apigw-lambda-web-adapter
npm run test:unit       -w workspaces/apigw-lambda-web-adapter
npm run test:compliance -w workspaces/apigw-lambda-web-adapter
npm run test:snapshot   -w workspaces/apigw-lambda-web-adapter -- -u   # 意図した変更後にスナップショット更新
```

ユニットテストは、関数がアダプターレイヤー（`Layers` に `…:layer:LambdaAdapterLayerArm64:…` を含む）と 3 つの配線用環境変数を持つことを検証します。

## ⚙️ カスタマイズ

### ルートを追加

純粋な Express で、**インフラ変更なし**：

```typescript
// src/routes/todos.ts
router.patch('/:todoId/complete', async (req, res, next) => {
  try {
    await docClient.send(new UpdateCommand({ /* … completed = true に設定 … */ }));
    res.status(204).send();
  } catch (err) { next(err); }
});
```

### コールドスタートのレイテンシを下げる

```typescript
const webAdapterHandler = new lambdaNodejs.NodejsFunction(this, 'WebAdapterHandler', {
  // …
  snapStart: lambda.SnapStartConf.ON_PUBLISHED_VERSIONS, // Node 22 は SnapStart 対応
});
```
またはエイリアスに `provisionedConcurrentExecutions` を設定します。

### 同じイメージを Fargate で動かす

コードが素のサーバーなので、`lib/` を `ContainerImage.fromAsset('.')` と `ApplicationLoadBalancedFargateService` に置き換えれば、**アプリケーションを一切変更せず**（アダプターを外すだけで）動かせます。

## 🔧 トラブルシューティング

### デプロイ直後、すべてのリクエストが即座に 502 を返す

アダプターがサーバーに到達できていません。順に確認してください。
1. `PORT` 環境変数が `app.listen()` と一致しているか（どちらも `8080`）。
2. `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap` が設定されているか（スタックでは設定済み）。これがないとレイヤーは無効になり、プレースホルダーの `handler` が実行される。
3. レイヤー ARN のリージョン/アーキテクチャが関数と一致しているか（`Arm64` ↔ `ARM_64`）。
4. 関数のロググループ — Express 起動時の例外（不正な import など）はそこに出る。

### アイドル後の最初のリクエストが遅く、その後は速い

想定どおりです。そのリクエストがコールドスタート（バンドル読み込み + `app.listen` + `/health` ポーリング）を負担しました。そのテールレイテンシが問題なら SnapStart かプロビジョンド同時実行を使ってください。

### `cdk deploy` が「CloudWatch Logs role ARN must be set in account settings」で失敗する

RestApi の `cloudWatchRole: true` がこのロールをスタック単位で作成します。維持するか、アカウント/リージョンごとに一度アカウントレベルの API Gateway CloudWatch ロールを設定してください。

### 無関係な変更後にスナップショットテストが失敗する

`esbuild` のアセットハッシュだけが動いた場合は `npm run test:snapshot -- -u` を実行してコミットしてください（バンドルが変わっています）。リソース**数**の変化は調査してください。

## 🧹 クリーンアップ

```bash
npm run destroy:all -w workspaces/apigw-lambda-web-adapter
```

`dev` では `isAutoDeleteObject: true` によりテーブルに `RemovalPolicy.DESTROY` が設定されます。`prd` では保持されます。

## 📚 参考資料

### AWS ドキュメント
- [AWS Lambda Web Adapter (awslabs)](https://github.com/awslabs/aws-lambda-web-adapter)
- [Lambda 上で Web アプリケーションを実行する](https://aws.amazon.com/jp/blogs/compute/re-platforming-java-applications-using-the-updated-aws-lambda-web-adapter/)
- [REST API の Lambda プロキシ統合](https://docs.aws.amazon.com/ja_jp/apigateway/latest/developerguide/api-gateway-set-up-simple-proxy.html)
- [Lambda SnapStart で起動パフォーマンスを改善する](https://docs.aws.amazon.com/ja_jp/lambda/latest/dg/snapstart.html)

### AWS CDK
- [aws-apigateway モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_apigateway-readme.html)
- [aws-lambda-nodejs モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html)

### 関連アーキテクチャ
- [apigw-lambdalith](../apigw-lambdalith/) — 同じ API をプロセス内ルーティングだが Lambda ネイティブなアダプター（Hono）で実装。コールドスタートが小さい
- [apigw-single-purpose-lambda](../apigw-single-purpose-lambda/) — 同じ API をルートごとに 1 関数で実装
- [apigw-s3-stub](../apigw-s3-stub/) — Lambda を一切使わない API Gateway REST API

## 📄 ライセンス

本プロジェクトは MIT ライセンスです。詳細は [LICENSE](../../LICENSE) を参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します。詳細は [CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。

## 🏆 このリファレンスアーキテクチャについて

**対象レベル**: 300 (中級)

---

**注意**: これはリファレンス実装です。本番導入前に、認可・WAF・リクエスト検証・コールドスタート戦略・環境固有パラメータなどをレビューし、要件に合わせてカスタマイズしてください。
