# CloudWatch Logs → S3 アーカイブ — 3つのログアーカイブパターン

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

## はじめに

このプロジェクトは、AWS CDKを使用してCloudWatch LogsのログをS3にアーカイブするリファレンス実装です。
3つの異なるアーカイブパターンを5つの独立したCDKスタックとして実装しており、レイテンシ・コスト・運用要件に合わせて最適なアプローチを選択できます。

このアーキテクチャでは、以下の実装を確認することができます。

- **パターンA** — Kinesis Data Firehoseによるリアルタイムストリーミング（スタック1〜3）
- **パターンB** — CloudWatch Logs Export Task API + Lambda + EventBridgeによるスケジュールバッチエクスポート（スタック4）
- **パターンC** — サブスクリプションフィルターでLambdaを起動してS3に直接書き込み（スタック5）

### なぜ3つのパターンが必要なのか？

| 特徴 | パターンA（Firehose） | パターンB（Export Task） | パターンC（Lambda） |
| ---- | -------------------- | ----------------------- | ------------------- |
| 配信レイテンシ | ほぼリアルタイム（秒〜分） | スケジュール（最大12時間遅延） | ほぼリアルタイム |
| 大量データ時のコスト | 中程度（Firehose + S3） | 低（Lambda + S3のみ） | 中程度（Lambda呼び出し回数） |
| 出力フォーマット | CWL生JSONライン、GZIP圧縮 | CWL生フォーマット | カスタムJSON（完全制御可能） |
| 運用のシンプルさ | 高（マネージドFirehose） | 高（マネージドExport API） | 低（Lambdaコードの保守が必要） |
| カスタム変換 | 限定的（Firehoseデータ変換） | なし | Lambda内で完全制御可能 |

## アーキテクチャ概要

### パターンA — Kinesis Data Firehose（スタック1、2、3）

```text
CloudWatch Log Group
  → サブスクリプションフィルター  (CfnSubscriptionFilter、roleArn = CwlToFirehoseRole)
  → Kinesis Data Firehose (GZIP圧縮、日付パーティションプレフィックス)
  → S3 アーカイブバケット
```

3つのスタックはS3ライフサイクルの複雑さと「既存ロググループ」のユースケースを段階的に示しています。

| スタック | 説明 |
| -------- | ---- |
| **Basic**（スタック1） | 新規ロググループ、最小ライフサイクル（マルチパートアップロード中断 + 非現行バージョン失効） |
| **Lifecycle**（スタック2） | Basicに加えてストレージクラス移行: Standard → IA (30日) → Glacier IR (90日) → Deep Archive (365日) → 失効 (7年) |
| **Existing**（スタック3） | 既存ロググループ（名前でインポート）へFirehoseサブスクリプションをアタッチ |

### パターンB — スケジュールエクスポートタスク（スタック4）

```text
EventBridge Rule（スケジュール）
  → Lambda  (前日のログに対して logs:CreateExportTask を呼び出す)
  → CloudWatch Logs Export API
  → S3 アーカイブバケット  (バケットポリシーで logs.amazonaws.com の書き込みを許可)
```

### パターンC — サブスクリプションフィルター → Lambda → S3（スタック5）

```text
CloudWatch Log Group
  → サブスクリプションフィルター  (LambdaDestination、CDKが呼び出し許可を自動管理)
  → Lambda  (gzip+base64のCWLペイロードをデコードしてJSONをS3に書き込む)
  → S3 アーカイブバケット
```

---

## 前提条件

- AWS CLI v2のインストールと設定
- Node.js 20+
- AWS CDK CLI（`npm install -g aws-cdk`）
- TypeScriptの基礎知識
- AWSアカウント
- 対象アカウントのAWS CLIプロファイル設定

## プロジェクトディレクトリ構造

