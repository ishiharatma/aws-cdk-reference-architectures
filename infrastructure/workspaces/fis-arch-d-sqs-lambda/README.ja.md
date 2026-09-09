# FIS カオスエンジニアリング — アーキテクチャ D: SQS + Lambda イベント駆動コンシューマー

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20SQS%20%7C%20Lambda%20%7C%20DynamoDB-orange?style=flat-square)

## はじめに

本プロジェクトは、**SQS + Lambda イベント駆動コンシューマー**アーキテクチャに対する AWS Fault Injection Simulator (FIS) を用いたカオスエンジニアリングのリファレンス実装です。Producer Lambda（Function URL 経由）がデモ用の負荷を受け付けて SQS メインキューへメッセージを送信し、Consumer Lambda が SQS イベントソースマッピング経由でキューを処理して DynamoDB に処理済みレコードを書き込みます。処理に失敗したメッセージは、複数回の受信後にデッドレターキュー (DLQ) へ再配送されます。

3 つの FIS 実験テンプレートが Consumer Lambda の予約同時実行数を操作し、コンシューマーの停止・劣化という現実的な障害モードを検証します。

| シナリオ | 注入する障害 | 実行時間 | 検証内容 |
| -------- | ------------ | -------- | -------- |
| **D-1** Consumer 完全停止（短時間） | `ConcurrentExecutions='0'` | 5 分 | 可視性タイムアウト（60 秒）内でのメッセージ再配信、同時実行数復旧後のバックログ解消 |
| **D-2** Consumer 完全停止（長時間、DLQ誘発） | `ConcurrentExecutions='0'` | 20 分 | DLQ ルーティングの確実な発生（20 分 ≫ visibilityTimeout × maxReceiveCount = 180 秒）、DLQ アラームとリプレイ手順 |
| **D-3** スループット崩壊 | `ConcurrentExecutions='1'` | 10 分 | 極端だがゼロではないスループット低下時のキュー滞留・レイテンシ増加パターン |

全実験テンプレートは CloudWatch Alarm の停止条件を共有します。SQS メインキューの可視メッセージ数が 1000 件を超えると実験が自動停止し、無制限なバックログ増加を防ぎます。

## アーキテクチャ概要

![アーキテクチャ概要](docs/architecture.html)

```
Operator (curl / シェルループ)
    │  POST (IAM 署名済み)
    ▼
Producer Lambda  (Function URL, AWS_IAM 認証, Python 3.13)
    │  sqs:SendMessage
    ▼
SQS メインキュー  (visibilityTimeout=60秒, maxReceiveCount=3 → DLQ)
    │  イベントソースマッピング, batchSize=5, ReportBatchItemFailures
    ▼
Consumer Lambda  (Python 3.13)
    │  dynamodb:PutItem
    ▼
DynamoDB テーブル  (PAY_PER_REQUEST, パーティションキー: id)

SQS メインキュー ──（3回の受信失敗/未処理後）──► DLQ（保持期間 14日）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS 実験テンプレート (FisStack)

D-1  aws:lambda:put-function-concurrent-executions ──► Consumer Lambda
     ConcurrentExecutions='0', PT5M   (短時間停止、DLQ誘発なし)

D-2  aws:lambda:put-function-concurrent-executions ──► Consumer Lambda
     ConcurrentExecutions='0', PT20M  (長時間停止、DLQ誘発を確実に発生)

D-3  aws:lambda:put-function-concurrent-executions ──► Consumer Lambda
     ConcurrentExecutions='1', PT10M  (スループット崩壊、停止なし)
```

### なぜ同時実行数操作のみなのか（設計判断）

Architecture B が DynamoDB に対して用いている `aws:fis:inject-api-internal-error` / `aws:fis:inject-api-throttle-error` アクションは、本稿執筆時点で `service: 'ec2'` または `service: 'kinesis'` のみをサポートしています。**SQS と DynamoDB はこれらのアクションでサポートされている service 値ではない**ため、FIS が `ReceiveMessage` / `SendMessage` / `PutItem` の API エラーをこのパイプラインへ直接注入する公式にサポートされた方法は存在しません。Lambda 拡張機能ベースのアクション（`invocation-error` / `invocation-add-delay`）は原理的には存在しますが、必要な S3 レイヤーバケット構造や環境変数名などの正確なセットアップ仕様を一次情報の AWS ドキュメントで確認できなかったため、推測に基づく設定でリファレンス実装を構築することを避けるべく、意図的に**使用しません**。

