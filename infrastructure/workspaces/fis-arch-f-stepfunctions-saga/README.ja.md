# FIS カオスエンジニアリング — アーキテクチャ F: Step Functions Saga（注文処理）+ Lambda + DynamoDB

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20Step%20Functions%20%7C%20Lambda%20%7C%20DynamoDB-orange?style=flat-square)

## はじめに

本プロジェクトは、**Step Functions Saga パターン**に対する AWS Fault Injection Simulator (FIS) を用いたカオスエンジニアリングのリファレンス実装です。Saga パターンは、2フェーズコミットを使わずに、在庫確保・決済・注文確定という独立した3つのステップにまたがる EC 注文処理の整合性を保つための分散トランザクション手法です。AWS Step Functions の Standard ステートマシンが3つの正方向ステップを実行し、失敗時には対応する補償トランザクションを実行してから実行を終了します。

| 正方向ステップ | Lambda | 補償対象 |
| -------------- | ------ | -------- |
| 1. 在庫予約 | `ReserveInventory` | なし（まだ何もコミットされていない） |
| 2. 決済処理 | `ProcessPayment` | `ReleaseInventory` が補償 |
| 3. 注文確定（最終） | `ConfirmOrder` | `RefundPayment` → `ReleaseInventory`（この順序）が補償 |

3つの FIS 実験テンプレートが、正方向ステップの Lambda を1つずつ完全に停止させることで、実際の本番障害と同じ形で Saga の Retry / Catch / 補償ロジックを検証します。

| シナリオ | 注入する障害 | 実行時間 | 検証内容 |
| -------- | ------------ | -------- | -------- |
| **F-1** ProcessPayment 停止 | `ProcessPayment`に`invocation-error`、`preventExecution=true`、100% | 5 分 | リトライが尽きた後、`ReleaseInventory` 補償トランザクションが実行されること |
| **F-2** ReserveInventory 停止 | `ReserveInventory`に同アクション | 5 分 | フェイルファストパス — Saga の最初のステップで失敗するため補償は実行されない |
| **F-3** ConfirmOrder 停止 | `ConfirmOrder`に同アクション | 5 分 | 決済済み後の2段階補償（`RefundPayment` → `ReleaseInventory`）が正しい順序で実行されること |

3つの実験テンプレートはすべて、ステートマシンの `ExecutionsFailed` メトリクスに対する CloudWatch Alarm の停止条件を共有し、失敗した Saga 実行数が安全閾値を超えた場合の安全網として機能します。

> ### ⚠️ `aws:lambda:put-function-concurrent-executions`は存在しない
> 本ワークスペースの以前のバージョンは、各正方向Lambdaの予約同時実行数を`aws:lambda:put-function-concurrent-executions`でゼロにしようとしていました。**このアクションIDは実在しません**——`aws fis list-actions`により、Lambdaを対象とするFISアクションは`aws:lambda:function`ファミリーに限られることが確認できます。CloudFormationはFISテンプレート作成時に`Invalid actionId ... 404`で即座に失敗しました。これは[`fis-arch-d-sqs-lambda`](../fis-arch-d-sqs-lambda/)の当初設計と独立に発生した同じ間違いです——同じ直感的だが誤ったアクション名に、無関係な2つのアーキテクチャで引っかかりました。

## Step Functions を直接ターゲットにせず Lambda 拡張を使う理由

これは本ワークスペースの中心的な設計判断であるため、明記しておきます。

**AWS FIS には AWS Step Functions をターゲットにするアクションが存在しません。** 本稿執筆時点で [FIS アクションリファレンス](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html) には `aws:states:*` という名前空間は存在せず、FIS に対して特定のステートを失敗させたり、実行に遅延を注入したり、ステートマシンをリソースとして操作させたりする方法はありません。「Saga をカオステストする」という最も素直な発想を最初から封じます。

