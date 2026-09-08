# FIS カオスエンジニアリング — アーキテクチャ B: CloudFront + API Gateway HTTP API + Lambda + DynamoDB

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20CloudFront%20%7C%20API%20Gateway%20%7C%20Lambda%20%7C%20DynamoDB-orange?style=flat-square)

## はじめに

本プロジェクトは、**サーバーレス Web API** アーキテクチャに対する AWS Fault Injection Simulator (FIS) を用いたカオスエンジニアリングのリファレンス実装です。CloudFront → API Gateway HTTP API → Lambda (Python 3.13) → DynamoDB の構成に対して、4 つの FIS 実験テンプレートが異なる障害シナリオを注入します。

| シナリオ | 注入する障害 | 実行時間 | 検証内容 |
| -------- | ------------ | -------- | -------- |
| **B-1** DynamoDB 内部エラー | 全 DynamoDB 操作に `InternalError` を注入 | 5 分 | Lambda のリトライ/バックオフ実装、500 エラーの伝播 |
| **B-2** DynamoDB 書き込みスロットル | PutItem + DeleteItem に `ProvisionedThroughputExceededException` を注入 | 5 分 | 書き込みパスのサーキットブレーカー。読み取り操作は正常動作を維持 |
| **B-3** DynamoDB 読み取りスロットル | GetItem + Scan に `ProvisionedThroughputExceededException` を注入 | 5 分 | 読み取りパスのフォールバック（キャッシュ返却・縮退運転）。書き込みは正常動作を維持 |
| **B-4** Lambda 同時実行数ゼロ | API 関数の予約同時実行数を 0 に設定 | 5 分 | API GW のエラーマッピングと CloudFront のカスタムエラーページへのフォールバック |

全実験テンプレートは CloudWatch Alarm の停止条件を共有します。Lambda エラー数が 1 分間に 10 件以上になると実験が自動停止し、長時間障害を防ぎます。

## アーキテクチャ概要

![アーキテクチャ概要](docs/architecture.html)

```
ユーザー (HTTPS)
    │
    ▼
CloudFront Distribution  (プライスクラス 100、TLS 1.2+、HTTP/2+3、IPv6)
    │  キャッシュ無効パススルー
    ▼
API Gateway HTTP API  (デフォルトステージ、CW Logs へのアクセスログ)
    │  Lambda プロキシ統合
    ▼
Lambda 関数  (Python 3.13、256 MB、タイムアウト 29 秒)
    │  GetItem / PutItem / DeleteItem / Scan
    ▼
DynamoDB テーブル  (PAY_PER_REQUEST、パーティションキー: id)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS 実験テンプレート (FisStack)

B-1  aws:fis:inject-api-internal-error ────► Lambda 実行ロール
     service=dynamodb、ops=GetItem,PutItem,DeleteItem,Scan、100%、5分

B-2  aws:fis:inject-api-throttle-error ───► Lambda 実行ロール
     service=dynamodb、ops=PutItem,DeleteItem、100%、5分

B-3  aws:fis:inject-api-throttle-error ───► Lambda 実行ロール
     service=dynamodb、ops=GetItem,Scan、100%、5分

B-4  aws:lambda:put-function-concurrent-executions ► Lambda 関数
     ConcurrentExecutions=0、5分
```

### 設計上のポイント

| 特徴 | 効果 |
| ---- | ---- |
| VPC 不要 | 完全サーバーレス — NAT Gateway・サブネット設計・VPC 時間課金なし |
| `aws:fis:inject-api-*` が IAM ロールをターゲット | FIS が Lambda 実行ロールの送信 DynamoDB 呼び出しを傍受。関数コードは変更不要 |
| B-2 / B-3 を分離 | 書き込みのみスロットル vs. 読み取りのみスロットル。"全部スロットル"では見えない非対称な縮退動作を検証 |
| 共有の停止条件 | 1 つの CloudWatch Alarm (Lambda エラー ≥ 10/分) が 4 つの実験すべてを自動停止 |
| CloudFront をフロントドア | 安定したドメイン、WAF アタッチポイント、実験中の 4xx/5xx レート観測場所 |

## 前提条件

- AWS CLI v2 のインストールと設定
- Node.js 20 以降
- AWS CDK CLI (`npm install -g aws-cdk`)
- TypeScript と Python の基礎知識
- FIS サービスリンクロールが作成済みの AWS アカウント（初回 FIS 利用時に自動作成）

## プロジェクトのディレクトリ構成