代わりに、本ワークスペースの全シナリオは `fis-arch-b-apigw-lambda` で実績のある `aws:lambda:put-function-concurrent-executions` アクションを **Consumer Lambda の予約同時実行数**に対して使用します。これは妥協というより、SQS + Lambda パイプラインで実際に運用者が検証すべき事象への適合と言えます。すなわち、コンシューマーが「処理を完全に停止した場合」（不良デプロイ、下流の障害、全呼び出しでクラッシュするバグに相当）と、「通常よりはるかに遅く処理する場合」（リソース枯渇やノイジーネイバーによるスロットリングに相当）です。どちらもコンシューマー側の障害モードであり、予約同時実行数は SQS や DynamoDB のセマンティクスを FIS が理解する必要なく、これらを再現するための直接的でサポートされたレバーです。

### 設計上のポイント

| 特徴 | 効果 |
| ---- | ---- |
| VPC 不要 | 完全サーバーレス — NAT Gateway・サブネット設計・VPC 時間課金なし |
| 同時実行数操作のみの FIS アクション | 仕様が確認済みでドキュメント化された FIS Lambda アクションのみを使用。推測ベースの Lambda 拡張機能設定は行わない |
| D-1 と D-2 の時間差設計 | 5 分（キュー再配信の範囲内で回復可能）vs. 20 分（確実に DLQ へメッセージを誘発）。同じ障害を 2 つの被害範囲で検証 |
| D-3 の部分的劣化 | 予約同時実行数を 0 ではなく 1 に設定し、「遅いが生きている」というより現実的なコンシューマー状態を検証。完全停止テストだけでは見逃す |
| 共有の停止条件 | 1 つの CloudWatch Alarm（SQS バックログ ≥ 1000 可視メッセージ）が 3 つの実験すべてを自動停止 |
| Function URL のプロデューサー | デモ負荷を投入するためだけに API Gateway は不要 — IAM 署名済み POST 1 回で十分 |

## 前提条件

- AWS CLI v2 のインストールと設定
- Node.js 20 以降
- AWS CDK CLI (`npm install -g aws-cdk`)
- TypeScript と Python の基礎知識
- FIS サービスリンクロールが作成済みの AWS アカウント（初回 FIS 利用時に自動作成）

> **VPC・NAT Gateway コストなし**: 本アーキテクチャは完全サーバーレスサービスのみで構成されます。アイドル時の主要コストはゼロです（DynamoDB PAY_PER_REQUEST、SQS/Lambda は従量課金）。

## プロジェクトのディレクトリ構成

```text
fis-arch-d-sqs-lambda/
├── bin/
│   └── fis-arch-d-sqs-lambda.ts          # アプリエントリポイント（Stage のインスタンス化）
├── lambda/
│   ├── consumer/
│   │   └── index.py                       # Python 3.13 SQS → DynamoDB コンシューマー
│   └── producer/
│       └── index.py                       # Python 3.13 Function URL → SQS プロデューサー
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts             # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                  # DynamoDB テーブル + SQS メインキュー + DLQ
│       ├── app-stack.ts                   # Consumer Lambda（SQS イベントソース）+ Producer Lambda（Function URL）
│       └── fis-stack.ts                   # 3 つの FIS 実験テンプレート + IAM + アラーム
├── parameters/
│   ├── environments.ts                    # 環境パラメータの型定義
│   ├── dev-params.ts                      # 開発環境パラメータ
│   └── index.ts                           # パラメータエクスポート
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts               # cdk-nag AwsSolutions コンプライアンスチェック
│   └── snapshot/
│       └── snapshot.test.ts              # CDK スナップショットテスト（21 ケース）
├── docs/
│   └── architecture.html                 # インタラクティブ SVG アーキテクチャ図
├── overview.drawio.svg                   # スタンドアロンのアーキテクチャ図（SQS/Lambda/DynamoDB + FIS）
├── cdk.json
├── package.json
└── tsconfig.json
```