代わりに、本ワークスペースは（[`fis-arch-b-apigw-lambda`](../fis-arch-b-apigw-lambda/)と[`fis-arch-d-sqs-lambda`](../fis-arch-d-sqs-lambda/)で実績のある同じメカニズムである）AWS FIS Lambda拡張を、**正方向**の3つのLambda（`ReserveInventory`、`ProcessPayment`、`ConfirmOrder`）のみにレイヤーとしてアタッチします（補償用の2つのLambdaは一切FISの対象になりません）。そしてFISは`aws:lambda:invocation-error`を`preventExecution=true`、100%で注入します——対象関数へのすべての呼び出しが、ハンドラーコードの実行前に即座に失敗します。`tasks.LambdaInvoke` ステートの内側から見れば、これは Lambda が完全にダウンしている状態と区別がつきません。したがって、3つの正方向 Lambda を個別にターゲットにすることで、**ステートマシンの定義そのものには一切手を加えず**に、Saga が証明すべき3つの障害ポイントを間接的に、しかし忠実かつ検証可能な形で駆動できます。実験が検証するのは、実際にデプロイされた ASL 定義そのものであり、その代替物ではありません。

## アーキテクチャ概要

```
Step Functions Standard ステートマシン — "order-saga"  (Logs: ALL · X-Ray トレーシング)

  ReserveInventory ──成功──► ProcessPayment ──成功──► ConfirmOrder ──成功──► Succeed
  (Retry x2, 2s,x2)          (Retry x2, 2s,x2)        (Retry x2, 2s,x2)
        │ Catch                     │ Catch                  │ Catch
        ▼                           ▼                        ▼
      Fail                  ReleaseInventory           RefundPayment
  (補償不要                        │                        │
   — 何も予約されていない)          ▼                        ▼
                                  Fail                ReleaseInventory
                          (在庫解放済み)                     │
                                                              ▼
                                                            Fail
                                                (決済返金済み + 在庫解放済み)

5 つの Lambda（Python 3.13）はすべて1つの DynamoDB テーブルに書き込む:
  DynamoDB "Orders" テーブル (PK: orderId, PAY_PER_REQUEST) — 各 Lambda が注文アイテムの `status` フィールドを更新

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS 実験テンプレート (FisStack) — Step Functions ではなく正方向 Lambda をターゲット

F-1  aws:lambda:invocation-error ─► ProcessPayment Lambda
     preventExecution=true、100%、5分

F-2  aws:lambda:invocation-error ─► ReserveInventory Lambda
     preventExecution=true、100%、5分

F-3  aws:lambda:invocation-error ─► ConfirmOrder Lambda
     preventExecution=true、100%、5分

共有の停止条件: CloudWatch Alarm — StateMachine ExecutionsFailed >= 5 / 1分
```

![アーキテクチャ概要](overview.drawio.svg)

### 設計上のポイント

| 特徴 | 効果 |
| ---- | ---- |
| VPC 不要 | 完全サーバーレス — Step Functions、Lambda、DynamoDB のみ |
| 正方向 Lambda をターゲット、ステートマシンは不変 | テスト対象の ASL 定義には一切手を加えない・モックしない — FIS は実際にデプロイされた Saga を検証する |
| 3つの異なる障害ポイント (F-1/F-2/F-3) | それぞれが Saga の構造的に異なる分岐を検証: 補償なし、単一補償、2段階補償 |
| 全正方向タスクに Retry を Catch より先に設定 | 一過性の障害は Saga が諦めて補償する前に自己修復する（2回試行、2秒→4秒バックオフ）— 実際の本番 Saga 設計と同じ |
| 共有の停止条件 | 1 つの CloudWatch Alarm (`ExecutionsFailed` ≥ 5/分) が 3 つの実験すべてを自動停止 |
| Standard ワークフロー + Logs ALL + X-Ray | どの Catch 分岐が発火したかを含む全ステート遷移を、実験後に CloudWatch Logs と X-Ray トレースマップで検証可能 |

## 前提条件

- AWS CLI v2 のインストールと設定
- Node.js 20 以降
- AWS CDK CLI (`npm install -g aws-cdk`)
- TypeScript と Python の基礎知識
- FIS サービスリンクロールが作成済みの AWS アカウント（初回 FIS 利用時に自動作成）

> **VPC・NAT Gateway コストなし**: 本アーキテクチャは完全サーバーレスサービスのみを使用します。アイドル時の主要コストはゼロです（DynamoDB PAY_PER_REQUEST、Lambda 呼び出し課金、Step Functions のステート遷移課金）。