```text
fis-arch-b-apigw-lambda/
├── bin/
│   └── fis-arch-b-apigw-lambda.ts        # アプリエントリポイント（Stage のインスタンス化）
├── lambda/
│   └── api-handler/
│       └── index.py                       # Python 3.13 DynamoDB CRUD ハンドラー
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts             # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                  # DynamoDB テーブル
│       ├── app-stack.ts                   # Lambda + API GW HTTP API + CloudFront
│       └── fis-stack.ts                   # 4 つの FIS 実験テンプレート + IAM + アラーム
├── parameters/
│   ├── environments.ts                    # 環境パラメータの型定義
│   ├── dev-params.ts                      # 開発環境パラメータ
│   └── index.ts                           # パラメータエクスポート
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts               # cdk-nag AwsSolutions コンプライアンスチェック
│   └── snapshot/
│       └── snapshot.test.ts              # CDK スナップショットテスト（12 ケース）
├── docs/
│   └── architecture.html                 # インタラクティブ SVG アーキテクチャ図
├── cdk.json
├── package.json
└── tsconfig.json
```

## データフロー

```text
ユーザー（ブラウザまたは curl）
  │  HTTPS
  ▼
CloudFront Distribution
  │  キャッシュ無効（CACHING_DISABLED ポリシー）
  │  ALL_VIEWER_EXCEPT_HOST_HEADER オリジンリクエストポリシー
  ▼
API Gateway HTTP API  (/items、/items/{id})
  │  Lambda プロキシ統合 — HTTP リクエスト全体を転送
  ▼
Lambda 関数 (Python 3.13)
  ├── GET  /items          → table.scan()
  ├── POST /items          → table.put_item()  (body: {"name": "...", "value": "..."})
  ├── GET  /items/{id}     → table.get_item()
  └── DELETE /items/{id}  → table.delete_item()
  ▼
DynamoDB テーブル  (パーティションキー: id、POST 時に Lambda が UUID を生成)
```

### FIS 注入ポイント

`aws:fis:inject-api-*` アクションは、**指定した IAM ロールが行う AWS API 呼び出し**を傍受します。Lambda 実行ロールをターゲットにすることで、Lambda 関数内の全 DynamoDB 呼び出しに障害が注入されます。関数コードは変更されません。これが B-1/B-2/B-3 のターゲットが `aws:iam:role`（Lambda 実行ロール ARN）であり、`aws:dynamodb:table` ではない理由です。

## コンポーネントと設計ポイント

| コンポーネント | 設計ポイント |
| -------------- | ------------ |
| DynamoDB テーブル | PAY_PER_REQUEST で未使用時のコストはゼロ。PITR は実験コスト削減のため無効 |
| Lambda 関数 | Python 3.13、256 MB、タイムアウト 29 秒（API GW の 30 秒制限より 1 秒短い） |
| API Gateway HTTP API | デフォルトステージ、CloudWatch Logs へのアクセスログ、認証なし（パブリックデモ） |
| CloudFront Distribution | `CACHING_DISABLED` キャッシュポリシー、`ALL_VIEWER_EXCEPT_HOST_HEADER` オリジンリクエストポリシー |
| FIS IAM ロール | 最小権限: Lambda 実行ロールへの `fis:InjectApiInternalError` / `fis:InjectApiThrottleError`、Lambda 関数への `lambda:PutFunctionConcurrency` / `lambda:DeleteFunctionConcurrency` |
| CloudWatch 停止アラーム | `LambdaErrors ≥ 10 / 1 分` — 4 テンプレートで共有 |
| FIS ログ グループ | `/fis/{project}-{env}-b` — 30 日保持、スタック削除時に自動削除 |

## 実装ハイライト

### 1. FIS の API エラー注入は Lambda 実行ロールをターゲットにする

B-1、B-2、B-3 の核心は `aws:fis:inject-api-*` がリソースではなく **IAM ロール** をターゲットにする点です:

```typescript
// lib/stacks/fis-stack.ts（抜粋 — シナリオ B-1）
const lambdaExecRoleArn = props.apiFunction.role!.roleArn;

targets: {
    LambdaExecRole: {
        resourceType: 'aws:iam:role',
        resourceArns: [lambdaExecRoleArn],  // Lambda 実行ロール
        selectionMode: 'ALL',
    },
},
actions: {
    InjectDynamoInternalError: {
        actionId: 'aws:fis:inject-api-internal-error',
        parameters: {
            service: 'dynamodb',
            operations: 'GetItem,PutItem,DeleteItem,Scan',
            percentage: '100',
            duration: 'PT5M',
        },
        targets: { Roles: 'LambdaExecRole' },
    },
},
```

FIS は Lambda 関数が DynamoDB に対して行うすべての呼び出しを傍受し、`InternalError` を返します。コード変更なし、モックなし、VPC トラフィック操作なし — 注入は AWS コントロールプレーンで発生します。

### 2. B-2 vs. B-3: 非対称スロットルシナリオ

B-2 と B-3 は補完的な操作セットにスロットルエラーを注入します:

```typescript
// B-2: 書き込みのみスロットル — 読み取り（GetItem/Scan）は正常
parameters: {
    service: 'dynamodb',
    operations: 'PutItem,DeleteItem',   // 書き込みのみ
    percentage: '100',
    duration: 'PT5M',
},

// B-3: 読み取りのみスロットル — 書き込み（PutItem/DeleteItem）は正常
parameters: {
    service: 'dynamodb',
    operations: 'GetItem,Scan',         // 読み取りのみ
    percentage: '100',
    duration: 'PT5M',
},
```

実際の DynamoDB スロットリングは読み取りと書き込みで独立して発生します。両シナリオを実行することで、読み取り失敗時（キャッシュ返却できるか？）と書き込み失敗時（リトライキューに積めるか？）の非対称な縮退動作を個別に検証できます。

### 3. B-4: Lambda 同時実行数枯渇

B-4 は Lambda 関数の**予約同時実行数**を直接操作します:

```typescript
// B-4: 予約同時実行数を 0 に設定（5 分間）
targets: {
    ApiFunction: {
        resourceType: 'aws:lambda:function',
        resourceArns: [props.apiFunction.functionArn],
        selectionMode: 'ALL',
    },
},
actions: {
    SetConcurrencyZero: {
        actionId: 'aws:lambda:put-function-concurrent-executions',
        parameters: {
            ConcurrentExecutions: '0',
            duration: 'PT5M',
        },
        targets: { Functions: 'ApiFunction' },
    },
},
```

`reservedConcurrency: 0` の状態では、すべての Lambda 呼び出しが実行されずに即座に `TooManyRequestsException`（HTTP 429）を返します。API Gateway はこれを 429 または 502 にマッピングします。CloudFront がカスタムエラーページを設定している場合、ユーザーフレンドリーなフォールバックページが表示されます。

### 4. 停止条件とアラーム通知

全 4 テンプレートが同一の CloudWatch Alarm を停止条件として参照します:

```typescript
const lambdaErrorAlarm = new cw.Alarm(this, 'LambdaErrorAlarm', {
    metric: props.apiFunction.metricErrors({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
    }),
    threshold: 10,
    evaluationPeriods: 1,
    comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cw.TreatMissingData.NOT_BREACHING,
});
```

エラーレートが閾値を超えると FIS が実験を停止し、Lambda 実行ロールは正常状態に戻ります。SNS トピックへの通知も送信されます（`alarmEmail` パラメータでメール購読可能）。

## デプロイ手順

### 1. 依存関係のインストール

```bash
cd infrastructure
npm ci
```

### 2. 環境パラメータの設定

`parameters/dev-params.ts` でリージョンとアラームメールを設定します:

```typescript
// parameters/dev-params.ts
export const devParams: EnvParams = {
    region: 'ap-northeast-1',
    // alarmEmail: 'ops@example.com',  // アラーム通知を受け取る場合はコメントを外す
};
```

### 3. CDK のブートストラップ（初回のみ）

```bash
PROJECT=fis-chaos-b ENV=dev npm run bootstrap
```

### 4. 全スタックのデプロイ

```bash
PROJECT=fis-chaos-b ENV=dev npm run stage:deploy:all
```

依存関係の順序でスタックがデプロイされます:
1. `fis-chaos-b-dev-b-base` — DynamoDB テーブル
2. `fis-chaos-b-dev-b-app` — Lambda + API GW + CloudFront
3. `fis-chaos-b-dev-b-fis` — FIS テンプレート + IAM + アラーム

### 5. API の動作確認

スタック出力から CloudFront ドメインを取得してテストします:

```bash
# アイテム一覧の取得
curl https://<cloudfront-domain>/items

# アイテムの作成
curl -X POST https://<cloudfront-domain>/items \
  -H 'Content-Type: application/json' \
  -d '{"name":"test","value":"hello"}'

# アイテムの取得
curl https://<cloudfront-domain>/items/<id>

# アイテムの削除
curl -X DELETE https://<cloudfront-domain>/items/<id>
```

### 6. FIS 実験の実行

AWS FIS コンソールで `B-1` ～ `B-4` のいずれかの実験テンプレートを選択し、**実験の開始** をクリックします。CloudWatch で Lambda エラー数の変化を観測します。

## テスト

```bash
cd infrastructure
npm ci

# このワークスペースのテストをすべて実行
npm run test --workspace=fis-arch-b-apigw-lambda

# スナップショットテストのみ（3 スタックで 12 ケース）
npm run test:snapshot --workspace=fis-arch-b-apigw-lambda

# CDK Nag コンプライアンスチェック
npm run test:compliance --workspace=fis-arch-b-apigw-lambda

# 意図的な変更後にスナップショットを更新
npm run test:snapshot:update --workspace=fis-arch-b-apigw-lambda
```

### テストカバレッジ