## データフロー

```text
Operator（シェルループ / curl）
  │  HTTPS POST、SigV4 署名済み
  ▼
Producer Lambda Function URL  (AuthType: AWS_IAM)
  │  sqs.send_message(QueueUrl=..., MessageBody=<リクエストボディまたは自動生成デモペイロード>)
  ▼
SQS メインキュー
  │  イベントソースマッピング — batchSize=5, reportBatchItemFailures=true
  ▼
Consumer Lambda (Python 3.13)
  └── バッチ内の各メッセージについて: table.put_item({id, body, processedAt, ...})
        失敗時: messageId を batchItemFailures で返却し、そのメッセージのみ
        再度可視化される — バッチの残りは再試行されない
  ▼
DynamoDB テーブル  (パーティションキー: id = SQS messageId)

SQS メインキュー ── 3回の受信失敗/未処理後 ──► DLQ（14日間保持）
```

### FIS 注入ポイント

`aws:lambda:put-function-concurrent-executions` は Consumer Lambda 関数の**予約同時実行数**をコントロールプレーン操作として直接設定します（コード変更ではありません）。`ConcurrentExecutions='0'` の場合、すべての呼び出し試行は実行されずに即座に `TooManyRequestsException` で失敗し、SQS 自身の再試行/バックオフ動作により可視性タイムアウト経過後にメッセージが再配信され続けます。`ConcurrentExecutions='1'` の場合、コンシューマーは動作し続けますが、一度に 1 バッチのみを処理するようシリアライズされます。キューと DLQ の設定は変わらないため、再配送の計算式（`visibilityTimeout × maxReceiveCount = 60秒 × 3 = 180秒`）はどのシナリオが実行中でも同じ定数であり、実験の実行時間だけがそのしきい値を超えるかどうかを決定します。

## コンポーネントと設計ポイント

| コンポーネント | 設計ポイント |
| -------------- | ------------ |
| DynamoDB テーブル | PAY_PER_REQUEST で未使用時のコストはゼロ。PITR は実験コスト削減のため無効 |
| SQS メインキュー | `visibilityTimeout=60秒`、`retentionPeriod=4日`、`enforceSSL=true`、`maxReceiveCount=3` でDLQへリダイレクト |
| SQS デッドレターキュー | `retentionPeriod=14日`、`enforceSSL=true` — リダイレブチェーンの終端であり、意図的に自身のDLQを持たない |
| Consumer Lambda | Python 3.13、256 MB、タイムアウト 30 秒。SQS イベントソースは `batchSize=5`、`reportBatchItemFailures=true`（部分バッチ失敗レポート） |
| Producer Lambda | Python 3.13、128 MB、タイムアウト 10 秒。Function URL は `AuthType: AWS_IAM`（非公開） |
| FIS IAM ロール | 最小権限: Consumer Lambda ARN への `lambda:PutFunctionConcurrency` / `lambda:DeleteFunctionConcurrency`、停止条件アラームへの `cloudwatch:DescribeAlarms` |
| CloudWatch 停止アラーム | メインキューの `ApproximateNumberOfMessagesVisible >= 1000` — 3 テンプレートで共有 |
| FIS ログ グループ | `/fis/{project}-{env}-d` — 30 日保持、スタック削除時に自動削除 |

## 実装ハイライト

### 1. Consumer Lambda は部分バッチ失敗レポートを使用

コンシューマーは各 SQS メッセージを独立して処理し、実際に失敗したメッセージのみを報告するため、1 つの不良メッセージがバッチ全体をキューに戻すことはありません:

```python
# lambda/consumer/index.py（抜粋）
def handler(event, context):
    records = event.get("Records", [])
    batch_item_failures = []

    for record in records:
        try:
            process_message(record)
        except Exception as e:
            batch_item_failures.append({"itemIdentifier": record["messageId"]})

    return {"batchItemFailures": batch_item_failures}
```

```typescript
// lib/stacks/app-stack.ts（抜粋）
this.consumerFunction.addEventSource(
    new lambdaEventSources.SqsEventSource(props.queue, {
        batchSize: 5,
        reportBatchItemFailures: true,
    }),
);
```

### 2. DLQ の再配送計算が D-1 と D-2 の検証内容を分ける