```text
cloudwatch-logs-s3-archive/
├── bin/
│   └── cloudwatch-logs-s3-archive.ts          # アプリケーションエントリーポイント
├── lib/
│   ├── stacks/
│   │   ├── cloudwatch-logs-s3-archive-basic-stack.ts     # スタック1 – パターンA Basic
│   │   ├── cloudwatch-logs-s3-archive-lifecycle-stack.ts # スタック2 – パターンA Lifecycle
│   │   ├── cloudwatch-logs-s3-archive-existing-stack.ts  # スタック3 – パターンA 既存LG
│   │   ├── cloudwatch-logs-s3-archive-export-stack.ts    # スタック4 – パターンB Export Task
│   │   └── cloudwatch-logs-s3-archive-lambda-stack.ts    # スタック5 – パターンC Lambda
│   ├── stages/
│   │   └── cloudwatch-logs-s3-archive-stage.ts           # デプロイオーケストレーション
│   └── types/
│       ├── index.ts                            # 型定義エクスポート
│       ├── firehose-params.ts                  # Firehoseパラメータ型
│       ├── log-group-params.ts                 # ロググループパラメータ型
│       ├── lifecycle-params.ts                 # ライフサイクルパラメータ型
│       ├── export-task-params.ts               # エクスポートタスクパラメータ型
│       └── lambda-archive-params.ts            # Lambdaアーカイブパラメータ型
├── parameters/
│   ├── environments.ts                         # EnvParamsインターフェースとレジストリ
│   ├── dev-params.ts                           # 開発環境パラメータ
│   └── prd-params.ts                           # 本番環境パラメータ
├── src/
│   └── lambda/
│       ├── export-task/
│       │   └── index.py                        # パターンB – CreateExportTaskハンドラー
│       └── cwl-to-s3/
│           └── index.py                        # パターンC – CWLペイロード → S3書き込み
└── test/
    ├── compliance/
    │   └── cdk-nag.test.ts                     # CDK Nag AwsSolutionsコンプライアンステスト
    ├── snapshot/
    │   └── snapshot.test.ts                    # CloudFormationテンプレートスナップショットテスト
    └── unit/
        └── cloudwatch-logs-s3-archive.test.ts  # 細粒度アサーションテスト
```

---

## 実装のポイント

### 1. パターンA — Kinesis Data Firehoseサブスクリプション

CloudWatch LogsはFirehoseへの配信に明示的なIAMロールが必要です。2つのロールを使用します。

- **CwlToFirehoseRole** — `logs.amazonaws.com`が引き受けるロール。`SourceArn`条件でスコープを絞り、特定の配信ストリームに対して`firehose:PutRecord`と`firehose:PutRecordBatch`を許可します。
- **FirehoseRole** — `firehose.amazonaws.com`が引き受けるロール。アーカイブバケットへのS3書き込み権限を付与します。

```typescript
// CWL → Firehose 信頼ポリシーとアクセスポリシー
const cwlToFirehoseRole = new iam.Role(this, 'CwlToFirehoseRole', {
    assumedBy: new iam.ServicePrincipal('logs.amazonaws.com', {
        conditions: {
            ArnLike: { 'aws:SourceArn': this.logGroup.logGroupArn },
        },
    }),
});
cwlToFirehoseRole.addToPolicy(new iam.PolicyStatement({
    actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
    resources: [deliveryStream.deliveryStreamArn],
}));

// サブスクリプションフィルター（roleArnを明示的に指定するためL1を使用）
new logs.CfnSubscriptionFilter(this, 'SubscriptionFilter', {
    logGroupName: this.logGroup.logGroupName,
    destinationArn: deliveryStream.deliveryStreamArn,
    filterPattern: filterPattern,
    roleArn: cwlToFirehoseRole.roleArn,
});
```

> **なぜL2の`SubscriptionFilter`ではなく`CfnSubscriptionFilter`を使うのか？**
> L2コンストラクトは`roleArn`パラメータを公開していません。FirehoseデスティネーションではロールのARNが必須のため、L1リソースを使用する必要があります。

### 2. 階層型S3ライフサイクル（スタック2 – Lifecycle）

長期アーカイブでは、アクセス頻度の低いデータをより安価なストレージクラスに移行することでコストを最適化できます。

```typescript
bucket.addLifecycleRule({
    transitions: [
        { storageClass: s3.StorageClass.INFREQUENT_ACCESS,       transitionAfter: cdk.Duration.days(30)  },
        { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: cdk.Duration.days(90)  },
        { storageClass: s3.StorageClass.DEEP_ARCHIVE,             transitionAfter: cdk.Duration.days(365) },
    ],
    expiration: cdk.Duration.days(2555),  // 7年
    noncurrentVersionTransitions: [
        { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(30) },
    ],
    noncurrentVersionExpiration: cdk.Duration.days(90),
    noncurrentVersionsToRetain: 3,
    abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
});
```

### 3. パターンB — スケジュールエクスポートタスク

CloudWatch Logs Export Task APIはアカウントあたり**同時実行1件**の制限があります。Lambdaは新しいタスクを送信する前に実行中のタスクを確認してエラーを回避します。

```python
# export-task/index.py（主要ロジック）
def lambda_handler(event, context):
    # 既に実行中のタスクがある場合はスキップ
    running = logs.describe_export_tasks(statusCode='RUNNING')
    if running['exportTasks']:
        return {'statusCode': 409, 'body': 'Export task already running'}

    # 前日のログをエクスポート
    now = datetime.utcnow()
    start = int(datetime(now.year, now.month, now.day).timestamp() * 1000) - 86400000
    end   = start + 86399999

    response = logs.create_export_task(
        logGroupName=LOG_GROUP_NAME,
        fromTime=start,
        to=end,
        destination=S3_BUCKET_NAME,
        destinationPrefix=f"{S3_PREFIX}/{now.strftime('%Y/%m/%d')}",
    )
    return {'statusCode': 200, 'taskId': response['taskId']}
```

