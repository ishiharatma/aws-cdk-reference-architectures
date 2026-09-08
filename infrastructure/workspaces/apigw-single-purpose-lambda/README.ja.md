# API Gateway + Single-Purpose Lambda - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **レベル: 300 (中級)**

**すべての API Gateway メソッドを、それぞれ専用の Lambda 関数**が処理する Todos REST API です。ルーティングは API Gateway が行い（`addResource`/`addMethod`）、各関数は `list`・`create`・`get`・`update`・`delete` のうちちょうど 1 つだけを、専用の IAM ロール・専用のロググループ・専用のバンドル・そして**最小権限**の DynamoDB 権限（`GET` は読み取り専用、`POST`/`DELETE` は書き込み専用）で実行します。

これは、**同じ API** を 3 通りに実装して API Gateway + Lambda の統合スタイルを直接比較するための 3 つのワークスペースのうちの 1 つです。

| ワークスペース | 関数の数 | ルーティング | 一言で言うと |
|-----------|-----------|---------|------------------|
| **`apigw-single-purpose-lambda`**（本書） | ルートごとに 1 つ | API Gateway | 最大の分離：ルートごとに専用の関数・ロール・権限。 |
| [`apigw-lambdalith`](../apigw-lambdalith/) | 1 つ | Hono（プロセス内） | 1 関数・1 デプロイ単位・フレームワークによるルーティング。 |
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

- **Amazon API Gateway (REST API)** — `RestApi` + `addResource`/`addMethod` で組んだ明示的なリソースとメソッド：
  - `/todos` → `GET`（一覧）、`POST`（作成）
  - `/todos/{todoId}` → `GET`（取得）、`PUT`（更新）、`DELETE`（削除）
  - 各メソッドは**別々の**関数への `LambdaIntegration`（`AWS_PROXY`）。
- **5 つの AWS Lambda 関数** — `list-todos`・`create-todo`・`get-todo`・`update-todo`・`delete-todo`。すべて Node.js 22 / ARM64、それぞれ自分の `src/handlers/<name>.ts` からビルドされ、それぞれ**専用の CloudWatch ロググループ**（保持 1 週間）を持ちます。スタック内の小さな `makeHandler` ファクトリが生成します。
- **Amazon DynamoDB (`TodosTable`)** — オンデマンド（`PAY_PER_REQUEST`）、パーティションキー `todoId`、SSE（AWS マネージドキー）、PITR 有効。
- **関数ごとの最小権限**：
  | 関数 | 権限付与 | 実効的な DynamoDB アクション |
  |----------|-------|----------------------------|
  | `list-todos` | `grantReadData` | `Scan`・`Query`・`GetItem` など（書き込み不可） |
  | `get-todo` | `grantReadData` | 読み取り専用 |
  | `create-todo` | `grantWriteData` | `PutItem`・`UpdateItem`・`DeleteItem`・`BatchWrite…`（読み取り不可） |
  | `delete-todo` | `grantWriteData` | 書き込み専用 |
  | `update-todo` | `grantReadWriteData` | 読み取り + 書き込み（条件付き更新を行うため） |
- **可観測性** — 5 つの関数ロググループ + 1 つの API Gateway アクセスログ用グループ。ステージにアクセスログ（JSON・標準フィールド）と `INFO` メソッドログ。

### アーキテクチャ特性

| 特性 | 値 | 根拠 |
|---------------|-------|-----------|
| デプロイ単位 | ルートごとに 1 関数 | `update-todo` を変更してもその関数だけが再デプロイされ、他の 4 つはそのまま。 |
| コールドスタート | 小さい面が 5 つ | 各バンドルは約 2 kB（1 コマンド + 共有の DynamoDB クライアント）。あるルートは他と独立にしか「コールド」にならない。 |
| IAM スコープ | 関数ごとに 1 ロール・最小権限 | `list-todos` は文字どおり `PutItem` を呼べず、`create-todo` は文字どおり `Scan` できない。 |
| ルート単位のチューニング | メモリ / タイムアウト / 予約済み同時実行を独立に設定 | 遅い `list` に 512 MB を割り当てても `delete` のコストは増えない。 |
| CloudFormation の規模 | ルートごとに約 6 リソース増える | Method + Integration + Function + Role + Policy + LogGroup。 |

