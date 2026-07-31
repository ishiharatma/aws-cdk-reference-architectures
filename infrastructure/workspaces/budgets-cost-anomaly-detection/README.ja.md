# 予算アラート & コスト異常検出 —— 5つのFinOpsアラートパターン

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## はじめに

このプロジェクトは、AWS CDKを使用してAWSコストに関するアラートを実装するリファレンス実装です。古典的なCloudWatch請求アラームから、Step Functionsによるスケジュール実行型のチャットネイティブなコストダイジェストまで、5つのFinOpsアラートパターンを5つの独立したCDKスタックとして実装しています。

- **パターンA** — AWS Budgets のコストしきい値 → SNS → メール（Stack 1）
- **パターンB** — AWS Cost Anomaly Detection → SNS → メール（Stack 2）
- **パターンC** — Budgets と異常検出を1つのSNSトピックに統合し、任意でAWS Chatbot経由でSlackに配信（Stack 3）
- **パターンD** — 古典的なCloudWatch `EstimatedCharges` 請求アラーム → SNS → メール（Stack 4）
- **パターンE** — Step Functionsによるスケジュール実行型のコストダイジェストを、AWS Chatbot経由でSlackおよび/またはMicrosoft Teamsに投稿（Stack 5）

### なぜ5パターンなのか

| 特徴 | A（Budgets） | B（異常検出） | C（統合） | D（請求アラーム） | E（コストダイジェスト） |
| ---- | ------------- | -------------- | --------- | ------------------ | ------------------------- |
| トリガー | リアクティブ——あらかじめ定義した**既知のしきい値** | リアクティブ——過去の傾向から**逸脱した**支出（ML） | 両方、リアクティブ | リアクティブ——単一の累積支出しきい値 | プロアクティブ——スケジュール（発火にしきい値は不要） |
| 向いている用途 | 「このアカウントは月$Xを超えさせない」 | 「予算内でも普段と違う動きがあれば気づきたい」 | 両リアクティブシグナルを1つのアラートチャネルに集約 | Cost Explorerに依存しない最も古い安全網 | 「今週いくら使ったか、サービス別に教えてほしい」 |
| セットアップの複雑さ | 低 | 低 | 中（トピックポリシーを共有） | 低（ただしus-east-1固定） | 高（Step Functions + Scheduler + Chatbot） |
| 配信 | SNS + メール | SNS + メール | SNS + メール + 任意でSlack | SNS + メール | SNS + メール + 任意でSlack/Teams |

## アーキテクチャ概要

![overview](overview.drawio.svg)

### パターンA — AWS Budgets（Stack 1）

```text
CfnBudget（アカウント全体、月次）  ─┐
CfnBudget（サービスフィルタ）      ─┴─→ SNSトピック（budgets.amazonaws.com がPublish可） → メール
```

2つの予算が同じ通知ルールとSNSトピックを共有します。

| Budget | 目的 |
| ------ | ---- |
| **Monthly Cost Budget** | アカウント全体を対象とする月次 `COST` 予算 |
| **Service Cost Budget** | 同じ上限を `costFilters.Service` でサービス単位に絞り込み、サービス別予算の使い方を示す |

各予算は `{ type: 'ACTUAL' | 'FORECASTED', thresholdPercent }` の配列で通知ルールを設定でき、デフォルトは予測100%以上・実コスト80%以上・実コスト100%以上です（詳細は下記「実装のポイント」の「1. 動的な予算通知ルール」を参照）。

### パターンB — AWS Cost Anomaly Detection（Stack 2）

```text
CfnAnomalyMonitor（DIMENSIONAL、SERVICE）
  → CfnAnomalySubscription（frequency: IMMEDIATE）
  → SNSトピック（costalerts.amazonaws.com がPublish可）
```

異常検出のサブスクリプションは、異常の影響額が「想定支出に対する割合」と「絶対金額」の**両方**のしきい値を超えたときのみ発火します（AND結合された `thresholdExpression`）。

> **SNS配信には `frequency: IMMEDIATE` が必須です。** AWS Cost Anomaly DetectionでSNSサブスクライバーがサポートされるのは `IMMEDIATE` サブスクリプションのみで、`DAILY`/`WEEKLY` はメール専用です。メールでの日次サマリーも併用したい場合は、同じモニターを参照する2つ目の `CfnAnomalySubscription`（frequency: `DAILY`、`EMAIL` サブスクライバー）を追加してください。

### パターンC — 統合アラート（Slackは任意）（Stack 3）

```text
CfnBudget                                              ─┐
CfnAnomalySubscription（Stack 2のモニターにアタッチ）    ─┴─→ SNSトピック（両サービスのプリンシパルを許可） → メール
                                                                                                          └→ AWS Chatbot → Slack（任意）
```

1つの共有SNSトピックが両方のシグナルを受け取ります。`params.notification.slack` が設定されていれば `SafeSlackChannelConfiguration` が同じトピックをSlackチャンネルにも配信します。未設定の場合でも、Stack 1/2 と同様にメールでの配信は継続します。