## プロジェクトのディレクトリ構成

```text
fis-arch-f-stepfunctions-saga/
├── bin/
│   └── fis-arch-f-stepfunctions-saga.ts   # アプリエントリポイント（Stage のインスタンス化）
├── lambda/
│   ├── reserve-inventory/index.py          # Saga 正方向ステップ 1
│   ├── process-payment/index.py            # Saga 正方向ステップ 2
│   ├── confirm-order/index.py              # Saga 正方向ステップ 3（最終）
│   ├── release-inventory/index.py          # ProcessPayment / ConfirmOrder 失敗時の補償
│   └── refund-payment/index.py             # ConfirmOrder 失敗時の補償
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts              # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                   # DynamoDB 注文テーブル
│       ├── app-stack.ts                    # 5 Lambda + Step Functions Saga ステートマシン
│       └── fis-stack.ts                    # 3 つの FIS 実験テンプレート + IAM + アラーム
├── parameters/
│   ├── environments.ts                     # 環境パラメータの型定義
│   ├── dev-params.ts                       # 開発環境パラメータ
│   └── index.ts                            # パラメータエクスポート
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts                # cdk-nag AwsSolutions コンプライアンスチェック
│   └── snapshot/
│       └── snapshot.test.ts               # CDK スナップショットテスト（13 ケース）
├── overview.drawio.svg                    # アーキテクチャ + ステート遷移図
├── cdk.json
├── package.json
└── tsconfig.json
```

## ステート遷移図（詳細）

```text
                              ┌─────────────────────┐
                     開始 ──►│  ReserveInventory     │  Retry: 2回 / 2秒 / x2 バックオフ
                              └──────────┬───────────┘
                        成功 ◄───────────┼────────► Catch (リトライ枯渇)
                              │                              │
                              ▼                              ▼
                  ┌─────────────────────┐          ┌───────────────────────┐
                  │   ProcessPayment    │          │ Fail: ReserveInventory   │
                  │  Retry: 2回/2秒/x2   │          │ Failed（補償不要           │
                  └──────────┬──────────┘          │  — 何も予約されていない）  │
                成功 ◄───────┼───► Catch            └───────────────────────┘
                     │                 │
                     ▼                 ▼
        ┌─────────────────────┐  ┌─────────────────────┐
        │    ConfirmOrder     │  │  ReleaseInventory     │  補償
        │  Retry: 2回/2秒/x2   │  │      （補償）           │
        └──────────┬──────────┘  └──────────┬────────────┘
      成功 ◄────────┼──► Catch               ▼
           │                    │  ┌───────────────────────┐
           ▼                    │  │  Fail: ProcessPayment    │
   ┌───────────────┐            │  │  Failed（在庫解放済み）    │
   │    Succeed    │            │  └───────────────────────┘
   │ OrderConfirmed│            ▼
   └───────────────┘  ┌─────────────────────┐
                       │    RefundPayment      │  補償 1/2
                       └──────────┬────────────┘
                                  ▼
                       ┌─────────────────────┐
                       │   ReleaseInventory     │  補償 2/2
                       └──────────┬────────────┘
                                  ▼
                       ┌───────────────────────┐
                       │  Fail: ConfirmOrder      │
                       │  Failed（決済返金済み       │
                       │  + 在庫解放済み）            │
                       └───────────────────────┘
```

## コンポーネントと設計ポイント