## 🎯 設計判断とベストプラクティス

### 1. ルートごとに 1 関数

**判断**: 単一関数の内部でルーティングする（[`apigw-lambdalith`](../apigw-lambdalith/) と対照的）のではなく、各メソッドを専用の Lambda に割り当てる。

**根拠**:
- ✅ **最小権限が自然** — `list` ロールは書き込み権限を持たず、`create` ロールは読み取り権限を持たない。あとで絞り込むのを「忘れる」余地がない。
- ✅ **すべてが独立** — メモリ・タイムアウト・予約済み/プロビジョンド同時実行・環境変数・ランタイム、そして*デプロイ*までルート単位。ホットな `GET /todos` を `DELETE` に触れずにチューニング・スケールできる。
- ✅ **影響範囲が小さい** — 不正なデプロイや poison ペイロードは 1 エンドポイントに影響し、他は稼働し続ける。
- ✅ **極小のコールドスタート** — 各成果物は DynamoDB コマンドをちょうど 1 つだけバンドルするため、コールドな `get-todo` はほとんど何も初期化しない。
- ✅ **所有が明確** — 大きな組織では `team-a/create-todo` と `team-b/list-todos` を別々に所有・アラーム・リリースできる。

**トレードオフ**:
- ❌ **インフラが増える** — ルートごとに約 6 つの CloudFormation リソース。本テンプレートは約 35 リソース（Lambdalith は約 15）。
- ❌ **共有コードに本気のパッケージングが必要** — ここでは DynamoDB クライアントヘルパーがバンドルごとに重複している。これより大きなものは Lambda レイヤーか社内 npm パッケージにしたい。
- ❌ **ダッシュボード/アラームが増える** — 5 関数分のメトリクス。複合アラームが欲しくなる。
- ❌ **ルーティングが CDK にある** — `PATCH /todos/{id}/complete` の追加はアプリコードだけでなくインフラ変更（`addMethod` + 新関数）。

### 2. 関数ごとの最小権限

```typescript
const listTodosHandler = makeHandler('ListTodos', 'list-todos', 'list-todos');
todosTable.grantReadData(listTodosHandler);      // 読み取り専用

const createTodoHandler = makeHandler('CreateTodo', 'create-todo', 'create-todo');
todosTable.grantWriteData(createTodoHandler);    // 書き込み専用

const updateTodoHandler = makeHandler('UpdateTodo', 'update-todo', 'update-todo');
todosTable.grantReadWriteData(updateTodoHandler); // 両方必要
```

**根拠**:
- ✅ 侵害された `list-todos` はデータを改変・削除できず、侵害された `create-todo` は `Scan` でテーブルを窃取できない。
- ✅ 意図がスタックに見え、少なくとも 1 つのロールが `PutItem` なしの `Scan` を、少なくとも 1 つのロールが `GetItem`/`Scan` なしの `PutItem` を持つことをユニットテストで検証している。

`grant*Data` が必ず追加する `table/index/*` リソースと `AWSLambdaBasicExecutionRole` マネージドポリシーは `cdk-nag` が指摘しますが、いずれも [`test/compliance/cdk-nag.test.ts`](test/compliance/cdk-nag.test.ts) で理由付きで抑制しています。

### 3. 各関数が専用ロググループを持つための `makeHandler` ファクトリ

```typescript
const makeHandler = (idPrefix: string, entryFile: string, name: string) =>
  new lambdaNodejs.NodejsFunction(this, `${idPrefix}Handler`, {
    ...commonProps,
    entry: `src/handlers/${entryFile}.ts`,
    handler: 'handler',
    functionName: `${project}-${environment}-${name}`,
    logGroup: new logs.LogGroup(this, `${idPrefix}LogGroup`, {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    }),
  });
```