S3バケットにはCloudWatch LogsサービスによるPutObjectを許可する2つのリソースポリシーが必要です。

```typescript
// 1. エクスポート前にバケットACLの確認を許可
bucket.addToResourcePolicy(new iam.PolicyStatement({
    principals: [new iam.ServicePrincipal('logs.amazonaws.com')],
    actions: ['s3:GetBucketAcl'],
    resources: [bucket.bucketArn],
    conditions: { ArnLike: { 'aws:SourceArn': `arn:${partition}:logs:${region}:${account}:log-group:*` } },
}));

// 2. エクスポートされたオブジェクトの書き込みを許可
bucket.addToResourcePolicy(new iam.PolicyStatement({
    principals: [new iam.ServicePrincipal('logs.amazonaws.com')],
    actions: ['s3:PutObject'],
    resources: [bucket.arnForObjects('*')],
    conditions: {
        StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' },
        ArnLike: { 'aws:SourceArn': `arn:${partition}:logs:${region}:${account}:log-group:*` },
    },
}));
```

### 4. パターンC — サブスクリプションフィルター → Lambda → S3

`LambdaDestination`は`logs.amazonaws.com`がLambdaを呼び出すためのリソースポリシーを自動的に管理するため、`Lambda::Permission`リソースを手動で作成する必要はありません。

```typescript
new logs.SubscriptionFilter(this, 'CwlSubscriptionFilter', {
    logGroup: this.logGroup,
    destination: new logDestinations.LambdaDestination(this.archiveFunction),
    filterPattern: filterPattern
        ? logs.FilterPattern.literal(filterPattern)
        : logs.FilterPattern.allEvents(),
});
```

LambdaはCWLの圧縮ペイロードをデコードし、呼び出しごとにJSONファイルをS3に書き込みます。

```python
# cwl-to-s3/index.py（主要ロジック）
def lambda_handler(event, context):
    compressed = base64.b64decode(event['awslogs']['data'])
    payload    = json.loads(gzip.decompress(compressed))

    key = (
        f"{S3_PREFIX}/"
        f"{datetime.utcnow().strftime('%Y/%m/%d/%H')}/"
        f"{payload['logGroup'].lstrip('/')}/"
        f"{payload['logStream']}/"
        f"{context.aws_request_id}.json"
    )
    s3.put_object(Bucket=S3_BUCKET_NAME, Key=key, Body=json.dumps(payload))
```

---

## 主要コンポーネントと設計ポイント

| コンポーネント | 設計ポイント |
| ------------- | ------------ |
| **S3バケット** | SSE-S3暗号化、バージョニング有効、パブリックアクセスブロック、SSL強制 |
| **CwlToFirehoseRole** | `SourceArn`条件で信頼スコープを特定のロググループに制限 |
| **FirehoseRole** | `bucket/*`に対して`s3:PutObject`を許可（ワイルドカードはFirehoseの動作に必須） |
| **ライフサイクルルール** | マルチパートアップロード中断（7日）と非現行バージョン失効（90日、3件保持）を全スタックに適用 |
| **階層型ライフサイクル** | スタック2はStandard→IA→Glacier IR→Deep Archive→失効の移行ルールを追加 |
| **既存LGインポート** | スタック3は`LogGroup.fromLogGroupName()`を使用（`AWS::Logs::LogGroup`リソースは作成されない） |
| **エクスポートタスク** | Lambda内で同時実行ガードを実装。バケットポリシーでCWLサービスプリンシパルの書き込みを許可 |
| **LambdaDestination** | CDK L2がCWL呼び出し用の`Lambda::Permission`リソースを自動管理 |

---

## デプロイと動作確認

```bash
# ブートストラップ（初回のみ）
npx cdk bootstrap --profile <your-profile>

# 全スタックをデプロイ
npm run stage:deploy:all -w workspaces/cloudwatch-logs-s3-archive -- --project=myproject --env=dev

# 個別スタックのデプロイ
npm run stage:deploy -w workspaces/cloudwatch-logs-s3-archive -- --project=myproject --env=dev --stack=basic
npm run stage:deploy -w workspaces/cloudwatch-logs-s3-archive -- --project=myproject --env=dev --stack=export
npm run stage:deploy -w workspaces/cloudwatch-logs-s3-archive -- --project=myproject --env=dev --stack=lambda
```

### パターンAの動作確認（Firehose）