> **Stack 3はStack 2の異常検出モニターに依存しており、自分ではモニターを作成しません。** AWSはアカウントあたりのAWS管理型Cost Anomaly Detectionモニター数に上限を設けています。
>
> > "You can create one AWS services managed monitor plus one additional AWS managed monitor (linked account, cost allocation tag, or cost category) per management account."
> > "AWS managed monitors for linked accounts, cost allocation tags, and cost categories can only be created in management accounts."
> > （訳: 「AWS servicesの管理型モニターを1つ、さらに管理アカウントごとにもう1つだけ（linked account／cost allocation tag／cost categoryのいずれか）追加のAWS管理型モニターを作成できます」「linked account／cost allocation tag／cost category用のAWS管理型モニターは管理アカウントでしか作成できません」）
> > — [Extending AWS managed monitors in AWS Cost Anomaly Detection](https://aws.amazon.com/blogs/aws-cloud-financial-management/extending-aws-managed-monitors-in-cost-anomaly-detection/)（AWS Cloud Financial Managementブログ）
>
> Stack 2が既にアカウント内で唯一の`SERVICE`次元モニターを作成しています。もしStack 3が自分でも`SERVICE`モニターを作成しようとすると、Stack 2デプロイ後は`HandlerErrorCode: AlreadyExists`で必ず失敗します（実際にこのリファレンスアーキテクチャをデプロイして確認済みです）。次元を`LINKED_ACCOUNT`などに変えても綺麗には回避できません——それらのAWS管理型モニターはAWS Organizationsの**管理アカウント**でしか作成できず、多くの検証用アカウントはそれに該当しないためです。代わりに、Stack 3はStack 2のモニターARNをprops（`anomalyMonitorArn`）として受け取り、そこに*追加の*`CfnAnomalySubscription`をアタッチします——1つのモニターに複数のサブスクリプションを紐づけるのは元々AWSがサポートしている構成であり、苦肉の回避策ではありません。Stage側でStack 2をStack 3より先にインスタンス化し、`anomalyStack.monitorArn`を渡すことで、CDKが実際のCloudFormationクロススタックexport/importに変換してくれます。
>
> **Stack 2とStack 3を両方デプロイすると、条件を満たす異常はすべて2回通知されます**——Stack 2のサブスクリプション経由（→メール）と、Stack 3のサブスクリプション経由（→メール＋任意でSlack）の両方が、同じモニターを見ているためです。`params.anomalyDetection.unifiedEscalation`（`parameters/dev-params.ts`を参照）でStack 3のサブスクリプションにより厳しいしきい値を設定できるので、Stack 2のベースのサブスクリプションより大きな異常だけが統合/Slackチャンネルに届くようにできます——これは「1つのモニターが複数の重大度でサブスクリプションにデータを流せる」ことを示すためのものであり、**両方のしきい値を満たす異常についての重複自体はなくなりません**。実運用ではStack 2かStack 3の**どちらか一方**を異常検出用に使ってください。

### パターンD — 古典的なCloudWatch請求アラーム（Stack 4）

```text
CloudWatchアラーム（AWS/Billing EstimatedCharges） → SNSトピック（cloudwatch.amazonaws.com がPublish可） → メール
```

最も古いAWSコストアラート機構で、網羅性のため、およびCost Explorerに依存しないフォールバックとして含めています。このスタックが自動設定**できない**、アカウントレベルの前提条件が2つあります。

1. **「請求アラートを受け取る」** をBillingの環境設定で一度だけ手動で有効化する必要があります——このアカウント設定にはCloudFormation/CDKリソースが存在せず、有効化しないと `EstimatedCharges` データはそもそも発行されません。
2. `AWS/Billing` メトリクスは**必ずus-east-1でのみ発行されます**。デフォルトリージョンに関係なく、このスタックの `env.region` はStage内で他の4スタックとは独立して `us-east-1` に固定しています。

### パターンE — Slack/Microsoft Teamsへのスケジュール実行型コストダイジェスト（Stack 5）

```text
EventBridge Scheduler（cron）
  → Step Functions（Standard、JSONata）
      1. GetCostAndUsage   – Cost Explorer SDK連携。直近N日間の支出をサービス別に
         集計し、上位5サービスの内訳と合計をすべてJSONataで計算（Lambda不使用）
      2. PublishCostDigest – マークダウンメッセージを整形（「怒りしきい値」でトーンを
         切り替え）してSNSにPublish
  → SNSトピック → AWS Chatbot → SlackおよびMicrosoft Teams（どちらか一方または両方）
```

パターンA〜Dが「しきい値超過を教えて」というリアクティブなプルであるのに対し、これはスケジュールに基づく**プロアクティブなプッシュ**です——「使った金額を教えて」。もともとMicrosoft Teamsを対象に手書きされたCloudFormationテンプレートを元にしており、このCDK版では `params.notification.{slack,teams}` のどちらが設定されているかだけでSlack・Teams・両方のいずれにも対応します。

---

## 前提条件

- AWS CLI v2 がインストール・設定済みであること
- Node.js 20以降
- AWS CDK CLI（`npm install -g aws-cdk`）
- TypeScriptの基本知識
- [AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html) と [Cost Anomaly Detection](https://docs.aws.amazon.com/cost-management/latest/userguide/manage-ad.html) が有効なAWSアカウント（Cost Explorerを一度は有効化しておく必要があります）
- （Stack 4）Billingの環境設定（アカウント設定）で「請求アラートを受け取る」を一度有効化しておくこと——詳細は上記「パターンD」を参照
- （任意、Stack 3/5のSlack配信を使う場合）[AWS Chatbot](https://docs.aws.amazon.com/chatbot/latest/adminguide/setting-up.html) で認可済みのSlackワークスペース
- （任意、Stack 5のTeams配信を使う場合）[AWS Chatbot](https://docs.aws.amazon.com/chatbot/latest/adminguide/teams-setup.html) で認可済みのMicrosoft Teamsチーム

## プロジェクトディレクトリ構造

```text
budgets-cost-anomaly-detection/
├── bin/
│   └── budgets-cost-anomaly-detection.ts                     # アプリケーションエントリポイント
├── lib/
│   ├── stacks/
│   │   ├── budgets-cost-anomaly-detection-budget-stack.ts       # Stack 1 – パターンA
│   │   ├── budgets-cost-anomaly-detection-anomaly-stack.ts      # Stack 2 – パターンB
│   │   ├── budgets-cost-anomaly-detection-unified-stack.ts      # Stack 3 – パターンC
│   │   ├── budgets-cost-anomaly-detection-billing-alarm-stack.ts # Stack 4 – パターンD
│   │   └── budgets-cost-anomaly-detection-cost-digest-stack.ts  # Stack 5 – パターンE
│   ├── stages/
│   │   └── budgets-cost-anomaly-detection-stage.ts              # デプロイオーケストレーション
│   └── types/
│       ├── index.ts                              # 型のエクスポート
│       ├── budget-params.ts                       # Budgetパラメータ（共通のBudgetNotificationRuleを re-export）
│       ├── anomaly-params.ts                      # Cost Anomaly Detectionの型
│       ├── notification-params.ts                 # メール/Slack/Teams通知の型
│       ├── billing-alarm-params.ts                # 請求アラームしきい値の型
│       └── cost-digest-params.ts                  # コストダイジェストのスケジュール/しきい値の型
├── parameters/
│   ├── environments.ts                            # EnvParamsインターフェース + レジストリ
│   ├── dev-params.ts                               # 開発環境パラメータ
│   └── prd-params.ts                               # 本番環境パラメータ
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts                        # CDK Nag AwsSolutionsコンプライアンステスト
│   ├── snapshot/
│   │   └── snapshot.test.ts                        # CloudFormationテンプレートのスナップショットテスト
│   └── unit/
│       └── budgets-cost-anomaly-detection.test.ts  # 詳細なアサーションテスト
```

このパターンでは、リポジトリ全体で（このワークスペースに限らず）再利用可能な7つのコンストラクトを `infrastructure/common/constructs/cost/` にも追加しています——詳細は下記「実装のポイント」の「5. 再利用可能なコストコンストラクト」を参照。

```text
common/
├── types/
│   └── cost.ts                          # BudgetNotificationRule + デフォルト値
└── constructs/cost/
    ├── cost-alert-topic.ts              # Budgets/CE/CloudWatchのPublishに対応済みSNSトピック
    ├── budget.ts                        # BudgetNotificationRule[]駆動のCfnBudgetラッパー
    ├── anomaly-detection.ts             # CfnAnomalyMonitor + CfnAnomalySubscriptionラッパー
    ├── billing-alarm.ts                 # AWS/Billing EstimatedChargesアラームラッパー
    ├── safe-slack-channel.ts            # 安全なガードレールデフォルトを持つSlackChannelConfiguration
    ├── safe-teams-channel.ts            # CfnMicrosoftTeamsChannelConfiguration + 最小権限ロール/ガードレール
    └── cost-digest.ts                   # Scheduler + JSONata Step Functionsコストダイジェスト + Chatbot配信
```

---

## 実装のポイント

### 1. 動的な予算通知ルール

「80%、100%、予測100%」をスタックにハードコードするのではなく、通知ルールを環境パラメータ側のプレーンな配列として持たせています。これにより、どの環境でもスタックのコードを変更せずにしきい値を追加・削除できます（例: 暴走コストへのエスカレーションとして200%を追加）。

```typescript
// common/types/cost.ts
export interface BudgetNotificationRule {
    readonly type: 'ACTUAL' | 'FORECASTED';
    readonly thresholdPercent: number;
}

// parameters/dev-params.ts
budget: {
    amount: 10,
    notifications: [
        { type: 'FORECASTED', thresholdPercent: 100 },
        { type: 'ACTUAL', thresholdPercent: 80 },
        { type: 'ACTUAL', thresholdPercent: 100 },
        { type: 'ACTUAL', thresholdPercent: 200 }, // 暴走コスト向けエスカレーション
    ],
},
```

```typescript
// common/constructs/cost/budget.ts
const notificationRules = props.notifications ?? defaultBudgetNotifications;
const notificationsWithSubscribers = notificationRules.map((rule) => ({
    notification: {
        notificationType: rule.type,
        comparisonOperator: 'GREATER_THAN',
        threshold: rule.thresholdPercent,
        thresholdType: 'PERCENTAGE',
    },
    subscribers,
}));
```

### 2. SNSトピックポリシーは省略できない

AWS BudgetsとAWS Cost Anomaly Detectionはどちらも、IAMロールの引き受けではなく**サービスプリンシパル**としてSNSにPublishします。CloudWatchアラームアクションも同様の明示的な許可が必要です。これがないと通知は黙って失敗します——予算/サブスクリプション/アラームの設定は正しく見えても、何も届きません。共有の `CostAlertTopic` コンストラクトが、この3種類の許可をすべてブール値フラグの背後に集約しています。

```typescript
// common/constructs/cost/cost-alert-topic.ts（簡略化）
if (props.allowBudgetsPublish) {
    topic.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['sns:Publish'],
        conditions: {
            StringEquals: { 'aws:SourceAccount': account },
            ArnLike: { 'aws:SourceArn': `arn:${partition}:budgets::${account}:*` },
        },
    }));
}
if (props.allowCostAnomalyDetectionPublish) { /* costalerts.amazonaws.com、SourceAccountのみ */ }
if (props.allowCloudWatchAlarmPublish) { topic.grantPublish(new iam.ServicePrincipal('cloudwatch.amazonaws.com')); }
```

Cost Anomaly Detection側のステートメントは `aws:SourceAccount` の条件だけで十分です——AWS公式のサンプルでもこのサービスには `SourceArn` のスコープ指定はありません。また、CloudWatchの `cloudwatch-actions.SnsAction` は、他のアラームアクションで期待するような自動許可を**行いません**。そのため、パターンDでは明示的な `allowCloudWatchAlarmPublish` フラグが必要です。

> **これらのトピックにカスタマー管理のKMSキーを追加しないでください。** BudgetsとCost Anomaly Detectionのトラブルシューティングドキュメントには、トピックの暗号化が通知の黙った失敗の典型的な原因として明記されています。サービスプリンシパル側にもキーポリシーで `kms:GenerateDataKey*`/`kms:Decrypt` の許可が必要になるためです。これらのトピックはデフォルト（保管時暗号化なし）のSNS設定のままにし、代わりに `enforceSSL: true` で転送時の暗号化を強制しています（根拠は `test/compliance/cdk-nag.test.ts` の cdk-nag 抑制コメントを参照）。

### 3. Cost Anomaly Detectionの `thresholdExpression`

`CfnAnomalySubscription.thresholdExpression` は `aws-cdk-lib` 上では単なる `string` 型です。CDKはCost Explorerの `Expression` 文法を型として持たないため、自分で組み立てて `JSON.stringify()` する必要があります。

```typescript
thresholdExpression: JSON.stringify({
    And: [
        {
            Dimensions: {
                Key: 'ANOMALY_TOTAL_IMPACT_PERCENTAGE',
                MatchOptions: ['GREATER_THAN_OR_EQUAL'],
                Values: [String(thresholdPercentage)],
            },
        },
        {
            Dimensions: {
                Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
                MatchOptions: ['GREATER_THAN_OR_EQUAL'],
                Values: [String(thresholdAbsoluteUsd)],
            },
        },
    ],
}),
```

### 4. AWS Chatbotのガードレールポリシーのデフォルトは `AdministratorAccess`（SlackもTeamsも）

`SlackChannelConfigurationProps.guardrailPolicies` と `CfnMicrosoftTeamsChannelConfigurationProps.guardrailPolicies` はどちらも、未指定のままだとAWS管理の `AdministratorAccess` ポリシーがデフォルトで適用されます。**空配列は安全な代替になりません**——CDKのsynthは空のリストプロパティを合成後のCloudFormationテンプレートから完全に取り除いてしまうため、API上ではプロパティ未設定の扱いとなり、結局 `AdministratorAccess` のデフォルトが適用されてしまいます。

`SafeSlackChannelConfiguration` と `SafeMicrosoftTeamsChannelConfiguration`（`common/constructs/cost/`）は、チャット配信が必要なすべてのスタックに対してこのギャップを一度だけ塞ぎ、呼び出し元が明示的にガードレールを指定しない場合は `ReadOnlyAccess` を代わりに適用します。

```typescript
guardrailPolicies:
    props.guardrailPolicies && props.guardrailPolicies.length > 0
        ? props.guardrailPolicies
        : [iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')],
```

Microsoft TeamsにはCDKのL2コンストラクトが一切存在しません——`SafeMicrosoftTeamsChannelConfiguration` は、AWS公式のサンプルChatbotポリシーが使用する最小権限の「通知専用」IAMロール（`cloudwatch:Describe*`/`Get*`/`List*` のみ）も自動生成するため、呼び出し側で手動で組み立て直す必要がありません。

### 5. 再利用可能なコストコンストラクト（`common/constructs/cost/`）

上記の部品は、このワークスペース固有ではなく本当にリポジトリ全体で使えるものなので、このワークスペースの `lib/stacks/` ではなく `infrastructure/common/constructs/cost/` に配置しています。

| コンストラクト | ラップする対象 | 利用箇所 |
| -------------- | -------------- | -------- |
| `CostAlertTopic` | SNS `Topic` + 条件付きリソースポリシー（Budgets/CE/CloudWatch） + メール購読 | Stack 1, 2, 3, 4 |
| `CostBudget` | `BudgetNotificationRule[]` 駆動の `CfnBudget` | Stack 1（×2）, Stack 3 |
| `CostAnomalyDetection` | `CfnAnomalyMonitor` + `CfnAnomalySubscription`（+ `thresholdExpression` ビルダー） | Stack 2, Stack 3 |
| `BillingAlarm` | `AWS/Billing EstimatedCharges` のCloudWatchアラーム | Stack 4 |
| `SafeSlackChannelConfiguration` | 安全なガードレールデフォルトを持つ `chatbot.SlackChannelConfiguration` | Stack 3, Stack 5 |
| `SafeMicrosoftTeamsChannelConfiguration` | 最小権限ロール + 安全なガードレールデフォルトを持つ `chatbot.CfnMicrosoftTeamsChannelConfiguration` | Stack 5 |
| `CostDigest` | Stack 5のパターンまるごと: EventBridge Scheduler → JSONata Step Functions（`GetCostAndUsage` → `PublishCostDigest`） → SNS → 任意でSlack/Teams | まだ未接続——下記の注記を参照 |

`CostDigest` はStack 5のパターン全体（スケジューラ、ステートマシン、トピック、任意のChatbot配信）を、少数のプレーンなprops（`project`、`environment`、スケジュール/しきい値/言語、`emails`、任意の`slack`/`teams`）の背後にまとめており、このワークスペースの`EnvParams`型に依存せずに他のワークスペースからも再利用できます。**このワークスペースのStack 5は、依然として自前のインライン実装を使っています**（`CostDigest`を呼び出す形にはまだリファクタリングしていません）——まずは独立した再利用可能な部品としてコンストラクトを追加した段階で、両者の実装は機能的には同一（同じリソース構成、同じロケール対応のメッセージビルダー）ですが、現状は別々のコードとして保守されています。

### 6. コストダイジェストのJSONataステートマシン（Stack 5）

ステートマシンはちょうど2つのステートで構成され、どちらも生のASLとして `sfn.CustomState` で記述しています（Cost ExplorerやSNSのAWS-SDK連携には型付きのCDKタスクが存在しないため）。プレーンな `.next()` で連結し、`Next`/`End` はCDKのステートグラフ合成によって自動的に付与されます（手書きしていません）。

```typescript
const getCostAndUsage = new sfn.CustomState(this, 'GetCostAndUsage', {
    stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:costexplorer:getCostAndUsage',
        Arguments: { /* Granularity, Metrics, TimePeriod（JSONata）, GroupBy, Filter */ },
        Assign: { AngryThreshold: angryThresholdUsd, AccountId: cdk.Aws.ACCOUNT_ID, /* ... */ },
        Output: { Start: '{% ... %}', CostSum: '{% ... %}', CostSorted: '{% ... %}' },
    },
});
const publishCostDigest = new sfn.CustomState(this, 'PublishCostDigest', {
    stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::sns:publish',
        Arguments: { Message: { /* title/description、JSONataテンプレート */ }, TopicArn: topic.topicArn },
    },
});
getCostAndUsage.next(publishCostDigest);

new sfn.StateMachine(this, 'CostDigestStateMachine', {
    definitionBody: sfn.DefinitionBody.fromChainable(getCostAndUsage),
    queryLanguage: sfn.QueryLanguage.JSONATA,
    tracingEnabled: true,
    logs: { destination: logGroup, level: sfn.LogLevel.ALL, includeExecutionData: true },
});
```

> **知っておく価値のあるJS文字列エスケープの落とし穴。** description メッセージは、`"\n"` のようなJSONata文字列リテラルを連結して、レンダリングされるチャットメッセージに改行を強制しています。これをTypeScriptのテンプレートリテラルでそのまま `\n` と書くと、*JavaScript* がそのエスケープを即座に解釈してしまい——JS文字列内に実際の改行文字が生成されます。ただしこれはJSONシリアライズを経由して2文字の `\n` に戻るため、たまたま動作します。実際に静かに壊れるのは正規表現 `\s*`（`$replace(/^(AWS|Amazon)\s*/, "")` 内）のケースです。`\s` はJavaScriptの文字列エスケープとして認識**されない**ため、テンプレートリテラル内の裸の `\s` はJSエンジンによってバックスラッシュが静かに落とされ、単なる `s` になってしまいます——結果として正規表現が `s*` になり、サービス名のクリーンアップが静かに壊れます。`\\s` と書くことで、JS文字列内にリテラルなバックスラッシュが残り、JSONの往復を経てもJSONataの正規表現パーサーに正しく届きます。この2つの紛らわしいエスケープは、JSONata仕様を読むだけでなく、テストを書く前に実際に合成された `cdk synth` の出力を検査することで発見しました。

title/descriptionのJSONata式は、1回きりのインライン記述ではなく、2つの言語別ビルダー関数（`buildCostDigestTitleExpression`/`buildCostDigestDescriptionExpression`）から生成しています。どちらの言語でメッセージを組み立てるかは `params.costDigest.locale`（`'ja' | 'en'`、デフォルト `'ja'`）で切り替えられます。

```typescript
// parameters/dev-params.ts
costDigest: {
    // ...
    locale: 'ja', // 英語のダイジェストメッセージにしたい場合は 'en' に変更
},
```

`EventBridge Scheduler` の `StepFunctionsStartExecution` ターゲット（`aws-scheduler-targets`）は、スケジューラ自身の実行ロールを自動生成・自動付与します——このパターンの元になったCloudFormationテンプレートとは異なり、`states:StartExecution` のIAMステートメントを手動で書く必要はありません。

---

## 主要コンポーネントと設計ポイント

| コンポーネント | 設計ポイント |
| -------------- | ------------ |
| **SNSトピック** | `enforceSSL: true`。CMKは使用しない（理由は上記）。`CostAlertTopic` 経由でスタックごとに1つのトピックを構築 |
| **CfnBudget** | `budgetType: COST`、`timeUnit: MONTHLY`。通知ルールは `BudgetNotificationRule[]` パラメータで駆動 |
| **CfnAnomalyMonitor** | デフォルトで `monitorType: DIMENSIONAL`、`monitorDimension: SERVICE`（サービス単位の異常検出）。Stack 2のみが作成——AWSはアカウントあたり`SERVICE`モニターを1つしか許可しない |
| **CfnAnomalySubscription** | `frequency: IMMEDIATE`（SNS配信に必須）。`thresholdExpression` は割合としきい値をANDで結合。Stack 3は新規モニターを作らず、Stack 2のモニターに2つ目のサブスクリプションをアタッチする |
| **SlackChannelConfiguration（Stack 3, 5、任意）** | `params.notification.slack` 設定時のみ作成。`SafeSlackChannelConfiguration` によりガードレールは `ReadOnlyAccess` に固定し、`AdministratorAccess` デフォルトに任せない |
| **MicrosoftTeamsChannelConfiguration（Stack 5、任意）** | `params.notification.teams` 設定時のみ作成。`SafeMicrosoftTeamsChannelConfiguration` により最小権限の通知専用ロール + `ReadOnlyAccess` ガードレール |
| **CloudWatch請求アラーム（Stack 4）** | `AWS/Billing EstimatedCharges`、6時間の `Maximum`、`us-east-1` に固定 |
| **Step Functions（Stack 5）** | `QueryLanguage.JSONATA`、`tracingEnabled: true`、CloudWatch Logsへの完全（`ALL`）実行ログ |
| **EventBridge Scheduler（Stack 5）** | `params.costDigest` からのcron式とタイムゾーン。`StepFunctionsStartExecution` 経由でステートマシンをターゲットに |
| **ダイジェストメッセージの言語（Stack 5）** | `params.costDigest.locale`（`'ja' \| 'en'`、デフォルト `'ja'`）で、JSONataのtitle/descriptionを生成する2つのビルダー関数を切り替え |
| **メールサブスクライバー** | AWS Budgetsの通知1件あたり最大10件（AWSのサービス上限）。SNS/Cost Anomaly Detection/CloudWatch側は制限なし |

---

## デプロイと動作確認

```bash
export PROJECT=myproject
export ENV=dev

# ブートストラップ（初回のみ）
npm run bootstrap -w workspaces/budgets-cost-anomaly-detection

# 生成されるCloudFormationテンプレートを確認
npm run synth -w workspaces/budgets-cost-anomaly-detection

# 5スタックすべてをデプロイ
npm run deploy:all -w workspaces/budgets-cost-anomaly-detection
```

デプロイ前に `parameters/dev-params.ts`（または `prd-params.ts`）を編集し、プレースホルダーの `notification.emails` を実際のアドレスに置き換えてください。SNS/Budgetsのメールサブスクリプションは、受信者がサブスクリプション確認メールを承認するまで通知が届きません。Slack/Teams配信を有効にするには、`notification.slack.{workspaceId,channelId}` および/または `notification.teams.{teamId,tenantId,channelId}` のコメントを外して値を設定してください。

### パターンAの動作確認（Budgets）

予算の通知は実際の請求データ（通常1日に数回更新）に基づいて評価されるため、サンドボックスアカウントで即座に発火させる方法はありません。代わりに設定内容を確認します。

```bash
aws budgets describe-budgets --account-id <account-id>
aws budgets describe-notifications-for-budget --account-id <account-id> --budget-name <project>-<env>-monthly-cost
```

### パターンBの動作確認（Cost Anomaly Detection）

```bash
aws ce get-anomaly-monitors
aws ce get-anomaly-subscriptions
```

異常検出のMLモデルがベースラインを確立して検知を開始するまでには、通常**24時間以上**の請求履歴が必要です。

### パターンCの動作確認（統合 + Slack）

Stack 3はStack 2の異常検出モニターに依存しているため（上記「パターンC」を参照）、`npm run deploy:all`（内部的には`cdk deploy --all`で依存関係を自動解決）でデプロイするのが簡単です。個別にデプロイする場合はStack 2を先にデプロイしてください。

```bash
aws sns list-subscriptions-by-topic --topic-arn <finops-alert-topic-arn>
```

Slackを設定済みの場合は、トピックに直接Publishしてテスト通知を送れます。

```bash
aws sns publish --topic-arn <finops-alert-topic-arn> --message "Test FinOps alert"
```

### パターンDの動作確認（請求アラーム）

アラームとそのデータを確認します（このスタックはus-east-1にしか存在しないことに注意）。

```bash
aws cloudwatch describe-alarms --alarm-names <project>-<env>-estimated-charges --region us-east-1
aws cloudwatch get-metric-statistics --namespace AWS/Billing --metric-name EstimatedCharges \
  --dimensions Name=Currency,Value=USD --start-time $(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) --period 21600 --statistics Maximum --region us-east-1
```

データポイントが返らない場合、「請求アラートを受け取る」がまだ有効化されていない可能性があります（前提条件を参照）。

### パターンEの動作確認（コストダイジェスト）

スケジュールを待たずにオンデマンドで実行します。

```bash
aws stepfunctions start-execution --state-machine-arn <cost-digest-state-machine-arn>
```

配信を確認します。

```bash
aws sns list-subscriptions-by-topic --topic-arn <cost-digest-topic-arn>
```

---

## テストの実行

```bash
# ユニットテスト（詳細なCDKアサーション）
npm run test:unit -w budgets-cost-anomaly-detection

# スナップショットテスト
npm run test:snapshot -w budgets-cost-anomaly-detection

# CDK Nagコンプライアンス（AwsSolutionsパック）
npm run test:compliance -w budgets-cost-anomaly-detection
```

---

## ベストプラクティスまとめ

| コンポーネント | 推奨 | 避けるべきこと |
| -------------- | ---- | --------------- |
| SNSトピックポリシー | `SourceAccount`/`SourceArn` 条件で絞り込んだ明示的な `ServicePrincipal` ステートメント（`CostAlertTopic` 経由） | Budgets/CE/CloudWatchがリソースポリシーなしでPublishできると想定すること |
| SNS暗号化 | デフォルトのSNS管理暗号化（CMKなし）+ `enforceSSL: true` | カスタマー管理のKMSキー（サービス間でPublishが失敗することが公式に文書化されている） |
| 異常検出のSNS配信 | `frequency: IMMEDIATE` | `DAILY`/`WEEKLY` にSNSサブスクライバーを設定すること（サポート対象外の組み合わせ） |
| 予算のしきい値 | 環境ごとのデータ駆動な `BudgetNotificationRule[]` | スタックコードにハードコードされた通知ブロック |
| AWS Chatbotのガードレール（SlackもTeamsも） | `SafeSlackChannelConfiguration`/`SafeMicrosoftTeamsChannelConfiguration` 経由の明示的な最小権限マネージドポリシー（例: `ReadOnlyAccess`） | `guardrailPolicies` を未設定または `[]` のままにすること（どちらも `AdministratorAccess` になる） |
| 請求アラームのリージョン | アプリのデフォルトリージョンとは独立して明示的に `us-east-1` にデプロイ | スタックのデフォルトリージョンで動作すると想定すること |
| 共有インフラ上のStep Functions | `ALL` 実行ログ + X-Rayトレーシングを有効化（`cdk-nag` の AwsSolutions-SF1 がログ未設定を検出） | 「デモだから」とログを無効のままにすること |
| 再利用可能なコスト関連の配線 | パターンが複数スタックで繰り返される時点で `common/constructs/cost/` に切り出す | 同じSNSトピックポリシー/ガードレールのロジックを新しいスタックにコピー&ペーストし続けること |

---

## 料金試算

<details>
<summary>💰 月額見積り（東京リージョン、Stack 4のみus-east-1）</summary>

| サービス | パターン | 月額費用 |
| -------- | -------- | -------- |
| AWS Budgets | A, C | 最初の2予算は無料。それ以降は1予算あたり約$0.02/日 |
| AWS Cost Anomaly Detection | B, C | 追加費用なし |
| Amazon SNS | 全パターン | 最初の100万リクエストは無料枠内。アラート程度の量であれば実質無視できる水準 |
| AWS Chatbot | C, E（任意） | 追加費用なし |
| CloudWatchアラーム（請求） | D | 約$0.10/アラーム/月 |
| Step Functions（Standard） | E | 最初の月4,000ステート遷移は無料。日次スケジュールで1回あたり約2遷移であれば無視できる水準 |
| EventBridge Scheduler | E | 最初の月1,400万回の呼び出しは無料 |
| CloudWatch Logs（Step Functions） | E | 取り込み量約$0.50/GB。1日1回の短い実行であれば無視できる水準 |

合計: 一般的なアラート量であれば実質**月額$0〜2**。Stack 1とStack 3に含まれる2つのBudgetsは無料枠内に収まり、Stack 5のStep Functions/Schedulerの使用量も、日次カデンスであればそれぞれの無料枠を大きく下回ります。

</details>

---

## まとめ

このパターンから学べること:

1. **パターンA（Budgets）**: 既知の固定コスト上限に最適。SNSトピックポリシーを明示しないと通知が黙って失敗する。通知しきい値は自然にデータ駆動で設計できる。
2. **パターンB（異常検出）**: 予算内であっても想定外の支出を検知したい場合に最適。SNS配信には `IMMEDIATE` 頻度が必須で、異常検出の `thresholdExpression` は型付きのCDKプロパティではなく手組みのJSON文字列である。
3. **パターンC（統合）**: シグナルごとに別々のトピックを管理するより、1つのアラートチャネルに集約する方が運用上現実的。ただしStack 2が存在する状態では自分専用の異常検出モニターは持てない（AWSがアカウント・次元ごとにAWS管理型モニターを1つに制限しているため）ので、実際のクロススタック参照でStack 2のモニターに追加サブスクリプションをアタッチする。
4. **パターンD（請求アラーム）**: 最もシンプルな安全網だが、CDKでは表現できない2つのアカウントレベルの罠がある——「請求アラートを受け取る」の手動での一度きりの有効化と、厳格な `us-east-1` リージョン要件。
5. **パターンE（コストダイジェスト）**: プロアクティブでスケジュールされたダイジェストは、他の4つのリアクティブ/しきい値型パターンをうまく補完する。`sfn.CustomState` で直接ASL/JSONataを書くことでLambdaを完全に回避できるが、JS → JSON → JSONataの境界をまたぐ文字列エスケープには注意が必要。
6. **AWS Chatbotの `AdministratorAccess` ガードレールデフォルト**はSlackとMicrosoft Teamsの両方の設定に適用され、空配列を渡してもそれを無効化できない（CDKがsynth出力から空リストを除去してしまうため）——常に明示的で最小権限のガードレールポリシーを固定すること。
7. スタック間で繰り返される配線（トピックポリシー、ガードレールの安全性、Budget/異常検出のリソース形状）は、スタックごとにコピー&ペーストするのではなく、一度 `common/constructs/cost/` のコンストラクトとして切り出す価値がある。

---

## 参考資料

- [AWS Budgets ユーザーガイド](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html)
- [予算通知用のAmazon SNSトピックの作成](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-sns-policy.html)
- [AWS Cost Anomaly Detection](https://docs.aws.amazon.com/cost-management/latest/userguide/manage-ad.html)
- [Cost Anomaly Detection用のAmazon SNSトピックの作成](https://docs.aws.amazon.com/cost-management/latest/userguide/ad-SNS.html)
- [AWS::CE::AnomalySubscription — CloudFormationリファレンス](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ce-anomalysubscription.html)
- [Extending AWS managed monitors in AWS Cost Anomaly Detection](https://aws.amazon.com/blogs/aws-cloud-financial-management/extending-aws-managed-monitors-in-cost-anomaly-detection/)（Stack 3の設計根拠である「アカウントあたりSERVICEモニター1つ」制限の出典）
- [推定AWS料金を監視する請求アラームの作成](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/monitor_estimated_charges_with_cloudwatch.html)
- [AWS ChatbotとSlackのセットアップ](https://docs.aws.amazon.com/chatbot/latest/adminguide/setting-up.html)
- [AWS ChatbotとMicrosoft Teamsのセットアップ](https://docs.aws.amazon.com/chatbot/latest/adminguide/teams-setup.html)
- [AWS Step Functionsの変数とJSONata](https://docs.aws.amazon.com/step-functions/latest/dg/transforming-data.html)
- [Amazon EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html)
- [CDK Nag AwsSolutionsルール](https://github.com/cdklabs/cdk-nag/blob/main/RULES.md)