**根拠**:
- ✅ 5 つの宣言を各 2 行に保ちつつ、すべての関数に保持ポリシー付きの**明示的な**ロググループを与える（非推奨の `logRetention` プロパティは代わりに関数ごとにカスタムリソースの Lambda を作る）。
- ✅ `removalPolicy` が `isAutoDeleteObject` に従うため、`dev` のロググループはスタックと共に削除される。

### 4. `LambdaRestApi` プロキシではなく明示的な `RestApi` + メソッド

**判断**: 各メソッドが別々の統合にマッピングされるよう、リソース/メソッドを手で組む。

**根拠**:
- ✅ 後で必要になったときにメソッド単位の API Gateway 機能が使える：リクエストバリデーター、メソッド単位スロットリング、ルート単位オーソライザー、ルート単位の使用量プラン。
- ✅ API 契約が CDK コードにメソッド単位で見える。

**トレードオフ**: ルート追加はインフラに触れる（判断 1 参照）。

### 5. 環境固有パラメータ

リージョン/アカウントは `EnvParams`（`parameters/<env>-params.ts`）から取得。`isAutoDeleteObject`（`dev` のみ）が DynamoDB とロググループの `RemovalPolicy` を制御し、`terminationProtection` は `prd` で有効。

## 🔀 パターン比較

| 観点 | **Single-Purpose Lambda（本書）** | Lambdalith (Hono) | Lambda Web Adapter |
|--------|----------------------------------|-------------------|--------------------|
| Lambda 関数の数 | **ルートごとに 1（5 個）** | 1 個 | 1 個 |
| ルーティング担当 | **API Gateway（`addMethod`）** | Hono（プロセス内） | Express（プロセス内） |
| API Gateway の形 | **明示的なリソース + メソッド** | `ANY /{proxy+}` | `ANY /{proxy+}` |
| IAM の粒度 | **ルート単位（読み取り専用 / 書き込み専用）** | 1 ロール = 和集合 | 1 ロール = 和集合 |
| ルート単位のメモリ / タイムアウト / 同時実行 | **可** | 不可 | 不可 |
| デプロイの影響範囲 | **1 関数** | API 全体 | API 全体 |
| CloudFormation の規模 | **ルート追加ごとに増える（約 35 リソース）** | 一定（約 15） | 一定（約 16） |
| コールドスタート面 | **5（極小バンドル）** | 1（小） | 1（サーバー + レイヤー） |
| 共有コード | **バンドルごとに重複 / レイヤー** | ただの関数呼び出し | ただの関数呼び出し |
| Lambda 外で動くか | **不可** | アダプター差し替え | 可（無変更） |
| 向いている場面 | **ルートごとに異なるスケール / セキュリティ / 所有、大規模チーム** | 小〜中規模 API、単一チーム、素早い反復 | 既存の Node Web アプリの移行、複数ターゲットへのデプロイ |

## 🏛️ Well-Architected との対応

| 柱 | 実装 |
|--------|---------------|
| **運用上の優秀性** | ルート単位で独立にデプロイ。保持期間付きの関数ごとのロググループ。ステージにアクセス + `INFO` メソッドログ。 |
| **セキュリティ** | 関数ごとに 1 つの IAM ロール、可能な限り読み取り専用 *または* 書き込み専用。テーブルは SSE + PITR。TLS のみのエンドポイント。認証認可と WAF はドキュメント化された追加項目。 |
| **信頼性** | マネージドの API Gateway + Lambda + DynamoDB、マルチ AZ。1 関数の障害が他ルートを止めない。PITR で復元。オンデマンド課金がスパイクを吸収。 |
| **パフォーマンス効率** | ARM64 / Graviton。単一目的バンドルがコールドスタートを最小化。ルート単位のメモリサイジング。 |
| **コスト最適化** | アイドル時のコンピュートなし。`PAY_PER_REQUEST` DynamoDB。実際に呼ばれたルートの分だけ課金。 |
| **持続可能性** | Graviton。ルート単位でゼロにスケール。過剰プロビジョニングなし。 |