```bash
# テストログを書き込む
aws logs put-log-events \
  --log-group-name /<project>/<env>/app \
  --log-stream-name test-stream \
  --log-events timestamp=$(date +%s000),message="hello firehose"

# 約60秒後にアーカイブバケットを確認
aws s3 ls s3://<archive-bucket>/ --recursive
```

### パターンBの動作確認（エクスポートタスク）

```bash
# エクスポートLambdaを手動で起動
aws lambda invoke \
  --function-name <project>-<env>-cwl-export-task \
  --payload '{}' response.json
cat response.json
```

### パターンCの動作確認（Lambda）

```bash
# テストログを書き込む（サブスクリプションフィルターが即座にLambdaを起動）
aws logs put-log-events \
  --log-group-name /<project>/<env>/app-lambda \
  --log-stream-name test-stream \
  --log-events timestamp=$(date +%s000),message="hello lambda"

aws s3 ls s3://<archive-bucket>/subscriptions/ --recursive
```

---

## テストの実行

```bash
# ユニットテスト（細粒度CDKアサーション）
npm run test:unit -w cloudwatch-logs-s3-archive

# スナップショットテスト
npm run test:snapshot -w cloudwatch-logs-s3-archive

# CDK Nagコンプライアンス（AwsSolutionsパック）
npm run test:compliance -w cloudwatch-logs-s3-archive
```

---

## ベストプラクティスまとめ

| コンポーネント | 推奨 | 避けるべき |
| ------------- | ---- | ---------- |
| パターンA IAM | 2つの分離したロール（CWL→Firehose、Firehose→S3）と`SourceArn`条件 | 過度に広い信頼を持つ単一ロール |
| パターンA サブスクリプション | L1 `CfnSubscriptionFilter` + 明示的な`roleArn` | L2 `SubscriptionFilter`（FirehoseへのroleArn未サポート） |
| パターンB 同時実行 | Lambda内で実行中タスクを確認してから`CreateExportTask`を呼び出す | 確認なし（`LimitExceededException`のリスク） |
| パターンB バケットポリシー | `aws:SourceArn`をアカウントのロググループにスコープする | 条件なし（任意のCWLプリンシパルが書き込み可能） |
| パターンC デスティネーション | `LambdaDestination`（CDKが呼び出し許可を自動管理） | 手動での`Lambda::Permission`リソース作成 |
| S3セキュリティ | `enforceSSL: true`、`blockPublicAccess: BLOCK_ALL`、`encryption: S3_MANAGED` | デフォルトのバケット設定 |
| ライフサイクル | 全バケットにマルチパートアップロード中断（7日）を設定 | ライフサイクルルールなし（不完全パートが蓄積される） |

---

## コスト試算

<details>
<summary>💰 月額試算（東京リージョン、1日1GBのログデータの場合）</summary>

| サービス | パターン | 月額コスト |
| -------- | -------- | ---------- |
| Kinesis Data Firehose | A | ~$0.03/GB → ~$0.90 |
| Lambda | B、C | 低呼び出し回数では無視できるレベル |
| S3（Standard） | 全て | ~$0.025/GB-月 → ~$0.75 |
| CloudWatch Logs | 全て | ~$0.76/GBインジェスト |
| EventBridge | B | 100万イベントあたり$1.00（最小限） |

パターンAの合計: ログ量1日1GBで月額約2〜3ドル

</details>

---

## まとめ

このパターンから学んだこと：

1. **パターンA（Firehose）**: コードが少なくほぼリアルタイムのアーカイブに最適。2つのIAMロールとL1の`CfnSubscriptionFilter`が必要です。
2. **パターンB（エクスポートタスク）**: バッチユースケースで最もコストが低い。アカウントあたり同時実行1件の制限あり。`logs.amazonaws.com`への書き込みを許可するバケットポリシーが必須です。
3. **パターンC（Lambda）**: カスタム出力フォーマットに最大の柔軟性。`LambdaDestination`で呼び出し許可が簡略化。高スループットロググループではLambdaの同時実行数を適切に管理してください。

---

## 参考資料

- [CloudWatch Logsサブスクリプション](https://docs.aws.amazon.com/ja_jp/AmazonCloudWatch/latest/logs/Subscriptions.html)
- [CloudWatch LogsのS3エクスポート](https://docs.aws.amazon.com/ja_jp/AmazonCloudWatch/latest/logs/S3Export.html)
- [Kinesis Data Firehose デベロッパーガイド](https://docs.aws.amazon.com/ja_jp/firehose/latest/dev/what-is-this-service.html)
- [S3ライフサイクル設定](https://docs.aws.amazon.com/ja_jp/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- [CDK Nag AwsSolutionsルール](https://github.com/cdklabs/cdk-nag/blob/main/RULES.md)
