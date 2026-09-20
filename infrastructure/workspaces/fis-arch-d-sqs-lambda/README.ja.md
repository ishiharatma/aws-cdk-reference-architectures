# FIS カオスエンジニアリング — アーキテクチャ D: SQS + Lambda イベント駆動コンシューマー

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20SQS%20%7C%20Lambda%20%7C%20DynamoDB-orange?style=flat-square)

## はじめに

本プロジェクトは、**SQS + Lambda イベント駆動コンシューマー**アーキテクチャに対する AWS Fault Injection Simulator (FIS) を用いたカオスエンジニアリングのリファレンス実装です。Producer Lambda（Function URL 経由）がデモ用の負荷を受け付けて SQS メインキューへメッセージを送信し、Consumer Lambda が SQS イベントソースマッピング経由でキューを処理して DynamoDB に処理済みレコードを書き込みます。処理に失敗したメッセージは、複数回の受信後にデッドレターキュー (DLQ) へ再配送されます。

3 つの FIS 実験テンプレートは、AWS FIS Lambda拡張を経由した`aws:lambda:function`アクションファミリー——[アーキテクチャB](../fis-arch-b-apigw-lambda)がサーバーレスAPIに対して使用したのと同じメカニズム——でConsumer Lambdaに障害を注入します。

| シナリオ | 注入する障害 | 実行時間 | 検証内容 |
| -------- | ------------ | -------- | -------- |
| **D-1** Consumer 完全停止（短時間） | `invocation-error`、`preventExecution=true`、100% | 5 分 | 可視性タイムアウト（60 秒）内でのメッセージ再配信、障害解除後のバックログ解消 |
| **D-2** Consumer 完全停止（長時間、DLQ誘発） | 同アクション | 20 分 | DLQ ルーティングの確実な発生（20 分 ≫ visibilityTimeout × maxReceiveCount = 180 秒）、DLQ アラームとリプレイ手順 |
| **D-3** スループット崩壊 | `invocation-add-delay`、`startupDelayMilliseconds=20000` | 10 分 | 極端だがゼロではないスループット低下時のキュー滞留・レイテンシ増加パターン |

全実験テンプレートは CloudWatch Alarm の停止条件を共有します。SQS メインキューの可視メッセージ数が 1000 件を超えると実験が自動停止し、無制限なバックログ増加を防ぎます。