## 💰 コスト最適化

### 月額コスト概算（ap-northeast-1 / 東京）

#### 軽い利用（月間約 100,000 リクエスト、ルートに分散）
```
API Gateway REST API:  100,000 req x $4.25 / 1,000,000        = $0.43
Lambda リクエスト:      100,000 req x $0.20 / 1,000,000        = $0.02
Lambda コンピュート:    100,000 x 120 ms x 256 MB (arm64)      ≈ $0.01
DynamoDB オンデマンド:  約 300,000 RRU/WRU                      ≈ $0.10
CloudWatch Logs:        6 ロググループ、合計 60 MB 未満         ≈ $0.03
-------------------------------------------------------------------
合計:                                                          約 $0.59/月
```

#### 中程度の利用（月間約 5,000,000 リクエスト）
```
API Gateway REST API:  5,000,000 req x $4.25 / 1,000,000       = $21.25
Lambda リクエスト:      5,000,000 req x $0.20 / 1,000,000       = $1.00
Lambda コンピュート:    5,000,000 x 120 ms x 256 MB (arm64)     ≈ $0.50
DynamoDB オンデマンド:  約 1,500 万 RRU/WRU                     ≈ $5.00
CloudWatch Logs:        6 グループ合計で約 2 GB                 ≈ $1.50
-------------------------------------------------------------------
合計:                                                          約 $30/月
```

