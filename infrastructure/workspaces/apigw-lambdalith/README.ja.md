# API Gateway + Lambdalith (Hono) - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **レベル: 300 (中級)**

Todos REST API を **1 つの** Lambda 関数だけで提供します。API Gateway は薄い `{proxy+}` パススルーに徹し、ルーティング（`GET`/`POST /todos`、`GET`/`PUT`/`DELETE /todos/{todoId}`）はすべて関数の**内部**で [Hono](https://hono.dev/) と `hono/aws-lambda` アダプターが行います。API 全体が単一のデプロイ単位です。

これは、**同じ API** を 3 通りに実装して API Gateway + Lambda の統合スタイルを直接比較するための 3 つのワークスペースのうちの 1 つです。

| ワークスペース | 関数の数 | ルーティング | 一言で言うと |
|-----------|-----------|---------|------------------|
| [`apigw-single-purpose-lambda`](../apigw-single-purpose-lambda/) | ルートごとに 1 つ | API Gateway | 最大の分離：ルートごとに専用の関数・ロール・権限。 |
| **`apigw-lambdalith`**（本書） | 1 つ | Hono（プロセス内） | 1 関数・1 デプロイ単位・フレームワークによるルーティング。 |
| [`apigw-lambda-web-adapter`](../apigw-lambda-web-adapter/) | 1 つ | Express（プロセス内） | Lambda Web Adapter レイヤーの背後で動く標準的な Express サーバー。 |

## 📑 目次

- [アーキテクチャ概要](#-アーキテクチャ概要)
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

- **Amazon API Gateway (REST API)** — `LambdaRestApi`（`proxy: true`）が作る単一の貪欲プロキシリソース `ANY /{proxy+}`（および `ANY /`）。API Gateway はルーティング・リクエスト検証・メソッド単位の設定を**一切行わず**、すべてのリクエストを `AWS_PROXY` イベントとしてそのまま関数へ転送します。
- **AWS Lambda (`LambdalithHandler`)** — Node.js 22 / ARM64 の関数 1 つ。エントリポイント（`src/lambda.ts`）は実質 3 行で、`export const handler = handle(app)`（`app` は Hono インスタンス）。`hono/aws-lambda` が API Gateway プロキシイベントを `Request` に変換し、Hono のルーターを実行し、`Response` を戻します。
- **Hono ルーター (`src/routes/todos.ts`)** — 実際の API 面。`app.route('/todos', todosRouter)` で 5 つのハンドラーをマウントします。ふつうのフレームワークコードであり、同じ `app` オブジェクトは `@hono/node-server` 経由でローカルの Node でも動きます（`npm start`）。
- **Amazon DynamoDB (`TodosTable`)** — オンデマンド（`PAY_PER_REQUEST`）、パーティションキー `todoId`、AWS マネージドキーによる SSE、ポイントインタイムリカバリ（PITR）有効。単一の関数ロールへ `grantReadWriteData` を 1 回。
- **可観測性** — 関数専用の CloudWatch ロググループ（明示的な `logGroup`、保持 1 週間）に加え、API Gateway の**アクセスログ**（JSON・標準フィールド）とステージの `INFO` メソッドログ。

### アーキテクチャ特性

| 特性 | 値 | 根拠 |
|---------------|-------|-----------|
| デプロイ単位 | 1 関数 = 1 API | どのルートを変更しても API 全体が再デプロイされる。理解しやすい反面、影響範囲は粗い。 |
| コールドスタート | 面は 1 つ・中サイズのバンドル | Hono は非常に小さい（gzip 約 14 kB）ためバンドルは素のハンドラーに近く、ウォームに保つ関数も 1 つだけ。 |
| IAM スコープ | 1 ロール・全ルートの権限の和集合 | `list` と `delete` が同じロールを共有する。ルートごとに 1 ロールより粗い。 |
| ローカル開発 | `npm start` が本物のルーターを Node で実行 | `@hono/node-server` が同一の `app` を提供。ルートロジックに SAM/エミュレーターは不要。 |
| 移植性 | Lambda 固有のアダプター | Lambda 以外へ移すには `hono/aws-lambda` を別の Hono アダプター（Node・Bun・Workers…）に差し替える。 |

## 🎯 設計判断とベストプラクティス

### 1. プロセス内ルーティングの単一関数（Lambdalith）

**判断**: すべてのルートを 1 つの Lambda で提供し、プロセス内でフレームワークにルーティングさせる（API Gateway メソッドごとに関数を割り当てない）。

**根拠**:
- ✅ ビルド 1 回・成果物 1 つ・デプロイ 1 回・アラーム/ダッシュボード 1 式
- ✅ 共有コード（検証・シリアライズ・ミドルウェア）はただの関数呼び出し。Lambda レイヤーや共有パッケージの配線が不要
- ✅ フレームワークの使い勝手：ミドルウェア、型付きパラメータ、サブルーター、テスト可能な `app` オブジェクト
- ✅ ウォームに保つコールドスタート面が少ない。3 ルートに当たるバーストでも 1 関数が温まる

**トレードオフ**:
- ❌ IAM が粗い — 単一ロールが全ルート権限の和集合になる（本 API は DynamoDB しか使わないため影響は小さいが、S3・SES・SQS も触る API ならそれらすべてを全ルートに付与することになる）
- ❌ デプロイの影響範囲が粗い — 不正なデプロイは 1 エンドポイントではなく API 全体を落とす
- ❌ ルートごとに異なりうるワークロードに対して、関数レベルのつまみ（メモリ・タイムアウト・予約済み同時実行）が 1 式しかない
- ❌ Lambda 固有の接着剤（`hono/aws-lambda`）。[設計判断 3](#3-なぜ-hono-か) を参照

### 2. `proxy: true` の `LambdaRestApi`

**判断**: リソース/メソッドを手で組まず、`apigateway.LambdaRestApi({ handler, proxy: true })` を使う。

```typescript
const api = new apigateway.LambdaRestApi(this, 'TodosApi', {
  handler: lambdalithHandler,
  proxy: true,
  cloudWatchRole: true,
  deployOptions: {
    stageName: environment,
    loggingLevel: apigateway.MethodLoggingLevel.INFO,
    metricsEnabled: true,
    accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
    accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
  },
});
```

**根拠**:
- ✅ ルートがいくつ増えても CloudFormation テンプレートは小さいまま安定する。`PATCH /todos/{id}/complete` の追加はコード変更のみで、**インフラの差分はゼロ**
- ✅ ルーターと同期を取るべき `addResource`/`addMethod` の定型コードがない

**トレードオフ**:
- ❌ メソッド単位の API Gateway 機能（リクエストバリデーター、メソッド単位スロットリング、ルート単位オーソライザー、ルートに紐づく使用量プラン）が使えない。必要になれば明示的メソッドに戻すか、アプリ側で担保する
- ❌ API Gateway のメトリクス/ログはステージ全体単位で、論理ルート単位ではない（ルートはアクセスログの `path` フィールドにしか現れない）

### 3. なぜ Hono か

**判断**: [Hono](https://hono.dev/) を `hono/aws-lambda` 経由で使う。

**根拠**:
- ✅ 依存が非常に小さく、リフレクション/デコレータ不使用、ルーターが高速 — 単一バンドルを素のハンドラーに近いサイズに保ち、Lambdalith のコールドスタートを single-purpose 版に近づける
- ✅ AWS Lambda・Node・Bun・Deno・Cloudflare Workers への一級アダプターがある — *エントリファイル*は移植不可でも `app` は移植可能
- ✅ Web 標準の `Request`/`Response` — 同じハンドラーを `app.request('/todos')` で AWS 型なしにユニットテストできる

**代替案**: `@codegenie/serverless-express` / `aws-serverless-express`（Express をラップ。これはレイヤーを除けば [`apigw-lambda-web-adapter`](../apigw-lambda-web-adapter/) のアプローチ）、AWS Lambda Powertools のイベントハンドラー、`itty-router`、または極小 API 向けに `event.resource`/`event.httpMethod` を `switch` する手書き実装。

### 4. 環境固有パラメータ

リージョン/アカウントは `cdk.json` context や CloudFormation パラメータではなく `EnvParams`（`parameters/<env>-params.ts`）から取得します。

```typescript
// parameters/dev-params.ts
const devParams: EnvParams = {
  region: 'ap-northeast-1',
};
params[Environment.DEVELOPMENT] = devParams;
```

`isAutoDeleteObject`（`dev` のみ true）が DynamoDB の `RemovalPolicy` を制御し、`terminationProtection` は `prd` で有効です。

## 🔀 パターン比較

| 観点 | Single-Purpose Lambda | **Lambdalith（本書）** | Lambda Web Adapter |
|--------|----------------------|-----------------------|--------------------|
| Lambda 関数の数 | ルートごとに 1（5 個） | **1 個** | 1 個 |
| ルーティング担当 | API Gateway（`addMethod`） | **Hono（プロセス内）** | Express（プロセス内） |
| API Gateway の形 | 明示的なリソース + メソッド | **`ANY /{proxy+}`** | `ANY /{proxy+}` |
| IAM の粒度 | ルート単位（読み取り専用 / 書き込み専用） | **1 ロール = 和集合** | 1 ロール = 和集合 |
| CloudFormation の規模 | ルート追加ごとに増える | **一定** | 一定 |
| コールドスタート面 | N（小さいバンドル） | **1（小さいバンドル）** | 1（バンドル + アダプターレイヤー） |
| ルート単位のメモリ/タイムアウト | 可 | **不可** | 不可 |
| デプロイの影響範囲 | 1 関数 | **API 全体** | API 全体 |
| ルートロジックのローカル開発 | ハンドラー実行 / SAM | **`npm start`（node-server）** | `npm start`（本物の Express） |
| Lambda 外で動くか | 不可 | **アダプター差し替え** | 可（変更なしで Fargate/ローカル） |
| 向いている場面 | ルートごとに異なるスケール / セキュリティ / 所有 | **小〜中規模 API、単一チーム、素早い反復** | 既存の Node Web アプリの移行、複数ターゲットへのデプロイ |

## 🏛️ Well-Architected との対応

| 柱 | 実装 |
|--------|---------------|
| **運用上の優秀性** | 成果物 1 つ・デプロイ 1 回で把握できる。ステージにアクセスログ + `INFO` メソッドログ。保持期間付きの関数専用ロググループ。 |
| **セキュリティ** | 1 つの DynamoDB テーブルに限定した最小権限ロール 1 つ。テーブルは SSE + PITR。API Gateway エンドポイントは TLS のみ。認証認可と WAF はドキュメント化された追加項目（[セキュリティに関する考慮事項](#-セキュリティに関する考慮事項)参照）。 |
| **信頼性** | フルマネージドの API Gateway + Lambda + DynamoDB、既定でマルチ AZ。PITR でポイントインタイム復元。オンデマンド課金がスパイクを容量計画なしで吸収。 |
| **パフォーマンス効率** | ARM64（Graviton）ランタイム。Hono の小ささが単一関数のコールドスタートを低く保つ。1 つのウォームな関数が全ルートを処理。 |
| **コスト最適化** | アイドル時のコンピュートなし。`PAY_PER_REQUEST` DynamoDB。ログ/メトリクスは 5 つ分ではなく 1 つ分。 |
| **持続可能性** | Graviton。過剰プロビジョニングなし。ゼロにスケールする単一関数。 |

## 💰 コスト最適化

### 月額コスト概算（ap-northeast-1 / 東京）

#### 軽い利用（個人/開発、月間約 100,000 リクエスト）
```
API Gateway REST API:  100,000 req x $4.25 / 1,000,000        = $0.43
Lambda リクエスト:      100,000 req x $0.20 / 1,000,000        = $0.02
Lambda コンピュート:    100,000 x 150 ms x 256 MB (arm64)      ≈ $0.01
DynamoDB オンデマンド:  約 300,000 RRU/WRU                      ≈ $0.10
CloudWatch Logs:        50 MB 未満                              ≈ $0.02
-------------------------------------------------------------------
合計:                                                          約 $0.58/月
```

#### 中程度の利用（月間約 5,000,000 リクエスト）
```
API Gateway REST API:  5,000,000 req x $4.25 / 1,000,000       = $21.25
Lambda リクエスト:      5,000,000 req x $0.20 / 1,000,000       = $1.00
Lambda コンピュート:    5,000,000 x 150 ms x 256 MB (arm64)     ≈ $0.60
DynamoDB オンデマンド:  約 1,500 万 RRU/WRU                     ≈ $5.00
CloudWatch Logs:        約 2 GB                                 ≈ $1.50
-------------------------------------------------------------------
合計:                                                          約 $30/月
```

*（料金は 2026 年時点・ap-northeast-1、無料枠は除く。[AWS 料金計算ツール](https://calculator.aws/)で最新料金を確認してください。）*

### このパターン固有のコスト観点

1. **固定オーバーヘッドは 1 関数分** — ロググループ 1 つ、CloudWatch メトリクス 1 式、（任意の）プロビジョンド同時実行の課金も 1 つ分。低トラフィックの API では 3 パターン中もっとも**運用コストが安い**。
2. **ARM64 / Graviton** — 同じコードで x86 より GB 秒あたり約 20% 安い。
3. **`PAY_PER_REQUEST` DynamoDB** — アイドル時は無料。トラフィックが安定・予測可能になってからプロビジョンド + オートスケーリングへ。

## 🔒 セキュリティに関する考慮事項

### 実装済み

- ✅ **最小権限 IAM** — 関数ロールのカスタムステートメントはちょうど 1 つ、`TodosTable` への `grantReadWriteData` のみ。（`grant*Data` が必ず追加する `table/index/*` リソースと `AWSLambdaBasicExecutionRole` マネージドポリシーを `cdk-nag` が指摘しますが、いずれも [`test/compliance/cdk-nag.test.ts`](test/compliance/cdk-nag.test.ts) で理由付きで抑制しています。）
- ✅ **保管時の暗号化** — DynamoDB SSE（AWS マネージドキー）+ PITR。
- ✅ **転送時の TLS** — API Gateway `execute-api` エンドポイントは HTTPS のみ。
- ✅ **アクセスログ** — 標準フィールドの JSON アクセスログ + ステージの `INFO` 実行ログ。

### 意図的に対象外（環境ごとに追加）

本リファレンスは*統合スタイル*の分離に集中しているため、以下は組み込んでおらず、コンプライアンステストで抑制しています。これらの抑制を本番 API にそのままコピーしないでください。

- **認可**（`AwsSolutions-APIG4` / `COG4`）— プロキシメソッドにオーソライザーを追加：
  ```typescript
  const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'Auth', { cognitoUserPools: [pool] });
  const api = new apigateway.LambdaRestApi(this, 'TodosApi', {
    handler, proxy: true,
    defaultMethodOptions: { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO },
  });
  ```
  あるいは Hono ミドルウェア（`hono/jwt`）で JWT を検証する。
- **WAF**（`AwsSolutions-APIG3`）— `wafv2.CfnWebACLAssociation` をステージ ARN に関連付ける。
- **リクエスト検証**（`AwsSolutions-APIG2`）— `proxy: true` では API Gateway モデルがないため、Hono ミドルウェア（例: `@hono/zod-validator`）で検証する。

### CDK Nag

```bash
npm run test:compliance -w workspaces/apigw-lambdalith
```

## 📋 前提条件

- API Gateway・Lambda・DynamoDB・IAM・CloudWatch Logs の権限を持つ AWS アカウント
- `${PROJECT}-${ENV}`（例: `apigw-lambdalith-dev`）という名前のプロファイルで構成した AWS CLI v2.x
- Node.js 20.x 以降、AWS CDK 2.x
- **Docker は不要** — `NodejsFunction` はローカルの `esbuild` でバンドルします

## 🚀 デプロイ手順

```bash
cd infrastructure
npm install
```

`PROJECT`/`ENV` は CDK context（`-c project=… -c env=…`）と、想定される AWS CLI プロファイル名（`${PROJECT}-${ENV}`）の両方に使われます。

```bash
export PROJECT=apigw-lambdalith
export ENV=dev

npm run bootstrap  -w workspaces/apigw-lambdalith   # アカウント/リージョンごとに初回のみ
npm run synth      -w workspaces/apigw-lambdalith
npm run deploy:all -w workspaces/apigw-lambdalith
```

スタックは `ApiUrl` と `TodosTableName` を出力します。

## 使い方

```bash
API_URL="<ApiUrl の出力>"   # 例: https://abc123.execute-api.ap-northeast-1.amazonaws.com/dev/

# 作成
curl -s -X POST "${API_URL}todos" -H 'content-type: application/json' \
  -d '{"title":"buy milk"}' | jq .

# 一覧
curl -s "${API_URL}todos" | jq .

# 単体取得
curl -s "${API_URL}todos/<todoId>" | jq .

# 更新
curl -s -X PUT "${API_URL}todos/<todoId>" -H 'content-type: application/json' \
  -d '{"title":"buy oat milk","completed":true}' | jq .

# 削除
curl -s -i -X DELETE "${API_URL}todos/<todoId>"
```

### 同じルーターをローカルで実行

```bash
npm start -w workspaces/apigw-lambdalith   # @hono/node-server が http://localhost:3000 で起動
curl -s localhost:3000/todos | jq .
```

## 🧪 テスト戦略

```
test/
├── compliance/
│   └── cdk-nag.test.ts                 # AWS Solutions パック + 理由付き抑制
├── parameters/
│   └── test-params.ts                  # 決定的な Environment.TEST パラメータ
├── snapshot/
│   └── snapshot.test.ts                # テンプレート全体 + リソース数のスナップショット
└── unit/
    └── apigw-lambdalith-stack.test.ts  # テーブル、単一関数、プロキシメソッド、IAM、ステージログ、出力
```

```bash
npm test              -w workspaces/apigw-lambdalith   # すべて
npm run test:snapshot -w workspaces/apigw-lambdalith
npm run test:unit     -w workspaces/apigw-lambdalith
npm run test:compliance -w workspaces/apigw-lambdalith
npm run test:snapshot -w workspaces/apigw-lambdalith -- -u   # 意図した変更後にスナップショット更新
```

スナップショットには `esbuild` バンドルのハッシュが含まれるため、`src/**` を変更すると変化します（成果物が変わったことの証明であり、意図的な挙動です）。

## ⚙️ カスタマイズ

### ルートを追加

純粋なアプリケーションコードで、**インフラ変更なし**：

```typescript
// src/routes/todos.ts
todos.patch('/:todoId/complete', async (c) => {
  const todoId = c.req.param('todoId');
  await docClient.send(new UpdateCommand({ /* … completed = true に設定 … */ }));
  return c.body(null, 204);
});
```

### 関数のメモリ / タイムアウトを増やす

```typescript
const lambdalithHandler = new lambdaNodejs.NodejsFunction(this, 'LambdalithHandler', {
  memorySize: 512,
  timeout: cdk.Duration.seconds(15),
  // …
});
```

### 2 つ目の環境を追加

`parameters/prd-params.ts` を作成し `Environment.PRODUCTION` に登録してから `ENV=prd` でデプロイします。

## 🔧 トラブルシューティング

### 正しそうなパスで `{"message":"Missing Authentication Token"}` が返る

これは、どのリソースにも**一致しない**パスに対する API Gateway の応答です。`proxy: true` ではリソースは `/` と `/{proxy+}` だけなので、ほぼ確実に URL の末尾スラッシュ／ステージプレフィックスの間違いです。API のベースは既に `/dev/` で終わるため、`${API_URL}/todos` ではなく `${API_URL}todos` を呼び出してください。

### 502 Bad Gateway

関数が例外を投げたか、API Gateway が解釈できない形を返しています。関数のロググループを確認してください。よくある原因は Hono アダプターのバージョン不整合、または `c.json(...)` ではなく生のオブジェクトを返していることです。

### `cdk deploy` が「CloudWatch Logs role ARN must be set in account settings」で失敗する

RestApi の `cloudWatchRole: true` がこのロールをスタック単位で作成するため、本構成では設定しています。外した場合は戻すか、アカウント/リージョンごとに一度アカウントレベルの API Gateway CloudWatch ロールを設定してください。

### 無関係な変更後にスナップショットテストが失敗する

アセットハッシュだけが動いた場合は `npm run test:snapshot -- -u` を実行してコミットしてください（バンドルが実際に変わっています）。リソース**数**が想定外に変わった場合は差分を確認してください。

## 🧹 クリーンアップ

```bash
npm run destroy:all -w workspaces/apigw-lambdalith
```

`dev` では `isAutoDeleteObject: true` により DynamoDB テーブルに `RemovalPolicy.DESTROY` が設定され、スタックと共に削除されます。`prd` ではテーブルは保持されます。

## 📚 参考資料

### AWS ドキュメント
- [プロキシリソースでのプロキシ統合のセットアップ](https://docs.aws.amazon.com/ja_jp/apigateway/latest/developerguide/api-gateway-set-up-simple-proxy.html)
- [Node.js の AWS Lambda 関数ハンドラー](https://docs.aws.amazon.com/ja_jp/lambda/latest/dg/nodejs-handler.html)
- [DynamoDB オンデマンドキャパシティーモード](https://docs.aws.amazon.com/ja_jp/amazondynamodb/latest/developerguide/HowItWorks.ReadWriteCapacityMode.html#HowItWorks.OnDemand)

### フレームワーク
- [Hono](https://hono.dev/) · [Hono AWS Lambda アダプター](https://hono.dev/docs/getting-started/aws-lambda)

### AWS CDK
- [aws-apigateway モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_apigateway-readme.html)
- [aws-lambda-nodejs モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html)

### 関連アーキテクチャ
- [apigw-single-purpose-lambda](../apigw-single-purpose-lambda/) — 同じ API をルートごとに 1 関数で実装
- [apigw-lambda-web-adapter](../apigw-lambda-web-adapter/) — 同じ API を Lambda Web Adapter の背後の Express サーバーとして実装
- [apigw-s3-stub](../apigw-s3-stub/) — Lambda を一切使わない API Gateway REST API（S3 サービス統合を直接利用）

## 📄 ライセンス

本プロジェクトは MIT ライセンスです。詳細は [LICENSE](../../LICENSE) を参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します。詳細は [CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。

## 🏆 このリファレンスアーキテクチャについて

**対象レベル**: 300 (中級)

---

**注意**: これはリファレンス実装です。本番導入前に、認可・WAF・リクエスト検証・環境固有パラメータなどをレビューし、要件に合わせてカスタマイズしてください。