| テストスイート | ファイル | 検証内容 |
| -------------- | -------- | -------- |
| スナップショット | `test/snapshot/snapshot.test.ts` | 全 3 スタックの CFn テンプレートスナップショット、DynamoDB PAY_PER_REQUEST、Lambda Python 3.13、CloudFront 数、API GW HTTP API 数、FIS テンプレート 4 つ、全テンプレートに停止条件あり |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions パック — 非抑制の警告・エラーがないこと |

## コスト見積もり

全サービスがサーバーレス（従量課金）のため、アイドル時のコストは実質 **ゼロ** です。

| サービス | 課金モデル | 実験中の推定コスト |
| -------- | ---------- | ------------------ |
| DynamoDB | PAY_PER_REQUEST | アイドル時はゼロ。数百リクエストで < $0.01 |
| Lambda | 呼び出し数 + 実行時間 | 10 req/s × 5 分で < $0.01 |
| API Gateway HTTP API | リクエスト数 | < $0.01 |
| CloudFront | リクエスト数 + データ転送 | < $0.01 |
| CloudWatch | メトリクス + ログ | 月額 ~$0.01 |
| FIS | 無料 | FIS 自体は無料 |
| **合計（実験あたり）** | | **< $0.10** |

## セキュリティ上の考慮事項

- **Lambda 実行ロールは最小権限**: `table.grantReadWriteData()` により、特定のテーブルに対する必要な DynamoDB アクション（GetItem/PutItem/DeleteItem/Scan）のみが付与されます。
- **FIS ロールは最小権限**: Lambda 実行ロール ARN に対する注入アクション、特定の Lambda 関数 ARN に対する同時実行数操作、停止条件アラームの DescribeAlarms のみに限定されています。
- **VPC なし**: VPC・パブリックサブネット・セキュリティグループが存在しないため、攻撃面は CloudFront/API GW のパブリックエンドポイントのみです。これはパブリックデモ API として適切です。
- **API は意図的に無認証**: 本リファレンスパターンは FIS の動作検証に焦点を当てています。本番環境では Cognito オーソライザーまたは IAM 認証を追加してください。
- **停止条件は必須**: 全 FIS テンプレートに Lambda エラーアラームの停止条件が含まれており、実験の最大影響範囲を制限しています。

## トラブルシューティング

| 症状 | 考えられる原因 | 対処法 |
| ---- | -------------- | ------ |
| `cdk deploy` が `No parameters found for environment` で失敗 | `dev-params.ts` のエクスポートが欠けている | `parameters/index.ts` が `dev` キーで `devParams` をエクスポートしていることを確認 |
| B-1 実験中に Lambda が 500 を返す | 想定通り — FIS が `InternalError` を注入中 | CloudWatch の Lambda メトリクスを確認。実験が実行中であることを確認 |
| FIS 実験が即座に停止する | 停止条件アラームがすでに `ALARM` 状態 | `aws cloudwatch set-alarm-state --alarm-name ... --state-value OK` でアラームをリセット |
| API 呼び出しで CloudFront が 403 を返す | オリジンリクエストポリシーが欠けている | CloudFront 動作設定に `ALL_VIEWER_EXCEPT_HOST_HEADER` が含まれていることを確認 |
| Lambda で `Table not found` エラー | BaseStack が未デプロイ | Base → App → FIS の順序でデプロイ |

## クリーンアップ

```bash
PROJECT=fis-chaos-b ENV=dev npm run stage:destroy:all
```

全リソースは `removalPolicy: DESTROY` に設定されているため、DynamoDB テーブル、Lambda、API GW、CloudFront ディストリビューション、FIS テンプレート、CloudWatch ログ グループが完全に削除されます。

## まとめ

本ワークスペースは、サーバーレス CRUD API アーキテクチャに対する FIS カオスエンジニアリングを実演します。4 つのシナリオは異なる障害モードをカバーします:

- **B-1** データ層が完全に利用不能になった際に、アプリケーションが安全に失敗するかを検証します。
- **B-2** 読み取りが正常な状態での書き込みパスの耐障害性を検証します（よくある DynamoDB キャパシティパターン）。
- **B-3** 書き込みが正常な状態での読み取りパスの耐障害性（キャッシュフォールバック、縮退運転）を検証します。
- **B-4** Lambda が全く実行できない場合の API 層の動作と、CloudFront のエラーページ機能を検証します。

サーバーレスアーキテクチャにより、実験コストは最小限（1 回あたり $0.10 未満）に抑えられ、VPC 管理の手間もなく、耐障害性シナリオの反復検証が容易になります。

## 参考資料

- [AWS FIS — サポートされているアクション](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [aws:fis:inject-api-internal-error アクションリファレンス](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-fis)
- [aws:lambda:put-function-concurrent-executions アクションリファレンス](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-lambda)
- [CDK aws-fis モジュール (L1 コンストラクト)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
- [API Gateway HTTP API — Lambda 統合](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html)