| コンポーネント | 設計ポイント |
| -------------- | ------------ |
| DynamoDB テーブル | PAY_PER_REQUEST で未使用時のコストはゼロ。PITR は実験コスト削減のため無効。PK は `orderId` |
| 5 つの Lambda 関数 | Python 3.13、128 MB、タイムアウト 10 秒 — いずれも注文アイテムの `status` フィールドのみを更新するモック実装 |
| Step Functions ステートマシン | `STANDARD` タイプ（Saga には実行履歴と厳密な一意性が重要）、`logs: sfn.LogLevel.ALL` で CloudWatch Logs へ記録、`tracingEnabled: true` で X-Ray 有効化 |
| リトライポリシー | 全正方向タスクに `IntervalSeconds=2, MaxAttempts=2, BackoffRate=2` — 一過性障害は Catch が発火する前の 6 秒以内に自己解決する |
| Catch / 補償チェーン | `ReserveInventory` → Fail（補償なし）、`ProcessPayment` → `ReleaseInventory` → Fail、`ConfirmOrder` → `RefundPayment` → `ReleaseInventory` → Fail |
| FIS拡張レイヤー | 正方向3つのLambdaのみにアタッチ。パブリックSSMパラメータ`/aws/service/fis/lambda-extension/AWS-FIS-extension-x86_64/1.x.x`からリージョンごとに解決 |
| FIS設定バケット | `<project>-<env>-f-fis-config-<account>` — S3マネージド暗号化、パブリックアクセス完全ブロック、1日でライフサイクル失効 |
| FIS IAM ロール | `<bucket>/FisConfigs/*`への`s3:PutObject`/`s3:DeleteObject`、`*`への`lambda:GetFunction`と`tag:GetResources`、停止条件アラームに `cloudwatch:DescribeAlarms` |
| CloudWatch 停止アラーム | `StateMachine.metricFailed() >= 5` / 1 分 — 3 テンプレートで共有 |
| FIS ログ グループ | `/fis/{project}-{env}-f` — 30 日保持、スタック削除時に自動削除 |

## 実装ハイライト

### 1. 全正方向タスクに Retry、その後に Catch

すべての正方向 `tasks.LambdaInvoke` ステートには、Catch 分岐が検討される前に同じリトライポリシーが設定されます:

```typescript
// lib/stacks/app-stack.ts（抜粋）
const retryProps: sfn.RetryProps = {
    errors: [sfn.Errors.ALL],
    interval: cdk.Duration.seconds(2),
    maxAttempts: 2,
    backoffRate: 2,
};

const processPayment = new tasks.LambdaInvoke(this, 'ProcessPayment', {
    lambdaFunction: this.processPaymentFn,
    payloadResponseOnly: true,
});
processPayment.addRetry(retryProps);
processPayment.addCatch(releaseInventoryAfterPaymentFailure, {
    errors: [sfn.Errors.ALL],
    resultPath: '$.error',
});
processPayment.next(confirmOrder);
```

FIS Lambda拡張が`ProcessPayment`に`invocation-error`を注入している間（FISシナリオF-1）、すべての試行はハンドラーを実行せずに即座に失敗します。2 回の試行と約 6 秒後、リトライが尽きて Catch が下の補償チェーンへ実行を遷移させます。

### 2. 逆順に配線された 2 段階補償

`ConfirmOrder` は最後の正方向ステップです — このステップが失敗する時点では、在庫と決済の両方がすでにコミットされています。その Catch 分岐は、適用された順序の逆順で両方を取り消す必要があります:

```typescript
// lib/stacks/app-stack.ts（抜粋）
const releaseInventoryAfterConfirmFailure = new tasks.LambdaInvoke(
    this, 'ReleaseInventoryCompensation2', { lambdaFunction: this.releaseInventoryFn, payloadResponseOnly: true },
).next(orderFailedAfterFullCompensation);

const refundPaymentAfterConfirmFailure = new tasks.LambdaInvoke(
    this, 'RefundPaymentCompensation1', { lambdaFunction: this.refundPaymentFn, payloadResponseOnly: true },
).next(releaseInventoryAfterConfirmFailure);

confirmOrder.addCatch(refundPaymentAfterConfirmFailure, {
    errors: [sfn.Errors.ALL],
    resultPath: '$.error',
});
```

それぞれの補償 `LambdaInvoke` が独立したステートであるため、実験（F-3）後の CloudWatch Logs / X-Ray トレースで見える実行履歴は、単一の不透明な「ロールバック」ステップではなく、2つの補償が明確に順序立てて発火する様子として表示されます。

### 3. FIS はステートマシンではなく Lambda をターゲットにする