```typescript
// lib/stacks/base-stack.ts（抜粋）
this.queue = new sqs.Queue(this, 'MainQueue', {
    visibilityTimeout: cdk.Duration.seconds(60),
    deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
    },
    // ...
});
```

`visibilityTimeout（60秒）× maxReceiveCount（3）= 180秒` が、メッセージが DLQ に到達するまでに循環できる最大時間です。D-1 の 5 分（300 秒）の停止時間は、このしきい値に意図的に近く、かつ超えるよう設定されており、同時実行数が復旧した後の**回復パス**を検証します。一方 D-2 の 20 分（1200 秒）の停止時間は意図的にこのしきい値を大きく上回るよう設定されており、DLQ ルーティングは「確認すべき可能性」ではなく「検証すべき確実な結果」となります。

### 3. FIS アクションは Consumer Lambda の予約同時実行数を直接ターゲットにする

```typescript
// lib/stacks/fis-stack.ts（抜粋 — シナリオ D-2）
targets: {
    ConsumerFunction: {
        resourceType: 'aws:lambda:function',
        resourceArns: [props.consumerFunction.functionArn],
        selectionMode: 'ALL',
    },
},
actions: {
    SetConcurrencyZero: {
        actionId: 'aws:lambda:put-function-concurrent-executions',
        parameters: {
            ConcurrentExecutions: '0',
            duration: 'PT20M',
        },
        targets: { Functions: 'ConsumerFunction' },
    },
},
```

3 つのシナリオ（D-1、D-2、D-3）はすべて同じアクション ID を使用しており、`ConcurrentExecutions`（`'0'` vs. `'1'`）と `duration`（`PT5M` / `PT20M` / `PT10M`）のみが異なります。この統一性は、上記の「なぜ同時実行数操作のみなのか」という設計判断の直接的な帰結です。サポートされていない、あるいは検証されていない FIS アクションに手を伸ばすのではなく、実績のある同一アクションを 3 通りにパラメータ化することで 3 つの異なる運用障害モードをカバーしています。

### 4. Lambda エラーではなくキューバックログを停止条件にする

Architecture B（Lambda エラー数をアラーム対象とする）とは異なり、Architecture D は**キューの滞留量**をアラーム対象とします。D-1 と D-2 の実行中は Consumer Lambda が全く実行されないため、エラーメトリクスを出力できないからです。キューのバックログこそが監視すべき正しいシグナルです:

```typescript
const queueBacklogAlarm = new cw.Alarm(this, 'QueueBacklogAlarm', {
    metric: props.queue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
    }),
    threshold: 1000,
    evaluationPeriods: 1,
    comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cw.TreatMissingData.NOT_BREACHING,
});
```

メッセージのバックログが安全しきい値を超えると、FIS は実験を停止し、Consumer Lambda の予約同時実行数設定が削除されます（予約なし/アカウントプールの同時実行数に戻ります）。アラームは SNS トピックへの通知も送信します（`alarmEmail` パラメータでメール購読可能）。

### 5. Producer Lambda は純粋にデモ負荷を投入するために存在する

```python
# lambda/producer/index.py（抜粋）
def handler(event, context):
    body = event.get("body") or json.dumps({"id": str(uuid.uuid4()), "message": "demo load"})
    result = sqs.send_message(QueueUrl=QUEUE_URL, MessageBody=body)
    return response(202, {"messageId": result["MessageId"]})
```

Function URL は公開エンドポイントではなく `AuthType: AWS_IAM`（SigV4 署名済みリクエストのみ）を使用するため、デモ負荷の生成にも有効な AWS 認証情報が必要です。任意の公開トラフィックを受け付けるべきではないカオスエンジニアリングテストハーネスとして適切な構成です。

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
PROJECT=fis-chaos-d ENV=dev npm run bootstrap
```

### 4. 全スタックのデプロイ

```bash
PROJECT=fis-chaos-d ENV=dev npm run stage:deploy:all
```

依存関係の順序でスタックがデプロイされます:
1. `fis-chaos-d-dev-d-base` — DynamoDB テーブル + SQS メインキュー + DLQ
2. `fis-chaos-d-dev-d-app` — Consumer Lambda（SQS イベントソース）+ Producer Lambda（Function URL）
3. `fis-chaos-d-dev-d-fis` — FIS テンプレート + IAM + アラーム

### 5. デモ負荷の投入

デプロイ後、スタック出力から Producer Function URL を取得し、SigV4 署名済みリクエストを送信します（Function URL は IAM 認証が必要なため、認証情報のない素の `curl` は拒否されます）:

```bash
# 単一のデモメッセージを送信
aws lambda invoke --function-name fis-chaos-d-dev-producer \
  --payload '{"body":"{\"hello\":\"world\"}"}' /tmp/out.json

