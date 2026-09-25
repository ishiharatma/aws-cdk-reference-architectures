# DynamoDB ベクトル検索によるセマンティック検索 API - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **Level: 300 (Intermediate)**

**Amazon DynamoDB のネイティブベクトル検索**で作る、意味ベースのセマンティック検索 API です。OpenSearch も別のベクトルデータベースも使いません。ドキュメントは 1 つのオンデマンド DynamoDB テーブルに保存し、**DynamoDB Streams → Lambda → Amazon Bedrock(Titan Text Embeddings V2)** が埋め込みベクトルを同じ項目へ書き戻します。テーブルに宣言した**ベクトルインデックス**が `SearchVectors` に応答するので、たとえば「*関数が、しばらく使っていない後の初回だけ遅い*」という質問で **"Reducing Lambda cold starts"** がヒットします。キーワードは一致していなくても、また日本語のクエリで英語のドキュメントを検索しても動作します。

ベクトルインデックスは `AWS::DynamoDB::Table` の `VectorIndexes` プロパティで宣言します。`aws-cdk-lib` にはまだ L2 の対応がないため、このスタックでは下位の `CfnTable` に `addPropertyOverride` で適用しています。

## 📑 目次

- [アーキテクチャ概要](#-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [Well-Architected との対応](#-well-architected-との対応)
- [コスト最適化](#-コスト最適化)
- [セキュリティ](#-セキュリティ)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [使い方](#使い方)
- [動作確認スクリプト](#-動作確認スクリプト)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![Architecture Diagram](overview.drawio.svg)

### 主要コンポーネント

- **Amazon DynamoDB(`documents` テーブル)** — オンデマンド(ベクトルインデックスの必須条件)、パーティションキー `docId`、SSE、ポイントインタイムリカバリ、ストリーム `NEW_IMAGE`。次のベクトルインデックスを持ちます。

  | ベクトルインデックスの設定 | 値 | 理由 |
  |---|---|---|
  | `IndexName` | `embedding-idx` | 検索 Lambda と IAM ポリシーが参照する |
  | `VectorAttribute` | `embedding` | 埋め込み Lambda が書き込む float32 のリスト |
  | `Dimensions` | `256`(パラメータ) | Titan V2 は 256/512/1024 に対応。小さいほど保存・検索コストが下がり、再現率はわずかに下がる |
  | `DistanceFunction` | `COSINE` | スコアは距離(0 = 同一 … 2 = 正反対) |
  | `SearchSchema` | `category` = `INLINE_FILTER` | フィルタをベクトル検索の**内部**で評価する |
  | `Projection` | `INCLUDE title, category` | API が返す属性のみ。`body` は意図的に含めない |

- **AWS Lambda ×4(Node.js 24 / ARM64、ロググループは関数ごと)**
  | 関数 | トリガー | 処理 | IAM(最小権限) |
  |---|---|---|---|
  | `ingest` | `POST /documents` | 検証して `PutItem`(この時点では埋め込みなし)、`202` を返す | `dynamodb:PutItem` |
  | `get-document` | `GET /documents/{docId}` | `embeddingStatus: pending \| ready` を返す(ベクトル本体は返さない) | `dynamodb:GetItem` |
  | `embed` | DynamoDB Streams | Titan V2 → `UpdateItem SET embedding, embeddedAt` | `dynamodb:UpdateItem`、モデル ARN への `bedrock:InvokeModel`、ストリーム読み取り |
  | `search` | `GET /search?q=&k=&category=` | クエリを埋め込み、`SearchVectors` を実行 | **インデックス ARN** への `dynamodb:SearchVectors`、モデル ARN への `bedrock:InvokeModel` |

- **Amazon Bedrock — Titan Text Embeddings V2**(`amazon.titan-embed-text-v2:0`、`normalize: true`)
- **イベントソースマッピング** — `TRIM_HORIZON`、バッチ 5、`ReportBatchItemFailures`、エラー時のバッチ分割、リトライ 3 回、**SQS DLQ** と **CloudWatch アラーム**(1 件以上)
- **Amazon API Gateway(REST)** — 全メソッドで API キー必須+使用量プラン(レート/バースト/日次クォータ)、リクエストバリデータ 1 つ(ボディモデル+必須クエリパラメータ)、アクセスログ

### アーキテクチャの特性

| 特性 | 値 | 根拠 |
|---|---|---|
| 書き込み経路 | 非同期の埋め込み | Bedrock のレイテンシやスロットリングが取り込みの失敗・遅延にならない。`202` + `embeddingStatus` のポーリング |
| 検索経路 | Bedrock 1 回 + `SearchVectors` 1 回 | ベクトルインデックスはテーブルの一部で、同期が必要な 2 つ目のデータストアがない |
| 整合性 | 結果整合 | `embeddingStatus` が `ready` になった少し後に検索可能になる。確認スクリプトはリトライする |
| 障害処理 | レコード単位のリトライ → DLQ | 1 件の不良レコードがシャード全体を止めない |

## 🎯 設計判断とベストプラクティス

### 1. なぜ DynamoDB ネイティブベクトル検索か(使わない場合はいつか)

| 選択肢 | メリット | デメリット |
|---|---|---|
| **DynamoDB ベクトルインデックス(本構成)** | 1 つのテーブルが原本かつインデックス。別ストアへの同期パイプラインが不要。オンデマンド。インラインフィルタ。既存の IAM / PITR / ストリームをそのまま利用 | オンデマンドテーブルのみ。インデックス定義がテーブルの一部(次元数はインデックス単位で固定)。新しい機能のため CDK/CFn の対応範囲が小さい |
| OpenSearch Serverless / Aurora pgvector | 豊富なクエリ機能(全文+ベクトルのハイブリッド、集計、SQL 結合) | 運用と同期が必要な 2 つ目のシステム。ベースコスト(OCU / インスタンス) |
| Amazon S3 Vectors | 大規模でアクセス頻度の低いベクトル集合に低コスト | 別ストア。トランザクショナルなテーブルではない |

データがすでに DynamoDB にあり、「似た項目を探す」を単純な属性フィルタ付きで実現したい場合は DynamoDB が適しています。ハイブリッド検索・複雑なランキング・結合が必要なら OpenSearch / pgvector を選びます。

### 2. DynamoDB Streams から非同期に埋め込む

`POST /documents` は項目を書くだけです。埋め込みはストリーム駆動の Lambda が行うため、取り込みは高速なままで、Bedrock のスロットリングはユーザー向けエラーではなくリトライ/DLQ になります。トレードオフは「項目はあるがまだ検索できない」短い時間帯が生じることで、`embeddingStatus` として明示しています。

### 3. ループ防止: フィルタはベクトルではなく**スカラーのリーフ**に掛ける

embed Lambda 自身の `UpdateItem` も新しいストリームレコードを生成します。イベントソースマッピングのフィルタは **`embeddedAt` を持たないレコードだけ**を通します。

```typescript
lambda.FilterCriteria.filter({
  eventName: lambda.FilterRule.or('INSERT', 'MODIFY'),
  dynamodb: { NewImage: { embeddedAt: { S: lambda.FilterRule.notExists() } } },
});
```

`embedding`(リスト、つまりリーフではない `{"L": [...]}`)に `exists: false` を指定すると**全レコードに一致**します。Lambda の `exists` 演算子はリーフノードにしか効かないためです。フィルタをスカラーの `embeddedAt` に移すまでは全ドキュメントが 2 回埋め込まれていました(関数のログで確認: 10 件に対し 埋め込み 20 回 + スキップ 10 回 → 10 回 + 0 回)。ハンドラー先頭の早期リターンと条件付き `UpdateItem` は第二の防御線として残しています。項目を**再埋め込み**したい場合(モデル変更後など)は `REMOVE embeddedAt` します。

### 4. `INLINE_FILTER` でフィルタ下でも top-k が正確になる

`category` はインデックスの `SearchSchema` に `INLINE_FILTER` として入っているため、`SearchConditionExpression: '#c = :c'` はベクトル検索の内部で実行されます。top-k を取ってから後でフィルタすると *k* 件未満になります(確認スクリプトは、`k=5` で `category=database` を指定すると database の 2 件だけが返ることを検証します)。また `SearchSchema` の属性はすべて `AttributeDefinitions` にも宣言が必要で、ないと `CreateTable` が *"One element in SearchSchema is not defined in attribute definitions"* で失敗します。

### 5. `VectorIndexes` は CDK のエスケープハッチで適用

```typescript
const cfnTable = table.node.defaultChild as dynamodb.CfnTable;
cfnTable.addPropertyOverride('AttributeDefinitions', [
  { AttributeName: 'docId', AttributeType: 'S' },
  { AttributeName: 'category', AttributeType: 'S' },
]);
cfnTable.addPropertyOverride('VectorIndexes', [{ IndexName: 'embedding-idx', /* … */ }]);
```

CloudFormation のレジストリスキーマには `VectorIndexes` が載っていませんが、プロパティは受け付けられ `ACTIVE` なインデックスが作成されます(検証済み)。ユニットテストで出力プロパティを固定しているので、将来 L2 に移行する際も安全にリファクタリングできます。

### 6. インデックス作成時とクエリ時で同じモデル・次元・正規化を使う

検索 Lambda は、embed Lambda と全く同じパラメータ(`EMBEDDING_MODEL_ID`、`EMBEDDING_DIMENSIONS`、`normalize: true`。すべて同じ `EnvParams` 由来)でクエリを埋め込みます。モデルや次元が異なるベクトルは比較できないため、変更する場合は新しいインデックスの作成と再埋め込みが必要です。

### 7. ベクトルは `UpdateItem` で書き込む

私たちのテスト(256 次元)では、ベクトルを含めて 1 回の `PutItem` で作成した項目は**検索されませんでした**(自身のベクトルで検索しても `SearchVectors` が返さない)。一方、同じベクトルを `UpdateItem` で追加した項目は距離 ≈ 0 でヒットしました。このパイプラインは常に項目を先に作成し、ベクトルを `UpdateItem` で追加するため、この問題を回避できています。詳細と検証方法は [docs/knowledge/dynamodb-vector-search.md](../../../docs/knowledge/dynamodb-vector-search.md) にあります。計算済みベクトルを一括投入する場合は、先に自己クエリで確認してください。

### 8. 関数ごとの最小権限

各関数には必要なアクションだけを付与し、`SearchVectors` は**インデックス ARN** のみ、`bedrock:InvokeModel` は該当の基盤モデル ARN のみに付与します。ユニットテストでアクションの集合を厳密に検証しています。

### 9. AWS SDK をバンドルする

`NodejsFunction` で `@aws-sdk/client-dynamodb` / `client-bedrock-runtime` をバンドル(`externalModules: []`)し、ビルド・テストしたバージョンの SDK をそのままデプロイします。Lambda ランタイム組み込みの SDK はバージョンが固定されておらず、`SearchVectors` API より古い可能性があります。

### 10. 環境別パラメータ

`parameters/<env>-params.ts`(`EnvParams`): `embeddingModelId`、`embeddingDimensions`、`apiRateLimit`、`apiBurstLimit`、`apiDailyQuota`。

## 🏛️ Well-Architected との対応

| 柱 | 実装 |
|---|---|
| **運用上の優秀性** | 関数ごとのロググループ+API アクセスログ、DLQ アラーム、`test-semantic-search.sh` が非同期パイプラインを E2E で検証、スナップショット+ユニット+CDK Nag テスト |
| **セキュリティ** | 関数ごとの最小権限 IAM(インデックス単位の `SearchVectors`、モデル単位の `InvokeModel`)、SSE + PITR、API キー+使用量プラン、リクエスト検証、TLS を強制した暗号化 DLQ |
| **信頼性** | マネージドなサーバーレスサービス、バッチ分割付きストリームリトライ+DLQ、冪等な条件付き書き戻し、PITR |
| **パフォーマンス効率** | ARM64、256 次元ベクトル、インラインフィルタで過剰取得を回避、`k` の上限 20 |
| **コスト最適化** | ゼロスケールのコンピュート、オンデマンド DynamoDB、使用量プランのクォータで Bedrock 費用に上限、`body` をインデックスに含めない |
| **持続可能性** | Graviton、常時稼働の検索クラスターなし |

## 💰 コスト最適化

### 月額コストの目安(ap-northeast-1 / 東京、オンデマンド、無料枠を除く)

想定: **月 10,000 ドキュメントの取り込み + 100,000 回の検索**(開発〜小規模本番)

```
API Gateway REST:        110,000 リクエスト x $4.25 / 100万                 ≈ $0.47
Lambda(4 関数):        約 110,000 呼び出し、256 MB arm64、約 300 ms       ≈ $0.10
Bedrock Titan V2:        10,000 文書 x 約150トークン + 100,000 クエリ x 約20トークン
                         = 350万トークン x $0.00002 / 1K                  ≈ $0.07
DynamoDB(テーブル本体): 約 1万書き込み x 2(put + update)+ 読み取り        ≈ $0.05
CloudWatch Logs:         1 GB 未満                                          ≈ $0.50
-------------------------------------------------------------------
合計(DynamoDB のベクトルインデックス料金を除く):                          ≈ $1.2 / 月
```

**含まれていないもの:** DynamoDB のベクトルインデックスのストレージとベクトル読み書き料金。`VectorWriteRequestBytes` / `VectorSearchRequestBytes` として計測されます(本構成での実測: 256 次元ベクトル 1 件の書き込みで **1,061 バイト**、小さなテーブルでの top-5 検索で **6,914 バイト**)。単価は [DynamoDB 料金ページ](https://aws.amazon.com/dynamodb/pricing/on-demand/) で確認し、実トラフィックで `--return-consumed-capacity INDEXES` が返すバイト数を掛けて見積もってください。

*(2026 年時点の料金。[AWS 料金見積りツール](https://calculator.aws/) で確認してください。)*

### コストレバー

1. **次元数** — 256 と 1024 では、1 操作あたりのベクトルバイト数が 4 倍違います。選ぶ前に自分のデータで再現率を確認してください。
2. **Projection** — 射影する属性が増えるほどインデックスサイズと書き込みコストが増えます。API が返す属性だけを射影します。
3. **使用量プランのクォータ** — `apiDailyQuota` により、API キーが漏えいしても Bedrock 費用に上限がかかります。
4. **クエリ埋め込みのキャッシュ** — 同じクエリが繰り返される場合は Bedrock 呼び出しを省略できます。

## 🔒 セキュリティ

### 実装済み

- ✅ **関数ごとの最小権限 IAM** — `SearchVectors` はインデックス ARN、`InvokeModel` は 1 つのモデル ARN のみ(ユニットテストで検証)
- ✅ **保存時の暗号化** — DynamoDB SSE(AWS マネージドキー)、DLQ は SQS マネージド SSE、PITR
- ✅ **TLS** — HTTPS のみの API エンドポイント、DLQ ポリシーで TLS を強制
- ✅ **入力検証** — API Gateway のモデルと必須 `q`、ハンドラー側でも長さ・`k` の範囲・`category` のパターンを再検証
- ✅ **不正利用・費用の抑制** — API キー+使用量プランのスロットルと日次クォータ

### 意図的に対象外(環境ごとに追加)

コンプライアンステストで抑制しています。本番 API にこの抑制をコピーしないでください。

- **認可**(`AwsSolutions-APIG4` / `COG4`): API キーは費用の上限であり、ユーザー認証ではありません。実ユーザー向けには Cognito / IAM オーソライザーを追加します。
- **WAF**(`AwsSolutions-APIG3`): WAFv2 Web ACL を関連付けます(固定の月額費用が発生)。
- **データ分類**: ドキュメントとクエリは Bedrock に送信されます。このリージョンで Titan による処理が許されないデータはインデックスしないでください。

### CDK Nag

```bash
npm run test:compliance -w workspaces/dynamodb-vector-search-semantic-api
```

## 📋 前提条件

- AWS アカウント、`${PROJECT}-${ENV}` という名前のプロファイルを設定した AWS CLI v2、Node.js 20 以上、確認スクリプト用の `jq` と `curl`
- **対象リージョンで Amazon Bedrock の Titan Text Embeddings V2(`amazon.titan-embed-text-v2:0`)が利用可能**であること(`aws bedrock list-foundation-models`)。また DynamoDB のベクトル検索がそのリージョンで利用可能であること
- `npm install` で入る AWS SDK に `SearchVectorsCommand` が含まれること(このワークスペースは `^3.1140.0` を指定)
- Docker は**不要**(`NodejsFunction` がローカルの `esbuild` でバンドル)

## 🚀 デプロイ手順

```bash
cd infrastructure
npm install

export PROJECT=<project>
export ENV=dev

npm run bootstrap        -w workspaces/dynamodb-vector-search-semantic-api   # 初回のみ
npm run synth            -w workspaces/dynamodb-vector-search-semantic-api
npm run validate         -w workspaces/dynamodb-vector-search-semantic-api
npm run stage:deploy:all -w workspaces/dynamodb-vector-search-semantic-api
```

出力: `ApiUrl`、`ApiKeyId`、`TableName`、`VectorIndexName`、`EmbedDlqUrl`

## 使い方

```bash
API_URL="<ApiUrl の出力>"     # 例: https://abc123.execute-api.ap-northeast-1.amazonaws.com/dev/
API_KEY=$(aws apigateway get-api-key --api-key <ApiKeyId の出力> --include-value --query value --output text)

# 1. ドキュメントを追加(すぐに 202 を返し、埋め込みは非同期)
curl -s -X POST "${API_URL}documents" -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"title":"Reducing Lambda cold starts","body":"Use provisioned concurrency and smaller packages...","category":"serverless"}'

# 2. embeddingStatus が "ready" になるまで待つ
curl -s "${API_URL}documents/<docId>" -H "x-api-key: $API_KEY"

# 3. 意味で検索(category で絞り込み可、k は 1〜20)
curl -s -G "${API_URL}search" -H "x-api-key: $API_KEY" \
  --data-urlencode "q=関数が、しばらく使っていない後の初回だけ遅い" \
  --data-urlencode "category=serverless" | jq .
```

各結果には `distance`(COSINE: 0 = 同一)と `similarity = 1 - distance` が含まれます。スコアは**順位付け**に使い、足切りの値は自分のデータで実測して決めてください。

## 🧪 動作確認スクリプト

`cdk deploy` が成功しても、このパターンが動いている証明にはなりません。埋め込みは非同期で、ベクトルインデックスは結果整合だからです。[`test-semantic-search.sh`](./test-semantic-search.sh) は実際の往復を検証します。

```bash
./test-semantic-search.sh --project <project> --env dev            # 10 件を投入して検証
./test-semantic-search.sh --project <project> --env dev --cleanup  # 検証後に削除
```

(1) 10 件のドキュメントを投入、(2) Streams → Bedrock → `UpdateItem` のパイプライン完了を待機、(3) 対象ドキュメントとキーワードを共有しない 4 つのクエリ(1 つは日本語)の先頭ヒットを検証、(4) `category` インラインフィルタを検証、(5) `embeddedAt` を削除して再埋め込みされることを検証、(6) `400`(バリデーション)と `403`(API キーなし)を確認します。`aws`、`curl`、`jq` が必要です。

## 🧪 テスト戦略

```bash
npm test                  -w workspaces/dynamodb-vector-search-semantic-api   # 全 19 テスト
npm run test:unit         -w workspaces/dynamodb-vector-search-semantic-api
npm run test:snapshot     -w workspaces/dynamodb-vector-search-semantic-api
npm run test:compliance   -w workspaces/dynamodb-vector-search-semantic-api   # CDK Nag AwsSolutions
```

| 種類 | 対象 |
|---|---|
| スナップショット(2) | テンプレート全体+リソース数(Lambda アセットのハッシュは正規化) |
| ユニット(15) | テーブル/ベクトルインデックスのプロパティ、`AttributeDefinitions`、IAM アクションの厳密な集合、ストリームフィルタのパターン、DLQ+アラーム、API キー/バリデータ/使用量プラン、出力 |
| コンプライアンス(2) | CDK Nag `AwsSolutions` — 抑制されていない警告/エラーなし |
| 運用確認 | デプロイ済みスタックに対する `test-semantic-search.sh` |

## ⚙️ カスタマイズ

- **モデル/次元の変更**: パラメータファイルの `embeddingModelId` / `embeddingDimensions` を変更します。ベクトルインデックス定義も変わるため、新しいインデックス(またはテーブル)の作成と、全項目の再埋め込み(`REMOVE embeddedAt`)を計画してください。
- **フィルタの追加**: `SearchSchema` に `INLINE_FILTER` として属性を追加し(`AttributeDefinitions` にも追加)、API が返す場合は射影にも含めます。
- **距離関数の変更**: `EUCLIDEAN` / `DOT_PRODUCT`(DOT_PRODUCT は*大きいほど近い*ので `search.ts` の `similarity` の計算を更新)。
- **認証の追加**: `apiKeyRequired` を Cognito/IAM オーソライザーに置き換えます(使用量プランは維持)。

## 🔧 トラブルシューティング

### ドキュメント追加直後に `GET /search` が `count: 0` を返す
埋め込みは非同期です。`GET /documents/{docId}` で `embeddingStatus` が `ready` になるまでポーリングしてください。インデックスは結果整合なので、その後さらに数秒待ちます。

### ドキュメントが `pending` のまま
`embed` 関数のロググループと DLQ(`EmbedDlqUrl`)を確認します。典型的な原因は、Bedrock のスロットリング(リトライ後に DLQ)、リージョンでモデルが利用できない、`bedrock:InvokeModel` の権限不足です。

### `Search vector contains invalid values … 32-bit floating-point number`
`SearchVector` は `{L: [...]}` ではなく **`{N: "…"}` のリスト**で渡します(値は float32 に収まる必要があります)。`Math.fround` を使ってください。

### `SearchVectors` で `AccessDeniedException`
アクションは `dynamodb:SearchVectors`、リソースはテーブル ARN ではなく**インデックス ARN**(`table/<name>/index/embedding-idx`)です。

### ドキュメントが 2 回埋め込まれる
イベントソースのフィルタは、リスト型の `embedding` ではなくスカラーの `embeddedAt` を対象にする必要があります(設計判断 3 を参照)。

### `PutItem` で投入したベクトルが検索されない
設計判断 7 を参照してください。ベクトルは `UpdateItem` で追加します。

### しばらくすると `cdk deploy` が "no credentials" で失敗する
同梱の CDK は期限切れの SSO トークンを更新できません。短期認証情報を環境変数へエクスポート(`aws configure export-credentials --format env`)するか、`aws sso login` をやり直してください。

### 無関係な変更でスナップショットテストが失敗する
Lambda アセットのハッシュは正規化しています。差分が本物であれば `npm run test:snapshot:update` で更新し、内容をレビューしてください。

## 🧹 クリーンアップ

```bash
npm run stage:destroy:all -w workspaces/dynamodb-vector-search-semantic-api
```

`dev` では `isAutoDeleteObject` が true(テーブル・DLQ・ロググループは `RemovalPolicy.DESTROY`)、`prd` では保持されます。投入したテストドキュメントは `./test-semantic-search.sh --cleanup` で削除できます。

## 📚 参考資料

### AWS ドキュメント
- [Amazon DynamoDB のベクトル検索](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/) — `CreateTable --vector-indexes`、`SearchVectors`
- [Amazon Titan Text Embeddings V2](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html)
- [Lambda のイベントフィルタリング(DynamoDB Streams)](https://docs.aws.amazon.com/lambda/latest/dg/with-ddb-filtering.html) — `exists` はリーフノードのみ
- [バッチアイテム失敗のレポート](https://docs.aws.amazon.com/lambda/latest/dg/services-ddb-batchfailurereporting.html)

### 関連アーキテクチャ
- [apigw-single-purpose-lambda](../apigw-single-purpose-lambda/) — ルートごとに 1 つの Lambda。同じ API Gateway + DynamoDB の構成
- [sqs-lambda-firehose](../sqs-lambda-firehose/) — DLQ 付きのイベント駆動 Lambda パイプライン
- [ecspresso-bedrock-review](../ecspresso-bedrock-review/) — Bedrock 連携の別ワークスペース

## 📄 ライセンス

このプロジェクトは MIT ライセンスです。詳細は [LICENSE](../../LICENSE) を参照してください。

## 👥 コントリビュート

コントリビュートを歓迎します。詳細は [CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。

## 🏆 このリファレンスアーキテクチャについて

**対象レベル**: 300 (Intermediate)

---

**注意**: これはリファレンス実装です。本番利用の前に、認証、WAF、データ分類の統制、負荷試験に基づくキャパシティ設定を追加してください。