```typescript
// lib/stacks/fis-stack.ts（抜粋 — シナリオ F-1）
new fis.CfnExperimentTemplate(this, 'ScenarioF1ProcessPaymentOutage', {
    roleArn: fisRole.roleArn,
    stopConditions,
    targets: {
        ProcessPaymentFunction: {
            resourceType: 'aws:lambda:function',
            resourceArns: [props.processPaymentFn.functionArn],
            selectionMode: 'ALL',
        },
    },
    actions: {
        InjectPaymentOutage: {
            actionId: 'aws:lambda:invocation-error',
            parameters: { duration: 'PT5M', invocationPercentage: '100', preventExecution: 'true' },
            targets: { Functions: 'ProcessPaymentFunction' },
        },
    },
    logConfiguration: fisLogConfig,
});
```

どの FIS テンプレートにもステートマシンの ARN は一切登場しません — FIS のアクションカタログには参照できるものが存在しないためです。詳細は上記「[Step Functions を直接ターゲットにせず Lambda 拡張を使う理由](#step-functions-を直接ターゲットにせず-lambda-拡張を使う理由)」を参照してください。

### 4. Lambda レベルのエラーではなく Saga レベルの失敗を停止条件にする

`fis-arch-b-apigw-lambda` が Lambda のエラー数をアラームにするのに対し、本ワークスペースは *Saga 自体* の `ExecutionsFailed` メトリクスをアラームにします — Saga にとって本当に重要なシグナルは「個々の Lambda 呼び出しが例外を投げたか」ではなく「エンドツーエンドのビジネストランザクションが失敗したか」だからです:

```typescript
// lib/stacks/fis-stack.ts（抜粋）
const sagaFailedAlarm = new cw.Alarm(this, 'SagaExecutionsFailedAlarm', {
    metric: props.stateMachine.metricFailed({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
    }),
    threshold: 5,
    evaluationPeriods: 1,
    comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cw.TreatMissingData.NOT_BREACHING,
});
```

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
PROJECT=fis-chaos-f ENV=dev npm run bootstrap
```

### 4. 全スタックのデプロイ

```bash
PROJECT=fis-chaos-f ENV=dev npm run stage:deploy:all
```

依存関係の順序でスタックがデプロイされます:
1. `fis-chaos-f-dev-f-base` — DynamoDB 注文テーブル
2. `fis-chaos-f-dev-f-app` — 5 Lambda + Step Functions ステートマシン
3. `fis-chaos-f-dev-f-fis` — FIS テンプレート + IAM + アラーム

### 5. Saga 実行の開始

デプロイ後、`fis-chaos-f-dev-f-app` スタックの出力からステートマシン ARN を取得し、テスト実行を開始します:

```bash
aws stepfunctions start-execution \
  --state-machine-arn <StateMachineArn> \
  --input '{"orderId": "order-001"}'
```

DynamoDB の注文アイテムの `status` フィールドを確認することで、Saga がどこまで進行したかを確認できます:

```bash
aws dynamodb get-item \
  --table-name fis-chaos-f-dev-orders \
  --key '{"orderId": {"S": "order-001"}}'
```

### 6. FIS 実験の実行

AWS FIS コンソールで `F-1`、`F-2`、`F-3` のいずれかの実験テンプレートを選択し、**実験の開始** をクリックしてから、Saga 実行を開始します（手順 5）。Step Functions コンソールの Graph View で実行を確認すると、対象 Lambda の呼び出し失敗に伴って Catch 分岐と補償トランザクションが点灯する様子が観測できます。

### 観測結果（ap-northeast-1）

| シナリオ | 結果 |
| -------- | ---- |
| **F-1** | 障害ウィンドウ中に投入したすべてのSaga実行が`error: "ProcessPaymentFailed"`で失敗。`get-execution-history`で状態遷移`ReserveInventory (成功) → ProcessPayment (失敗) → ReleaseInventoryCompensation → ExecutionFailed`を確認——設計通り単一段階の補償が実行された |
| **F-2** | すべての実行が`error: "ReserveInventoryFailed"`で失敗。実行履歴は`ReserveInventory (失敗) → ExecutionFailed`——補償タスクは一切現れず、フェイルファストで取り消すものが何もないパスであることを確認 |
| **F-3** | すべての実行が`error: "ConfirmOrderFailed"`で失敗。実行履歴は`ReserveInventory (成功) → ProcessPayment (成功) → ConfirmOrder (失敗) → RefundPaymentCompensation1 → ReleaseInventoryCompensation2 → ExecutionFailed`——2段階の補償が正しい順序で実行された |

各シナリオの後、通常負荷での新規Saga実行は3つの正方向ステップすべてが完了して`SUCCEEDED`に戻り、FIS Lambda拡張の障害解除後のクリーンな回復を確認した。

## テスト

```bash
cd infrastructure
npm ci

# このワークスペースのテストをすべて実行
npm run test --workspace=fis-arch-f-stepfunctions-saga

# スナップショットテストのみ（3 スタック）
npm run test:snapshot --workspace=fis-arch-f-stepfunctions-saga

# CDK Nag コンプライアンスチェック
npm run test:compliance --workspace=fis-arch-f-stepfunctions-saga

# 意図的な変更後にスナップショットを更新
npm run test:snapshot:update --workspace=fis-arch-f-stepfunctions-saga
```

### テストカバレッジ

| テストスイート | ファイル | 検証内容 |
| -------------- | -------- | -------- |
| スナップショット | `test/snapshot/snapshot.test.ts` | 全 3 スタックの CFn テンプレートスナップショット、DynamoDB PAY_PER_REQUEST、Python 3.13 の Lambda 5 つ、X-Ray 有効な Standard ステートマシン 1 つ、ASL 定義内に Saga の全 5 ステートが存在すること、FIS テンプレート 3 つすべてが実在する`aws:lambda:invocation-error`アクションを使用し停止条件を持つこと |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions パック — 非抑制の警告・エラーがないこと |

## コスト見積もり

全サービスがサーバーレス（従量課金）のため、アイドル時のコストは実質 **ゼロ** です。

| サービス | 課金モデル | 実験中の推定コスト |
| -------- | ---------- | ------------------ |
| DynamoDB | PAY_PER_REQUEST | アイドル時はゼロ。数百回のテスト実行で < $0.01 |
| Lambda | 呼び出し数 + 実行時間 | 5 分間の実験で < $0.01 |
| Step Functions | Standard、ステート遷移課金 | 1 遷移あたり約 $0.000025。数十回のテスト実行で < $0.01 |
| CloudWatch | メトリクス + ログ | 実験ログ + ステートマシンログで月額 ~$0.01 |
| X-Ray | トレース記録課金 | 5 分間の実験で < $0.01 |
| **FIS** | **アクション分単価 $0.10** | 5分間の単一アクション実験は約$0.50、F-1〜F-3を1回実行すると約$1.50 |
| **合計（3シナリオのフルサイクル1回）** | | **約$1.50〜2、主にFISのアクション分単価による** |

**以前のドキュメントからの修正:** FISは**無料ではありません**——本シリーズの他のFISベースワークスペースと同様、アクション分単価$0.10で課金されます。

## セキュリティ上の考慮事項

- **Lambda 実行ロールは最小権限**: 5 つの関数はいずれも `table.grantReadWriteData()` により、特定の注文テーブルに対する `dynamodb:GetItem` / `PutItem` / `UpdateItem` / `DeleteItem` のみを保持します。
- **FIS ロールは最小権限**: FIS設定バケットの`FisConfigs/*`プレフィックスへの`s3:PutObject`/`s3:DeleteObject`、ターゲット解決用の`lambda:GetFunction`と`tag:GetResources`、停止条件アラーム 1 つのみへの`cloudwatch:DescribeAlarms`。DynamoDBへのアクセスなし。補償用の `ReleaseInventory` / `RefundPayment` はFIS拡張レイヤーを一切持たず、FIS のターゲットには含まれません（カオスシナリオで不可到達にする必要がないため）。
- **VPC なし**: VPC・パブリックサブネット・セキュリティグループが存在せず、ステートマシンと 5 つの Lambda はすべて AWS API/SDK 経由でのみ到達可能な完全マネージドサーバーレスリソースです。
- **ステートマシンはインターネットに公開されない**: 本リファレンスパターンは（パブリック HTTP エンドポイントではなく）`start-execution`（CLI/SDK/コンソール）経由で呼び出されます。本番環境では認証付き API（API Gateway + Cognito/IAM 認証や認証済みイベントソース）でフロントすることを推奨します。
- **停止条件は必須**: 全 3 つの FIS テンプレートに Saga の `ExecutionsFailed` アラームの停止条件が含まれており、並行するテスト実行にまたがる実験の最大影響範囲を制限しています。

## トラブルシューティング

| 症状 | 考えられる原因 | 対処法 |
| ---- | -------------- | ------ |
| `cdk deploy` が `No parameters found for environment` で失敗 | `dev-params.ts` のエクスポートが欠けている | `parameters/index.ts` が `dev` キーで `devParams` をエクスポートしていることを確認 |
| FISテンプレート作成が`Invalid actionId ... 404`で失敗 | リージョンに存在しないアクションID | `aws fis list-actions`を確認——Lambda対象アクションは`aws:lambda:function`ファミリーに限られる |
| 実験開始後、エラーが現れるまで約1分かかる | 想定通り——FIS Lambda拡張のスローポーリングによるランプアップ | 約60秒待つ。CloudWatch Logsで`AWS FIS EXTENSION - found active faults`を確認し障害が実際に有効か確認する |
| Saga 実行のステータスが 5 分を超えても `RUNNING` のまま | 想定外 — ステートマシンには 5 分の実行タイムアウトが設定されている | Step Functions の Graph View でスタックしたステートを確認。タイムアウトにより `TimedOut` ステータスへ強制遷移するはず |
| `ReserveInventory` で失敗し、補償が表示されない | F-2 実行中は想定通り — これは設計上のフェイルファストパス | F-2 実験が実行中であることと、`ReserveInventory` の CloudWatch Lambda メトリクスを確認 |
| FIS 実験が即座に停止する | 停止条件アラームがすでに `ALARM` 状態 | `aws cloudwatch set-alarm-state --alarm-name ... --state-value OK` でアラームをリセット |
| Lambda で `Table not found` エラー | BaseStack が未デプロイ | Base → App → FIS の順序でデプロイ |

## クリーンアップ

```bash
PROJECT=fis-chaos-f ENV=dev npm run stage:destroy:all
```

全リソースは `removalPolicy: DESTROY`（S3設定バケットは`autoDeleteObjects`も）に設定されているため、DynamoDB テーブル、5 つの Lambda 関数、Step Functions ステートマシン、FIS設定バケット、FIS テンプレート、CloudWatch ログ グループが完全に削除されます。

## まとめ

本ワークスペースは、2フェーズコミットの代わりに補償アクションで多段の分散トランザクションの整合性を保つ Step Functions Saga パターンに対する FIS カオスエンジニアリングを実演します。FIS には Step Functions を直接ターゲットにするアクションが存在しないため、3 つの実験はそれぞれ正方向 Lambda を`aws:lambda:invocation-error`（FIS Lambda拡張経由）で全呼び出し失敗させることで、実際にデプロイされた Retry/Catch/補償ロジックを、実際の障害と同じ形で駆動します:

- **F-2** は Saga の最初のステップが実行できない場合に、補償なし・部分状態なしで即座かつクリーンに失敗することを検証します。
- **F-1** は中間ステップが失敗した際に、単一の補償トランザクション（`ReleaseInventory`）が正しく実行されることを検証します。
- **F-3** は最終ステップが決済完了後に失敗した際に、2 段階の補償（`RefundPayment` の後に `ReleaseInventory`）が正しい順序で実行されることを検証します。

サーバーレスアーキテクチャにより実験コストは低く抑えられ（フルサイクルあたり数ドル、主にFISのアクション分単価による）、VPC 管理も不要なため、Saga の耐障害性シナリオを容易に反復検証できます。

## 参考資料

- [AWS FIS — サポートされているアクション](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [AWS FISの`aws:lambda:function`アクションを使用する](https://docs.aws.amazon.com/fis/latest/userguide/use-lambda-actions.html)
- [AWS Step Functions — エラー処理（Retry / Catch）](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)
- [Saga パターン (AWS Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga.html)
- [CDK aws-fis モジュール (L1 コンストラクト)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
- [CDK aws-stepfunctions-tasks — LambdaInvoke](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_stepfunctions_tasks.LambdaInvoke.html)