# または `awscurl`（SigV4 署名対応の curl ラッパー）で Function URL に対してループ実行:
for i in $(seq 1 50); do
  awscurl --service lambda -X POST "<function-url>" -d "{\"n\":$i}"
done
```

### 6. FIS 実験の実行

AWS FIS コンソールで `D-1`、`D-2`、`D-3` のいずれかの実験テンプレートを選択し、**実験の開始** をクリックします。デモ負荷を継続的に投入しながら、CloudWatch で SQS メインキューの `ApproximateNumberOfMessagesVisible`（D-2 の場合は DLQ のメッセージ数も）を観測します。

## テスト

```bash
cd infrastructure
npm ci

# このワークスペースのテストをすべて実行
npm run test --workspace=fis-arch-d-sqs-lambda

# スナップショットテストのみ（3 スタックで 21 ケース）
npm run test:snapshot --workspace=fis-arch-d-sqs-lambda

# CDK Nag コンプライアンスチェック
npm run test:compliance --workspace=fis-arch-d-sqs-lambda

# 意図的な変更後にスナップショットを更新
npm run test:snapshot:update --workspace=fis-arch-d-sqs-lambda
```

### テストカバレッジ

| テストスイート | ファイル | 検証内容 |
| -------------- | -------- | -------- |
| スナップショット | `test/snapshot/snapshot.test.ts` | 全 3 スタックの CFn テンプレートスナップショット、DynamoDB PAY_PER_REQUEST、`maxReceiveCount=3` のリダイレブポリシーと `VisibilityTimeout=60` を持つ SQS キュー 2 つ、Python 3.13 の Lambda 2 つ、`BatchSize=5` と `ReportBatchItemFailures` を持つ SQS イベントソースマッピング、`AWS_IAM` 認証の Function URL、FIS テンプレート 3 つ（全て停止条件と `aws:lambda:put-function-concurrent-executions` を使用）あり |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions パック — 非抑制の警告・エラーがないこと |

## コスト見積もり

全サービスがサーバーレス（従量課金）のため、アイドル時のコストは実質 **ゼロ** です。

| サービス | 課金モデル | 実験中の推定コスト |
| -------- | ---------- | ------------------ |
| DynamoDB | PAY_PER_REQUEST | アイドル時はゼロ。数百件の書き込みで < $0.01 |
| SQS | リクエスト数 | 数千件のデモメッセージで < $0.01 |
| Lambda | 呼び出し数 + 実行時間 | 適度なデモ負荷での 20 分間の実験で < $0.01 |
| CloudWatch | メトリクス + ログ | 月額 ~$0.01 |
| FIS | 無料 | FIS 自体は無料 |
| **合計（実験あたり）** | | **< $0.10** |

## セキュリティ上の考慮事項

- **Consumer 実行ロールは最小権限**: 特定のテーブルに対する `dynamodb:PutItem`（および CDK の `grantWriteData()` がインデックスリソース向けに生成するサブリソースワイルドカード）と、メインキューにスコープされた SQS イベントソースの標準 `sqs:ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes` 権限のみを持ちます。
- **Producer 実行ロールは最小権限**: `queue.grantSendMessages()` により、メインキューへの `sqs:SendMessage` のみが付与されます。
- **Producer Function URL は IAM 認証必須**: `AuthType: AWS_IAM` により、すべてのリクエストは有効な AWS 認証情報で SigV4 署名される必要があります。このパイプラインへの公開・無認証のエントリポイントは存在しません。
- **両方のキューが TLS を強制**: `enforceSSL: true` により、いずれのキューに対しても HTTPS 以外のリクエストは拒否されます。
- **FIS ロールは最小権限**: 特定の Consumer Lambda ARN への `lambda:PutFunctionConcurrency` / `lambda:DeleteFunctionConcurrency`、および停止条件アラームへの `cloudwatch:DescribeAlarms` のみに限定されています。
- **VPC なし**: VPC・パブリックサブネット・セキュリティグループが存在せず、唯一のエントリポイントは IAM 認証済みの Function URL です。
- **停止条件は必須**: 全 FIS テンプレートにキューバックログアラームの停止条件が含まれており、実験の最大影響範囲（無制限なバックログ増加）を制限しています。

## トラブルシューティング

| 症状 | 考えられる原因 | 対処法 |
| ---- | -------------- | ------ |
| `cdk deploy` が `No parameters found for environment` で失敗 | `dev-params.ts` のエクスポートが欠けている | `parameters/index.ts` が `./dev-params` をインポートし、`dev` キーで登録していることを確認 |
| Producer Function URL が 403 を返す | SigV4 署名が欠けている/無効 | `aws lambda invoke`、SDK、または SigV4 署名対応ツール（`awscurl` 等）を使用する — 認証情報のない素の `curl` は仕様上拒否される |
| D-1/D-2 中に DynamoDB にメッセージが現れない | 想定通り — FIS が予約同時実行数を 0 に設定しており、コンシューマーが実行できない | 実験が実行中であることを確認。停止後（D-1）にメッセージが追いつくか、DLQ に到達する（D-2）はず |
| FIS 実験が即座に停止する | 停止条件アラームがすでに `ALARM` 状態 | `aws cloudwatch set-alarm-state --alarm-name ... --state-value OK` でアラームをリセット |
| D-2 実行中も DLQ が空のまま | 20 分間のウィンドウ中にキューに十分なメッセージがなかった | 実験前/実行中に継続的にデモ負荷を投入する |
| Lambda で `Table not found` エラー | BaseStack が未デプロイ | Base → App → FIS の順序でデプロイ |

## クリーンアップ

```bash
PROJECT=fis-chaos-d ENV=dev npm run stage:destroy:all
```

全リソースは `removalPolicy: DESTROY` に設定されているため、DynamoDB テーブル、両方の SQS キュー、両方の Lambda 関数、Function URL、FIS テンプレート、CloudWatch ログ グループが完全に削除されます。

## まとめ

本ワークスペースは、イベント駆動の SQS + Lambda コンシューマーアーキテクチャに対する FIS カオスエンジニアリングを、実際の制約の中で実演します。すなわち FIS には SQS や DynamoDB に API レベルの障害を直接注入するサポートされた方法が存在しません。検証されていない回避策に頼るのではなく、3 つのシナリオすべてが、仕様が確認済みでドキュメント化された 1 つの FIS Lambda アクションを再利用しています:

- **D-1** は、短時間のコンシューマー停止からパイプラインがきれいに回復することを検証します — 同時実行数が復旧すればメッセージが再配信されバックログが解消されます。
- **D-2** は意図的にメッセージを DLQ に誘発し（停止時間が再配送しきい値を大きく上回る）、DLQ ルーティング、アラーム、リプレイ手順が実際に機能することを検証します。
- **D-3** は持続的な部分的キャパシティ損失下での動作を検証します — 完全停止よりも現実的な「劣化しているが停止していない」障害です。

サーバーレスアーキテクチャにより、実験コストは最小限（1 回あたり $0.10 未満）に抑えられ、VPC 管理の手間もなく、イベント駆動コンシューマーの耐障害性シナリオを迅速に反復検証できます。

## 参考資料

- [AWS FIS — サポートされているアクション](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [aws:lambda:put-function-concurrent-executions アクションリファレンス](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-lambda)
- [CDK aws-fis モジュール (L1 コンストラクト)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
- [Amazon SQS デッドレターキュー](https://docs.aws.amazon.com/ja_jp/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [Lambda での Amazon SQS の使用（イベントソースマッピング、バッチアイテム失敗）](https://docs.aws.amazon.com/ja_jp/lambda/latest/dg/with-sqs.html)
- [Lambda 関数 URL](https://docs.aws.amazon.com/ja_jp/lambda/latest/dg/lambda-urls.html)