*（料金は 2026 年時点・ap-northeast-1、無料枠は除く。[AWS 料金計算ツール](https://calculator.aws/)で確認してください。）*

### このパターン固有のコスト観点

1. **リクエストコストは他の 2 パターンと同一** — API Gateway と Lambda は関数の数に関係なくリクエスト単位で課金される。
2. **固定オーバーヘッドがやや多い** — 5 つのロググループと 5 関数分の CloudWatch メトリクス。金額は誤差だが、見る対象は増える。
3. **ルート単位で適正サイズに** — `delete-todo` は小さい `memorySize` に、大きくするのはプロファイリングで効果が確認できた箇所だけに。Lambdalith ではこれができない。
4. **ARM64 / Graviton** と **`PAY_PER_REQUEST` DynamoDB** — 兄弟パターンと同じレバー。

## 🔒 セキュリティに関する考慮事項

### 実装済み

- ✅ **関数ごとの最小権限 IAM** — 読み取りルートは `grantReadData`、書き込みルートは `grantWriteData`、両方を得るのは `update-todo` のみ。ユニットテストで検証。
- ✅ **保管時の暗号化** — DynamoDB SSE + PITR。
- ✅ **転送時の TLS** — HTTPS のみの `execute-api` エンドポイント。
- ✅ **関数ごとのログ分離** — それぞれ 1 つのロググループ、保持期間付き。
- ✅ ステージの**アクセスログ + 実行ログ**。

### 意図的に対象外（環境ごとに追加）

コンプライアンステストで抑制しています。**本番 API にそのままコピーしないでください。**

- **認可**（`AwsSolutions-APIG4` / `COG4`）— メソッドごとにオーソライザーを付けるか、`RestApi` の `defaultMethodOptions` で 1 つの既定オーソライザーを付ける：
  ```typescript
  const auth = new apigateway.TokenAuthorizer(this, 'Auth', { handler: authFn });
  todosResource.addMethod('GET', integration, { authorizer: auth });
  ```
- **WAF**（`AwsSolutions-APIG3`）— `wafv2.CfnWebACLAssociation` をステージ ARN に関連付ける。
- **リクエスト検証**（`AwsSolutions-APIG2`）— ここでは API Gateway モデル + メソッドごとの `RequestValidator` を追加できる（明示的メソッドの利点）。または各ハンドラーで検証する。

### CDK Nag

```bash
npm run test:compliance -w workspaces/apigw-single-purpose-lambda
```

## 📋 前提条件

- API Gateway・Lambda・DynamoDB・IAM・CloudWatch Logs の権限を持つ AWS アカウント
- `${PROJECT}-${ENV}`（例: `apigw-single-purpose-lambda-dev`）という名前のプロファイルで構成した AWS CLI v2.x
- Node.js 20.x 以降、AWS CDK 2.x
- **Docker は不要** — `NodejsFunction` はローカルの `esbuild` でバンドルします

## 🚀 デプロイ手順

```bash
cd infrastructure
npm install

export PROJECT=apigw-single-purpose-lambda
export ENV=dev

npm run bootstrap  -w workspaces/apigw-single-purpose-lambda   # アカウント/リージョンごとに初回のみ
npm run synth      -w workspaces/apigw-single-purpose-lambda
npm run deploy:all -w workspaces/apigw-single-purpose-lambda
```

スタックは `ApiUrl` と `TodosTableName` を出力します。

## 使い方

```bash
API_URL="<ApiUrl の出力>"   # 例: https://abc123.execute-api.ap-northeast-1.amazonaws.com/dev/

# POST /todos            -> create-todo
curl -s -X POST "${API_URL}todos" -H 'content-type: application/json' -d '{"title":"buy milk"}' | jq .
# GET  /todos            -> list-todos
curl -s "${API_URL}todos" | jq .
# GET  /todos/{todoId}   -> get-todo
curl -s "${API_URL}todos/<todoId>" | jq .
# PUT  /todos/{todoId}   -> update-todo
curl -s -X PUT "${API_URL}todos/<todoId>" -H 'content-type: application/json' -d '{"title":"buy oat milk","completed":true}' | jq .
# DELETE /todos/{todoId} -> delete-todo
curl -s -i -X DELETE "${API_URL}todos/<todoId>"
```

各呼び出しは**別々の**関数が処理します。5 つのロググループを見ると、リクエストごとにちょうど 1 つだけが動くのが分かります。

## 🧪 テスト戦略

```
test/
├── compliance/
│   └── cdk-nag.test.ts                          # AWS Solutions パック + 理由付き抑制
├── parameters/
│   └── test-params.ts                           # 決定的な Environment.TEST パラメータ
├── snapshot/
│   └── snapshot.test.ts                         # テンプレート全体 + リソース数のスナップショット
└── unit/
    └── apigw-single-purpose-lambda-stack.test.ts # 5 関数、6 ロググループ、ルート単位の権限、5 メソッド、ステージログ、出力
```

```bash
npm test                -w workspaces/apigw-single-purpose-lambda   # すべて
npm run test:snapshot   -w workspaces/apigw-single-purpose-lambda
npm run test:unit       -w workspaces/apigw-single-purpose-lambda
npm run test:compliance -w workspaces/apigw-single-purpose-lambda
npm run test:snapshot   -w workspaces/apigw-single-purpose-lambda -- -u   # 意図した変更後にスナップショット更新
```

主なユニット検証：`AWS::Lambda::Function` がちょうど `5` 個、`AWS::Logs::LogGroup` がちょうど `6` 個、5 つの HTTP メソッド `['DELETE','GET','GET','POST','PUT']`、IAM ポリシーに読み取り専用（`PutItem` なしの `Scan`）ロールと書き込み専用（`GetItem`/`Scan` なしの `PutItem`）ロールが含まれること。

## ⚙️ カスタマイズ

### ルートを追加（インフラ + コード）

```typescript
// lib/stacks/apigw-single-purpose-lambda-stack.ts
const completeTodoHandler = makeHandler('CompleteTodo', 'complete-todo', 'complete-todo');
todosTable.grantWriteData(completeTodoHandler);
todoResource.addResource('complete').addMethod('POST', new apigateway.LambdaIntegration(completeTodoHandler));
```
その後 `src/handlers/complete-todo.ts` を追加します。

### 1 つのルートだけチューニング

```typescript
const listTodosHandler = new lambdaNodejs.NodejsFunction(this, 'ListTodosHandler', {
  ...commonProps,
  entry: 'src/handlers/list-todos.ts',
  handler: 'handler',
  functionName: `${project}-${environment}-list-todos`,
  memorySize: 512,                                   // このルートだけ
  reservedConcurrentExecutions: 50,
  logGroup: new logs.LogGroup(this, 'ListTodosLogGroup', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy }),
});
```

### 重複なしでコードを共有

`src/handlers/utils/` を Lambda レイヤー（`lambda.LayerVersion`）か社内ワークスペースパッケージに移し、`commonProps.layers` / `bundling.externalModules` に追加します。

## 🔧 トラブルシューティング

### 1 つのルートだけ 500 を返し、他は正常

これはパターンが意図どおり動いている状態です。障害は分離されています。**その関数の**ロググループを開いてください。他の 4 つは無関係です。

### `create-todo` が読み取りを試みて `AccessDeniedException`

`create-todo` は設計上 `grantWriteData` のみです。ハンドラーが本当に両方必要なら（`update-todo` のように）`grantReadWriteData` に切り替え、その理由を記録してください。

### `{"message":"Missing Authentication Token"}`

パスがどのメソッドにも一致しませんでした。プロキシパターンと違い、明示的に宣言したルートしか存在しません。上記 5 メソッドと照らしてメソッドとパスを確認してください（ベース URL は既に `/dev/` で終わることに注意）。

### `cdk deploy` が「CloudWatch Logs role ARN must be set in account settings」で失敗する

`RestApi` の `cloudWatchRole: true` がこのロールをスタック単位で作成します。維持するか、アカウント/リージョンごとに一度アカウントレベルの API Gateway CloudWatch ロールを設定してください。

### 無関係な変更後にスナップショットテストが失敗する

`esbuild` のアセットハッシュだけが動いた場合は `npm run test:snapshot -- -u` を実行してコミットしてください。リソース**数**が変わった場合は、ルートを追加/削除する意図があったか確認してください。

## 🧹 クリーンアップ

```bash
npm run destroy:all -w workspaces/apigw-single-purpose-lambda
```

`dev` では `isAutoDeleteObject: true` によりテーブルと 6 つのロググループに `RemovalPolicy.DESTROY` が設定されます。`prd` ではテーブルは保持されます。

## 📚 参考資料

### AWS ドキュメント
- [API Gateway で Lambda プロキシ統合をセットアップする](https://docs.aws.amazon.com/ja_jp/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html)
- [大規模なサーバーレスアプリケーションを構成するためのベストプラクティス](https://aws.amazon.com/jp/blogs/compute/best-practices-for-organizing-larger-serverless-applications/) — single-purpose と Lambdalith
- [関数に DynamoDB へのアクセスを付与する（`grant*Data`）](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_dynamodb.Table.html#grantwbrreadwbrdatagrantee)

### AWS CDK
- [aws-apigateway モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_apigateway-readme.html)
- [aws-lambda-nodejs モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html)

### 関連アーキテクチャ
- [apigw-lambdalith](../apigw-lambdalith/) — 同じ API を、プロセス内ルーティングの 1 関数で実装
- [apigw-lambda-web-adapter](../apigw-lambda-web-adapter/) — 同じ API を、Lambda Web Adapter の背後の Express サーバーとして実装
- [apigw-s3-stub](../apigw-s3-stub/) — Lambda を一切使わない API Gateway REST API

## 📄 ライセンス

本プロジェクトは MIT ライセンスです。詳細は [LICENSE](../../LICENSE) を参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します。詳細は [CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。

## 🏆 このリファレンスアーキテクチャについて

**対象レベル**: 300 (中級)

---

**注意**: これはリファレンス実装です。本番導入前に、認可・WAF・リクエスト検証・ルート単位のサイジング・環境固有パラメータなどをレビューし、要件に合わせてカスタマイズしてください。