> ### ⚠️ `aws:lambda:put-function-concurrent-executions`は存在しない
> 本ワークスペースの以前のバージョンは、Consumer Lambdaの予約同時実行数を`aws:lambda:put-function-concurrent-executions`でゼロにしようとしていました。**このアクションIDは実在しません**——`aws fis list-actions`により、Lambdaを対象とするFISアクションは`aws:lambda:function`ファミリー（`invocation-error`、`invocation-add-delay`、`invocation-http-integration-response`）に限られることが確認できます。CloudFormationはFISテンプレート作成時に`Invalid actionId ... 404`で即座に失敗しました。修正後、実機でエンドツーエンドの検証を実施済みです——[観測結果](#観測結果ap-northeast-1)を参照。

## アーキテクチャ概要

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
Consumer Lambda  (Python 3.13、+ FIS拡張レイヤー)
    │  dynamodb:PutItem
    ▼
DynamoDB テーブル  (PAY_PER_REQUEST, パーティションキー: id)

SQS メインキュー ──（3回の受信失敗/未処理後）──► DLQ（保持期間 14日）

FIS ⇄ 拡張の設定交換:
    S3バケット  <project>-<env>-d-fis-config-<account>  (プレフィックス FisConfigs/)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS 実験テンプレート (FisStack)   対象: aws:lambda:function (Consumer Lambda ARN)

D-1  aws:lambda:invocation-error       preventExecution=true, 100%, PT5M
D-2  aws:lambda:invocation-error       preventExecution=true, 100%, PT20M
D-3  aws:lambda:invocation-add-delay   startupDelayMilliseconds=20000, 100%, PT10M
```

### 設計上のポイント

| 特徴 | 効果 |
| ---- | ---- |
| VPC 不要 | 完全サーバーレス — NAT Gateway・サブネット設計・VPC 時間課金なし |
| `aws:lambda:function`アクション | FISはFIS Lambda拡張を通じて関数呼び出しに障害を注入する。ハンドラーコードは変更されない |
| D-1 と D-2 の時間差設計 | 5 分（キュー再配信の範囲内で回復可能）vs. 20 分（確実に DLQ へメッセージを誘発）。同じ障害を 2 つの被害範囲で検証 |
| D-3 は遅延、ゼロではない | 20秒の起動遅延（ハードエラーではない）により、「遅いが生きている」というより現実的なコンシューマー状態を検証。完全停止テストだけでは見逃す |
| 共有の停止条件 | 1 つの CloudWatch Alarm（SQS バックログ ≥ 1000 可視メッセージ）が 3 つの実験すべてを自動停止 |
| Function URL のプロデューサー | デモ負荷を投入するためだけに API Gateway は不要 — IAM 署名済み POST 1 回で十分 |

## 前提条件

- AWS CLI v2 のインストールと設定
- Node.js 20 以降
- AWS CDK CLI (`npm install -g aws-cdk`)
- TypeScript と Python の基礎知識
- FIS サービスリンクロールが作成済みの AWS アカウント（初回 FIS 利用時に自動作成）

> **VPC・NAT Gateway コストなし**: 本アーキテクチャは完全サーバーレスサービスのみで構成されます。アイドル時の主要コストはゼロです（DynamoDB PAY_PER_REQUEST、SQS/Lambda は従量課金、S3設定バケットはほぼ空）。

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
│       ├── app-stack.ts                   # Consumer Lambda（+ FIS拡張レイヤー）+ Producer Lambda + FIS設定バケット
│       └── fis-stack.ts                   # 3 つの FIS 実験テンプレート + IAM + アラーム
├── parameters/
│   ├── environments.ts                    # 環境パラメータの型定義
│   ├── dev-params.ts                      # 開発環境パラメータ
│   └── index.ts                           # パラメータエクスポート
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts               # cdk-nag AwsSolutions コンプライアンスチェック
│   └── snapshot/
│       └── snapshot.test.ts              # CDK スナップショットテスト
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
Consumer Lambda (Python 3.13)   ── AWS FIS Lambda拡張が呼び出しをインターセプト ──►
  └── バッチ内の各メッセージについて: table.put_item({id, body, processedAt, ...})
        失敗時: messageId を batchItemFailures で返却し、そのメッセージのみ
        再度可視化される — バッチの残りは再試行されない
  ▼
DynamoDB テーブル  (パーティションキー: id = SQS messageId)

SQS メインキュー ── 3回の受信失敗/未処理後 ──► DLQ（14日間保持）
```

### FIS 注入ポイント

`aws:lambda:function`アクションは、Consumer Lambdaにレイヤーとしてアタッチされた**AWS FIS Lambda拡張**を通じて障害を注入します。実験が開始されると、FISはアクティブな障害設定をS3プレフィックスに書き込み、拡張がそれをポーリングして呼び出しの前後で障害を適用します——ハンドラーコード自体は一切変更されません。

- **D-1 / D-2**（`invocation-error`、`preventExecution=true`）: すべての呼び出しがハンドラー実行*前*に失敗します。SQS自身の再試行/バックオフ動作により、可視性タイムアウト経過後にメッセージが再配信され続けます——予約同時実行数をゼロにすることで当初得ようとしていた「コンシューマーが全く動かない」効果と機能的に同じことを、実在するアクションを通じて実現しています。
- **D-3**（`invocation-add-delay`、`startupDelayMilliseconds=20000`）: ハンドラーは実行され、書き込みもコミットされますが、すべての呼び出しが20秒遅くなります——関数の30秒タイムアウトには十分収まり、バッチの実際のDynamoDB書き込みには約10秒残ります。

拡張はプッシュ型ではなくポーリング型であるため、すべての呼び出しに障害が反映されるまで最大約60秒のランプアップ、アクション終了後は約20秒のランプダウンを見込んでください——アーキテクチャBで文書化されているのと同じ挙動です。

## コンポーネントと設計ポイント

| コンポーネント | 設計ポイント |
| -------------- | ------------ |
| DynamoDB テーブル | PAY_PER_REQUEST で未使用時のコストはゼロ。PITR は実験コスト削減のため無効 |
| SQS メインキュー | `visibilityTimeout=60秒`、`retentionPeriod=4日`、`enforceSSL=true`、`maxReceiveCount=3` でDLQへリダイレクト |
| SQS デッドレターキュー | `retentionPeriod=14日`、`enforceSSL=true` — リダイレブチェーンの終端であり、意図的に自身のDLQを持たない |
| Consumer Lambda | Python 3.13、256 MB、タイムアウト 30 秒。FIS拡張レイヤー + `AWS_LAMBDA_EXEC_WRAPPER=/opt/aws-fis/bootstrap`、`AWS_FIS_CONFIGURATION_LOCATION=arn:aws:s3:::<bucket>/FisConfigs/`、`AWS_FIS_POLL_MAX_WAIT_MILLISECONDS=2000`を保持。SQS イベントソースは `batchSize=5`、`reportBatchItemFailures=true` |
| Producer Lambda | Python 3.13、128 MB、タイムアウト 10 秒。Function URL は `AuthType: AWS_IAM`（非公開）。FIS拡張なし（障害対象になることはない） |
| FIS設定バケット | `<project>-<env>-d-fis-config-<account>` — S3マネージド暗号化、パブリックアクセス完全ブロック、1日でライフサイクル失効 |
| FIS IAM ロール | `<bucket>/FisConfigs/*`への`s3:PutObject`/`s3:DeleteObject`、`*`への`lambda:GetFunction`と`tag:GetResources`、停止条件アラームへの `cloudwatch:DescribeAlarms` |
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

`visibilityTimeout（60秒）× maxReceiveCount（3）= 180秒` が、メッセージが DLQ に到達するまでに循環できる最大時間です。D-1 の 5 分（300 秒）の停止時間は、このしきい値に意図的に近く、かつ超えるよう設定されており、障害が解除された後の**回復パス**を検証します。一方 D-2 の 20 分（1200 秒）の停止時間は意図的にこのしきい値を大きく上回るよう設定されており、DLQ ルーティングは「確認すべき可能性」ではなく「検証すべき確実な結果」となります。

### 3. FIS Lambda拡張は必須の前提条件

`aws:lambda:function`アクションは素のLambda関数には効きません。1回限りのセットアップ（すべて`app-stack.ts`内）はアーキテクチャBを踏襲しています:

```typescript
const fisExtensionLayerArn = ssm.StringParameter.valueForStringParameter(
    this, FIS_EXTENSION_LAYER_SSM_PARAM,
);

this.consumerFunction = new lambda.Function(this, 'ConsumerFunction', {
    // ...
    layers: [lambda.LayerVersion.fromLayerVersionArn(this, 'FisExtensionLayer', fisExtensionLayerArn)],
    environment: {
        TABLE_NAME: props.table.tableName,
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/aws-fis/bootstrap',
        AWS_FIS_CONFIGURATION_LOCATION: `arn:aws:s3:::${this.fisConfigBucket.bucketName}/FisConfigs/`,
        AWS_FIS_POLL_MAX_WAIT_MILLISECONDS: '2000',
    },
});
```

```typescript
// lib/stacks/fis-stack.ts（抜粋 — シナリオ D-1）
targets: {
    ConsumerFunction: {
        resourceType: 'aws:lambda:function',
        resourceArns: [props.consumerFunction.functionArn],
        selectionMode: 'ALL',
    },
},
actions: {
    InjectConsumerOutage: {
        actionId: 'aws:lambda:invocation-error',
        parameters: { duration: 'PT5M', invocationPercentage: '100', preventExecution: 'true' },
        targets: { Functions: 'ConsumerFunction' },
    },
},
```

D-1とD-2は同一のアクションとパラメータを使用し、`duration`のみが異なります。D-3は`invocation-add-delay`に`startupDelayMilliseconds`を指定して切り替えます。

### 4. Lambda エラーではなくキューバックログを停止条件にする

Architecture B（Lambda エラー数をアラーム対象とする）とは異なり、Architecture D は**キューの滞留量**をアラーム対象とします。D-1 と D-2 の実行中はConsumer Lambdaの呼び出しが何も処理せずに失敗するため、キューのバックログこそが運用上意味のあるシグナルです:

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

メッセージのバックログが安全しきい値を超えると、FIS は実験を停止し、拡張の障害はランプダウンウィンドウ内で解除されます。アラームは SNS トピックへの通知も送信します（`alarmEmail` パラメータでメール購読可能）。

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
PROJECT=<project> ENV=dev npm run bootstrap -w workspaces/fis-arch-d-sqs-lambda
```

### 4. 全スタックのデプロイ

```bash
PROJECT=<project> ENV=dev npm run stage:deploy:all -w workspaces/fis-arch-d-sqs-lambda -- --require-approval never
```

依存関係の順序でスタックがデプロイされます:
1. `<project>-dev-d-base` — DynamoDB テーブル + SQS メインキュー + DLQ
2. `<project>-dev-d-app` — Consumer Lambda（+ FIS拡張レイヤー）+ Producer Lambda + FIS設定バケット
3. `<project>-dev-d-fis` — FIS テンプレート + IAM + アラーム

### 5. デモ負荷の投入

デプロイ後、スタック出力から Producer 関数名を取得し、直接Invoke（SigV4署名不要でもっとも簡単）するか、Function URLへSigV4署名済みリクエストを送信します:

```bash
# 直接Lambda invokeで単一のデモメッセージを送信
aws lambda invoke --function-name <project>-dev-producer \
  --cli-binary-format raw-in-base64-out \
  --payload '{"requestContext":{"http":{"method":"POST"}},"body":"{\"hello\":\"world\"}"}' /tmp/out.json

# または `awscurl`（SigV4 署名対応の curl ラッパー）で Function URL に対してループ実行:
for i in $(seq 1 50); do
  awscurl --service lambda -X POST "<function-url>" -d "{\"n\":$i}"
done
```

### 6. FIS 実験の実行

AWS FIS コンソールで `D-1`、`D-2`、`D-3` のいずれかの実験テンプレートを選択し、**実験の開始** をクリックします。デモ負荷を継続的に投入しながら、CloudWatch で SQS メインキューの `ApproximateNumberOfMessagesVisible`（D-2 の場合は DLQ のメッセージ数も）を観測します。

### 観測結果（ap-northeast-1）

| シナリオ | 結果 |
| -------- | ---- |
| **D-1** | 実験開始から約90秒後、FIS拡張のログに`found active faults`が出現。以降のconsumer呼び出しはハンドラーを実行せずに返る（`modifying the function response`）。`ApproximateNumberOfMessagesNotVisible`は実験時間中1で推移——「受信失敗→可視性タイムアウト→再配信」のサイクル。障害解除後（`no active faults found`、`persisting environment reset save file`）、バックログはクリーンに解消 |
| **D-2** | 20分間待たずに確認: D-1から引き続き再配信中だったメッセージが、D-2開始から数秒以内に3回目の受信失敗を迎え、DLQが即座に埋まった。DLQへの`receive-message`で`ApproximateReceiveCount: 4`（`maxReceiveCount=3`を1回超過）を確認、リドライブポリシーの仕様通り |
| **D-3** | 今回の検証では実機での再実行はしていない——基盤メカニズム（`invocation-add-delay`）はアーキテクチャBのB-2シナリオで既にエンドツーエンドで検証済みのものと同一 |

## テスト

```bash
cd infrastructure
npm ci

# このワークスペースのテストをすべて実行
npm run test --workspace=fis-arch-d-sqs-lambda

# スナップショットテストのみ
npm run test:snapshot --workspace=fis-arch-d-sqs-lambda

# CDK Nag コンプライアンスチェック
npm run test:compliance --workspace=fis-arch-d-sqs-lambda

# 意図的な変更後にスナップショットを更新
npm run test:snapshot:update --workspace=fis-arch-d-sqs-lambda
```

### テストカバレッジ

| テストスイート | ファイル | 検証内容 |
| -------------- | -------- | -------- |
| スナップショット | `test/snapshot/snapshot.test.ts` | 全 3 スタックの CFn テンプレートスナップショット、DynamoDB PAY_PER_REQUEST、`maxReceiveCount=3` のリダイレブポリシーと `VisibilityTimeout=60` を持つ SQS キュー 2 つ、Python 3.13 の Lambda、`BatchSize=5` と `ReportBatchItemFailures` を持つ SQS イベントソースマッピング、`AWS_IAM` 認証の Function URL、FIS テンプレート 3 つ（全て停止条件と実在する`aws:lambda:function`アクションを使用）あり |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions パック — 非抑制の警告・エラーがないこと |

## コスト見積もり

全サービスがサーバーレス（従量課金）のため、アイドル時のコストは実質 **ゼロ** です。

| サービス | 課金モデル | 実験中の推定コスト |
| -------- | ---------- | ------------------ |
| DynamoDB | PAY_PER_REQUEST | アイドル時はゼロ。数百件の書き込みで < $0.01 |
| SQS | リクエスト数 | 数千件のデモメッセージで < $0.01 |
| Lambda | 呼び出し数 + 実行時間 | 適度なデモ負荷での 20 分間の実験で < $0.01 |
| S3 FIS設定バケット | ほぼ空、1日で失効 | < $0.01 |
| CloudWatch | メトリクス + ログ | 月額 ~$0.01 |
| **FIS** | **アクション分単価 $0.10** | 20分間のD-2単体で約$2、3シナリオのフルサイクルで数ドル |
| **合計（1回のフルテストサイクル）** | | **約$2〜3、主にFISのアクション分単価による** |

**以前のドキュメントからの修正:** FISは**無料ではありません**——本シリーズの他のFISベースワークスペースと同様、アクション分単価$0.10で課金されます。

## セキュリティ上の考慮事項

- **Consumer 実行ロールは最小権限**: 特定のテーブルに対する `dynamodb:PutItem`（および CDK の `grantWriteData()` がインデックスリソース向けに生成するサブリソースワイルドカード）、メインキューにスコープされた SQS イベントソースの標準権限、設定バケットの`FisConfigs/`プレフィックスにスコープされた`s3:ListBucket`/`s3:GetObject`（拡張用）。
- **Producer 実行ロールは最小権限**: `queue.grantSendMessages()` により、メインキューへの `sqs:SendMessage` のみが付与されます。
- **Producer Function URL は IAM 認証必須**: `AuthType: AWS_IAM` により、すべてのリクエストは有効な AWS 認証情報で SigV4 署名される必要があります。このパイプラインへの公開・無認証のエントリポイントは存在しません。
- **両方のキューが TLS を強制**: `enforceSSL: true` により、いずれのキューに対しても HTTPS 以外のリクエストは拒否されます。
- **FIS設定バケット**: パブリックアクセス完全ブロック、S3マネージド暗号化、TLS強制、1日でオブジェクトが失効するため古い障害設定が残らない。
- **FIS ロールは最小権限**: `<bucket>/FisConfigs/*`への`s3:PutObject`/`s3:DeleteObject`、`lambda:GetFunction`と`tag:GetResources`（ターゲット解決）、停止条件アラームへの `cloudwatch:DescribeAlarms` のみに限定。DynamoDBやSQSへのアクセスはなし。
- **VPC なし**: VPC・パブリックサブネット・セキュリティグループが存在せず、唯一のエントリポイントは IAM 認証済みの Function URL です。
- **停止条件は必須**: 全 FIS テンプレートにキューバックログアラームの停止条件が含まれており、実験の最大影響範囲（無制限なバックログ増加）を制限しています。

## トラブルシューティング

| 症状 | 考えられる原因 | 対処法 |
| ---- | -------------- | ------ |
| `cdk deploy` が `No parameters found for environment` で失敗 | `dev-params.ts` のエクスポートが欠けている | `parameters/index.ts` が `./dev-params` をインポートし、`dev` キーで登録していることを確認 |
| FISテンプレート作成が`Invalid actionId ... 404`で失敗 | リージョンに存在しないアクションID | `aws fis list-actions`を確認——Lambda対象アクションは`aws:lambda:function`ファミリーに限られる |
| Producer Function URL が 403 を返す | SigV4 署名が欠けている/無効 | `aws lambda invoke`、SDK、または SigV4 署名対応ツール（`awscurl` 等）を使用する — 認証情報のない素の `curl` は仕様上拒否される |
| D-1/D-2でエラーが現れるまで約1分かかる | 想定通り——FIS Lambda拡張のスローポーリングによるランプアップ | 約60秒待つ。CloudWatch Logsで`AWS FIS EXTENSION - found active faults`を確認し障害が実際に有効か確認する |
| FIS 実験が即座に停止する | 停止条件アラームがすでに `ALARM` 状態 | `aws cloudwatch set-alarm-state --alarm-name ... --state-value OK` でアラームをリセット |
| D-2 実行中も DLQ が空のまま | 20 分間のウィンドウ中にキューに十分なメッセージがなかった | 実験前/実行中に継続的にデモ負荷を投入する |
| Lambda で `Table not found` エラー | BaseStack が未デプロイ | Base → App → FIS の順序でデプロイ |

## クリーンアップ

```bash
PROJECT=<project> ENV=dev npm run stage:destroy:all -w workspaces/fis-arch-d-sqs-lambda -- --force
```

全リソースは `removalPolicy: DESTROY`（S3設定バケットは`autoDeleteObjects`も）に設定されているため、DynamoDB テーブル、両方の SQS キュー、両方の Lambda 関数、Function URL、FIS設定バケット、FIS テンプレート、CloudWatch ログ グループが完全に削除されます。

## まとめ

本ワークスペースは、イベント駆動の SQS + Lambda コンシューマーアーキテクチャに対する FIS カオスエンジニアリングを、実際の制約の中で実演します。すなわちFISにはSQSやDynamoDBに対するネイティブアクションが存在せず——実機検証で判明した通り——Lambdaの予約同時実行数を設定するアクションも存在しません。3つのシナリオすべてが、アーキテクチャBと同じ実績のあるメカニズムである`aws:lambda:function`アクションファミリーをFIS Lambda拡張経由で使用します:

- **D-1** は、短時間のコンシューマー停止からパイプラインがきれいに回復することを検証します — 障害が解除されればメッセージが再配信されバックログが解消されます。
- **D-2** は意図的にメッセージを DLQ に誘発し（停止時間が再配送しきい値を大きく上回る）、DLQ ルーティング、アラーム、リプレイ手順が実際に機能することを検証します。
- **D-3** は持続的な部分的キャパシティ損失下での動作を検証します — 完全停止よりも現実的な「劣化しているが停止していない」障害です。

サーバーレスアーキテクチャにより、実験コストは低く抑えられ（フルテストサイクルあたり数ドル、主にFISのアクション分単価による）、VPC 管理の手間もなく、イベント駆動コンシューマーの耐障害性シナリオを迅速に反復検証できます。

## 参考資料

- [AWS FIS — サポートされているアクション](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [AWS FISの`aws:lambda:function`アクションを使用する](https://docs.aws.amazon.com/fis/latest/userguide/use-lambda-actions.html)
- [CDK aws-fis モジュール (L1 コンストラクト)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
- [Amazon SQS デッドレターキュー](https://docs.aws.amazon.com/ja_jp/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [Lambda での Amazon SQS の使用（イベントソースマッピング、バッチアイテム失敗）](https://docs.aws.amazon.com/ja_jp/lambda/latest/dg/with-sqs.html)
- [Lambda 関数 URL](https://docs.aws.amazon.com/ja_jp/lambda/latest/dg/lambda-urls.html)
