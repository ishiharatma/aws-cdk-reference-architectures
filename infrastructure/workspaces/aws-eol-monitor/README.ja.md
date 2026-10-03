# AWS Service EOL Monitor — Bedrock要約付きサーバーレスEOL監視

*他の言語で読む(Read this in other languages):* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 200](https://img.shields.io/badge/Level-200-blue?style=flat-square)

## はじめに

このプロジェクトは、[`awslabs/aws-service-eol-data`](https://github.com/awslabs/aws-service-eol-data)(EKS/RDSエンジン/Lambdaランタイム/ElastiCache/OpenSearchなどのバージョンライフサイクル終了日(EOL)をまとめたJSONデータセット)を定期的に監視し、変化があれば優先度付きの要約をメールで通知するサーバーレスパイプラインです。EventBridge Scheduler、Step Functions、Lambda、DynamoDB、Amazon Bedrock、SNSで構成されます。

このアーキテクチャは以下を示します:

- データセットを取得し、DynamoDBに保存した状態と比較し、実際に変化があった場合だけ先へ進む、スケジュール実行のStep Functions(Standard)ワークフロー
- 毎回すべてを再通知するのではなく、変化を一度だけ報告する差分モデル(`NEW`、`STATUS_CHANGED`、`UPCOMING_EOL`)
- Amazon Bedrock(`ConverseCommand`)による、構造化された差分から日本語/英語の優先度付き要約への変換
- Step Functions標準の`SnsPublish`タスクによる通知配信(通知用のLambdaは不要)
- データセットURL、閾値、スケジュール、モデル、ロケール、宛先を環境ごとのパラメータ(`parameters/dev-params.ts`)で管理
- 2026-09-27に実機でエンドツーエンドのデプロイ検証済み。[実機デプロイ検証](#-実機デプロイ検証)を参照

> このデータセットのREADMEには **"NOT AN OFFICIAL AWS API. This is a community-maintained dataset provided on a best-effort basis"**(公式のAWS APIではなく、ベストエフォートで提供されるコミュニティ管理のデータセット)、**"no guarantee of completeness, accuracy, or timeliness of updates"**(完全性・正確性・更新の即時性は保証されない)と明記されています。各エントリの`sourceUrl`はAWS公式ドキュメントへのリンクで、独自に検証するためのものです。何らかの判断を下す際に正とすべきは、このデータセットや要約メールではなく、その`sourceUrl`先の公式ドキュメントです。

## 📑 目次

- [アーキテクチャ概要](#️-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [コスト最適化](#-コスト最適化)
- [セキュリティ考慮事項](#-セキュリティ考慮事項)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#️-カスタマイズ)
- [実機デプロイ検証](#-実機デプロイ検証)
- [トラブルシューティング](#-トラブルシューティング)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![アーキテクチャ概要](overview.drawio.svg)

### 主要コンポーネント

| コンポーネント | 役割 |
|---|---|
| **Dataスタック**(DynamoDBテーブル `TableV2`) | 差分の状態ストア。オンデマンド課金、PITR有効。`PK serviceCode` / `SK version`、属性は`status`、`standardSupportEnd`、`notifiedUpcoming`、`lastCheckedAt`。 |
| `FetchEolDiffFunction`(Node.js 22、arm64) | `fetch()`で`eol.json`を取得、状態テーブルをScanして差分を計算し、新しい状態をupsertする。タイムアウト30秒、256 MB。 |
| `GenerateReportFunction`(Node.js 22、arm64) | Bedrockの`ConverseCommand`に差分とロケール別プロンプトを渡し、`{ subject, body }`を返す。タイムアウト60秒、256 MB。 |
| Step Functionsステートマシン(Standard、JSONPath) | `FetchEolDiff` → `HasDiff`(`diffCount > 0`のChoice) → `GenerateReport` → `PublishReport`。差分なしの分岐は`NoChangesDetected`で終了。ログレベル`ALL`、X-Rayトレース有効。 |
| EventBridge Schedulerスケジュール | cron式とIANAタイムゾーンでステートマシンを起動する。 |
| SNSトピック | `notification.emails`の各アドレスにメール購読を作成する。 |

### データフロー

1. EventBridge Schedulerがcronスケジュールでステートマシンを起動する。
2. `FetchEolDiff`が`eol.json`を取得し、すべての`(serviceCode, version)`ペアをDynamoDBの状態と比較して、新しい状態を書き込む。
3. `HasDiff`は`diffCount`が0なら実行を終了し、それ以外は`GenerateReport`がBedrockに優先度付きのMarkdown要約を生成させる。
4. `PublishReport`が要約をSNSトピックへ発行し、購読者へメールが届く。

### アーキテクチャ特性

| 特性 | 値 | 根拠 |
|---|---|---|
| 可用性 | リージョン内のフルマネージドサービス | 運用するサーバーやVPCがなく、失敗した実行はStep Functionsの実行履歴で確認でき、次回のスケジュール実行は保存済みの状態から再開する |
| スケーラビリティ | スケジュール1回につきデータセット1回の取得を想定 | データセットは現状13サービス程度で、LambdaとDynamoDBの上限をはるかに下回る |
| セキュリティ | IAM最小権限、シークレットなし、VPCなし | 読み取るのは公開データのみ。[セキュリティ考慮事項](#-セキュリティ考慮事項)を参照 |
| コスト | 従量課金。Bedrockは差分がある実行のみ | [コスト最適化](#-コスト最適化)を参照 |

## 🎯 設計判断とベストプラクティス

### 1. 毎回すべてを再通知せず、保存した状態と差分を取る

**決定**: DynamoDBテーブルに各`(serviceCode, version)`の最終状態を保存し、実際に変化があったものだけを報告する。

**根拠**:
- ✅ 「毎回全件を取得してそのまま通知する」設計は、読み手に通知を無視させる原因になる
- ✅ `UPCOMING_EOL`はバージョンごとに一度だけ通知される(`notifiedUpcoming`)ため、閾値内にいる間に毎回通知が来ることはない
- ✅ 差分なしの実行ではChoiceステートがBedrockとSNSを完全にスキップする

**トレードオフ**:
- ❌ 状態を保存し整合性を保つ必要がある(テーブルのPITRは有効)
- ❌ 初回の実行では追跡中のすべてのバージョンが`NEW`として報告される(想定どおりで一度だけ)

| 差分タイプ | 発生条件 |
| --- | --- |
| `NEW` | 初めて追跡対象になったバージョン |
| `STATUS_CHANGED` | `status`が変化(例: `STANDARD_SUPPORT` → `DEPRECATED`) |
| `UPCOMING_EOL` | `standardSupportEnd`が新たに`collector.upcomingThresholdDays`以内に入り、かつ未通知 |

### 2. 要約はBedrockに任せ、事実の根拠は差分だけにする

**決定**: Lambda自身は整形せず、差分JSONをBedrockに渡して、優先度付きの説明文(緊急と参考情報の区別、指定言語)を生成させる。

**根拠**:
- ✅ 構造化されたEOL情報を、優先度付けのロジックを手書きせずに、専門家でなくても行動できる文章へ変換できる
- ✅ プロンプトには差分JSONのみを事実として渡し、「データにない移行手順を創作しない」ことを明示的に指示している(`src/lambda/generate-report/index.ts`)

**トレードオフ**:
- ❌ LLMを使わない固定テンプレートのメールの方が安価かつ決定論的で、多くのチームにはそちらが適切
- ❌ モデルIDは合成時点ではただの文字列で、誤りは実際のBedrock呼び出しでしか見つからない([実機デプロイ検証](#-実機デプロイ検証)を参照)

### 3. 通知用Lambdaではなくネイティブの`SnsPublish`タスクを使う

**決定**: ステートマシンはStep Functions標準の連携でSNSへ発行する。

**根拠**:
- ✅ 構築・保護・監視する関数が1つ減る
- ✅ ステートマシンのロールには、このトピックへの`sns:Publish`だけが付与される(`topic.grantPublish`)

### 4. パラメータで設定し、本番ではデータセットURLを固定する

**決定**: 環境ごとの設定はすべて`parameters/dev-params.ts`(`EnvParams`)に置く。

| キー | 意味 |
| --- | --- |
| `collector.datasetUrl` | データセットの`data/eol.json`のRaw URL。サンプルでは`main`を指しているが、本番ではタグ/コミットに固定し、上流のスキーマ変更で突然パーサーが壊れないようにすべき。 |
| `collector.upcomingThresholdDays` | `standardSupportEnd`がこの日数以内なら`UPCOMING_EOL`として扱う。 |
| `schedule.scheduleExpression` / `scheduleTimeZone` | EventBridge Schedulerのcron式とIANAタイムゾーン。 |
| `report.bedrockModelId` | BedrockのモデルIDまたはクロスリージョン推論プロファイルID(対象アカウント/リージョンでモデルアクセスが有効になっている必要あり)。 |
| `report.locale` | `'ja'`または`'en'`。Bedrockプロンプトの言語と、SNSの件名の両方に影響する。 |
| `notification.emails` | SNSのメール購読者。デプロイ前にプレースホルダーを実アドレスに置き換えること。 |

### 5. BedrockのIAMはfoundation-modelとinference-profileの両ARNを対象にする

**決定**: `bedrock:InvokeModel`を`foundation-model/*`と、このアカウントの`inference-profile/*`に付与する。

**根拠**: クロスリージョン推論プロファイルは複数リージョンのfoundation modelへルーティングするため、両方のARN形式を許可する必要がある。

### 6. Well-Architected Frameworkとの整合性

| 柱 | 実装 |
|----|------|
| **運用上の優秀性** | ステートマシンのログレベル`ALL`とX-Rayトレース。各Lambdaとステートマシンのロググループは保持期間1か月 |
| **セキュリティ** | 最小権限の付与(テーブルの読み書き、1つのトピックへの`sns:Publish`、範囲を絞った`bedrock:InvokeModel`)。シークレットなし、VPCなし。プロンプトでモデルが参照できる事実を、渡した差分に限定 |
| **信頼性** | フルマネージドサービス。状態テーブル(PITR有効)があるので、すでに報告した内容を実行のたびに繰り返し報告することはない |
| **パフォーマンス効率** | arm64のLambda。Bedrockは差分があるときだけ呼び出す |
| **コスト最適化** | 従量課金サービス。支配的なコスト(Bedrockのトークン)は差分がある実行でのみ発生 |
| **持続可能性** | アイドル時のコンピュートがない、サーバーレスのイベント駆動実行 |

## 💰 コスト最適化

### 推定月額コスト(ap-northeast-1、1日1回のスケジュール実行)

```text
Lambda(1回の実行あたり短時間の呼び出し2回):        この頻度なら無料利用枠の範囲内
Step Functions(Standard、実行あたり数ステート遷移): この頻度なら無料利用枠の範囲内
EventBridge Scheduler(スケジュール1件):            この頻度なら無料利用枠の範囲内
DynamoDB(オンデマンド、約125アイテム):             無視できる額
SNS(メール):                                       この頻度なら無料利用枠の範囲内
Bedrock(Converse、差分がある実行):                 支配的なコスト
```

Bedrockは入出力トークン単位で課金され、差分が検出された実行時のみ発生します。置き換えるべき前提を含む試算例:

```text
1回の要約実行 = 入力トークン数 × 入力単価 + 出力トークン数 × 出力単価
              = 3,000 × $3 / 100万  +  1,500 × $15 / 100万
              ≈ $0.009 + $0.0225 = 約$0.03
最悪ケース(毎日の実行で差分あり): 30 × 約$0.03 = 約$0.95 / 月
```

トークン数は説明用の仮定で、100万トークンあたり$3 / $15はClaude Sonnetの定価です。設定する推論プロファイル(`report.bedrockModelId`)の現在の単価を確認してください。初回の実行は追跡中のすべてのバージョンを`NEW`として報告するため、通常の実行よりプロンプトが大きくなります。見積りは固定リンクにしていないため、モデル・リージョン・実行頻度に応じて[AWS 料金見積りツール](https://calculator.aws/#/estimate)で作成してください。

### コスト最適化戦略

1. **実行頻度を下げる。** `schedule.scheduleExpression` を週次のcronにすると、最悪ケースのBedrockコストは日次の約7分の1です。
2. **差分がない実行ではBedrockを呼ばない。** これは実装済みで、`HasDiff`のChoiceが`GenerateReport`の前に実行を終了します。
3. **小さいモデルを使う。** 要約は短い処理なので、`report.bedrockModelId` を小さいClaudeモデルにすると、トークン単価が下がります。
4. **LLMをテンプレートに置き換える。** 毎回同じ形式の出力で足りるなら、Lambdaで差分を整形して、Bedrockを外します。

## 🔒 セキュリティ考慮事項

### ネットワークセキュリティ

1. **VPCもインバウンド通信もありません。** Lambdaが行うのは、アウトバウンドのHTTPS呼び出しだけです(`raw.githubusercontent.com`のデータセット、Bedrock、DynamoDB)。
2. **信頼できない入力はデータとして扱います。** データセットはコミュニティが管理しているため、プロンプトには差分のJSONだけを事実として渡し、データにない移行手順は作らないようモデルに指示しています。

### 実装されているセキュリティベストプラクティス

- ✅ `FetchEolDiffFunction`は状態テーブル1つに対する読み書きだけを持つ(`grantReadWriteData`)
- ✅ `GenerateReportFunction`は、foundation modelとこのアカウントの推論プロファイルに対する`bedrock:InvokeModel`だけを呼び出せる
- ✅ ステートマシンのロールは、1つのSNSトピックへの発行だけができる
- ✅ 認証情報やAPIキーは保存せず、BedrockへはLambdaの実行ロールでアクセスする
- ✅ DynamoDBのポイントインタイムリカバリを有効化。ロググループの保持期間は1か月
- ✅ Step Functionsの実行データをログに記録している(`includeExecutionData: true`)。データは公開されているEOL情報だが、機密項目を追加する前にこの設定を見直すこと

### CDK Nag準拠

このワークスペースには`test/compliance`のスイートがまだありません。本番のベースラインとして使う前に、他のワークスペースの`cdk-nag.test.ts`に倣って追加してください。

## 📋 前提条件

- CloudFormation、Lambda、Step Functions、DynamoDB、SNS、EventBridge Scheduler、IAMのリソースをデプロイできる権限を持つAWSアカウント
- `<project>-<env>`という名前のプロファイルで設定済みのAWS CLI v2
- Node.js 20以降、AWS CDK 2.x
- 対象リージョンで、`report.bedrockModelId`のモデル/プロファイルに対するAmazon Bedrockのモデルアクセス(Bedrockコンソール → モデルアクセス)
- SNSの購読確認ができるメールアドレス

## 🚀 デプロイ手順

### 1. セットアップ

```sh
# infrastructure/workspaces/aws-eol-monitor で実行
npm install
```

### 2. 環境パラメータの設定

`parameters/dev-params.ts`を編集します:

1. 実際の`notification.emails`アドレス。
2. アカウントでモデルアクセスが有効な`bedrockModelId`。
3. `collector.datasetUrl`を`main`ではなく[タグ付きリリース](https://github.com/awslabs/aws-service-eol-data/tags)に固定する(データセット側のREADMEでも本番利用時の推奨事項として明記されている)。

### 3. デプロイ

```sh
PROJECT=myproj ENV=dev npm run bootstrap   # アカウント/リージョンごとに一度だけ
PROJECT=myproj ENV=dev npm run deploy:all
```

初回デプロイ後、SNSのメールサブスクリプション確認メールを承認してください。承認しない限り要約は届きません。

### 4. デプロイの確認

スケジュールにより自動実行されます。任意のタイミングで試す場合は、Step Functionsコンソールから`<project>-<env>-eol-monitor`ステートマシンの実行を開始する(入力は不要)か、次のコマンドを使います:

```sh
aws stepfunctions start-execution --state-machine-arn <state-machine-arn>
```

初回の実行では現在追跡中の全バージョンが`NEW`として報告されますが、これは想定どおりで一度だけ発生します。

### クリーンアップ

```sh
PROJECT=myproj ENV=dev npm run destroy:all
```

DynamoDBテーブルの`RemovalPolicy`は`isAutoDeleteObject`に従います(本番以外は削除、本番は保持)。`ENV=prd`環境で削除する前にスタックの内容を確認してください。

## 🧪 テスト戦略

### テスト構造

```text
test/
├── parameters/        # テスト用パラメータ
└── unit/              # 両スタックに対するFine-grained Assertions
    └── aws-eol-monitor.test.ts
```

### ユニットテスト

**目的**: 両スタックのリソース形状を検証する(6テスト)。

- ✅ Dataスタック: PITR有効で期待どおりのキー構成を持つDynamoDBテーブル1つ(1テスト)
- ✅ Applicationスタック: Lambda関数2つ、メール購読付きのSNSトピック、Standardステートマシン、それを対象とするEventBridge Schedulerスケジュール、Bedrock `InvokeModel`の付与(5テスト)

```bash
npm test -w workspaces/aws-eol-monitor
```

このワークスペースには、スナップショット、コンプライアンス(`cdk-nag`)、インテグレーションのスイートはまだありません。

## ⚙️ カスタマイズ

### 要約の言語を切り替える

```typescript
report: { bedrockModelId: 'jp.anthropic.claude-sonnet-4-6', locale: 'en' }, // 'ja' | 'en'
```

### スケジュールや「間近」の閾値を変更する

```typescript
schedule: { scheduleExpression: 'cron(0 9 ? * MON *)', scheduleTimeZone: cdk.TimeZone.ASIA_TOKYO }, // 週次
collector: { upcomingThresholdDays: 90, /* ... */ },
```

### Slack/Teamsへの配信を追加する

`budgets-cost-anomaly-detection`ワークスペースと同様に、AWS ChatbotをSNSトピックに購読させます。

### 本番用パラメータセットを追加する

`dev`のパラメータセットのみ用意されています。`parameters/prd-params.ts`を追加して`parameters/index.ts`に登録し、`collector.datasetUrl`をタグに固定してください。

## ✅ 実機デプロイ検証

2026-09-27に実際のアカウント(`ap-northeast-1`)へデプロイし、エンドツーエンドで実行したうえでスタックを削除しました。確認した内容:

- `cdk deploy '**'`により両スタック(Data: DynamoDBテーブル、Application: 両Lambda・Standardステートマシン・SNSトピック・EventBridge Schedulerスケジュール)が問題なく作成された。
- ステートマシンを手動実行(`aws stepfunctions start-execution`、入力なし)し、実行履歴で`FetchEolDiff` → `HasDiff`(初回実行のため全バージョンが`NEW`となり「差分あり」分岐に進む) → `GenerateReport` → `PublishReport`の3タスクすべてが順に成功したことを確認。
- `GenerateReport`のCloudWatch Logsで、実際の約22秒のBedrock `ConverseCommand`呼び出しがエラーなく完了したことを確認。
- `PublishReport`(Step Functions標準のSNS連携)が実際の`MessageId`とHTTP 200を`sns:Publish`から受け取ったことを確認。
- 実行後、DynamoDBの状態テーブルに125件のアイテムが存在(追跡対象の`(serviceCode, version)`ペアごとに1件)。差分検知・状態書き込みのロジックを確認。
- **このデプロイで見つかり修正した不具合**: `parameters/dev-params.ts`の`report.bedrockModelId`が`apac.anthropic.claude-sonnet-4-5-20250929-v1:0`でしたが、この推論プロファイルIDは存在しません(`aws bedrock list-inference-profiles`で確認、また直接`bedrock-runtime converse`を呼び出しても失敗)。モデルIDは文字列にすぎないため、`cdk synth`やユニットテストではこの種の不具合を検出できず、実際のBedrock呼び出しでしか発見できません。現在は、このアカウント/リージョンで一覧・呼び出し可能なことを確認した`jp.anthropic.claude-sonnet-4-6`です。
- メール配信は**未検証**です。`notification.emails`はプレースホルダー(`dev-team@example.com`)のままにしたため、承認できる購読確認リンクがありません。`sns:Publish`の成功はパイプラインがSNSまで到達することを示します。実運用の前には、確認可能な実アドレスに置き換えてください。
- 対象外: `STATUS_CHANGED`/`UPCOMING_EOL`の差分タイプ(データセットの実データでは今回`NEW`のみが発生)、EventBridge Schedulerが実際にcronで起動すること(手動`start-execution`のみ使用)、`NoChangesDetected`分岐。

## 🔧 トラブルシューティング

### 問題: `GenerateReport`でBedrock呼び出しが失敗する

**症状**: 実行が`GenerateReport`で、検証エラーまたはアクセスエラーにより失敗する。

**解決策**:
1. `report.bedrockModelId`のIDがこのリージョンに存在し、そのモデルのアクセスが有効になっていることを確認する。
2. 推論プロファイルの場合、アカウントがそれを呼び出せる必要がある。IDを一覧と照合する。

```bash
aws bedrock list-inference-profiles --region ap-northeast-1
aws bedrock-runtime converse --model-id <bedrockModelId> \
  --messages '[{"role":"user","content":[{"text":"ping"}]}]' --region ap-northeast-1
```

### 問題: 要約が届かない

**症状**: `PublishReport`は成功するが、メールが届かない。

**解決策**:
1. 購読確認メールを承認する。未承認の購読には何も届かない。
2. プレースホルダーの`notification.emails`を実アドレスに置き換える。

### 問題: 初回の実行ですべてのバージョンが`NEW`になる

**症状**: 初回の要約が非常に大きい。

**解決策**: 想定どおりの動作です。初回は状態テーブルが空で、以降の実行では変化だけが報告されます。

### 問題: 上流の変更でパーサーが壊れる

**症状**: データセットのスキーマ変更後に`FetchEolDiff`が失敗する。

**解決策**: `collector.datasetUrl`を`main`ではなくタグ付きリリースに固定する。

## 📚 参考資料

### AWS公式ドキュメント

- [AWS Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html)
- [Amazon EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html)
- [Amazon Bedrock Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
- [Amazon Bedrock 推論プロファイル](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html)
- [Amazon SNS](https://docs.aws.amazon.com/sns/latest/dg/welcome.html)

### AWS Well-Architected

- [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)

### AWS CDK

- [AWS CDK API リファレンス](https://docs.aws.amazon.com/cdk/api/v2/)

### データソース

- [`awslabs/aws-service-eol-data`](https://github.com/awslabs/aws-service-eol-data)(このパイプラインが読み取る、コミュニティ管理のEOLデータセット)

### 関連アーキテクチャ

- [`budgets-cost-anomaly-detection`](../budgets-cost-anomaly-detection/)(上で触れた、AWS Chatbot経由のSlack/Teams配信パターン)

## 📄 ライセンス

このプロジェクトはApache License, Version 2.0の下でライセンスされています -- 詳細は[LICENSE](../../../LICENSE)ファイルを参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します。詳細は[コントリビューションガイド](../../../docs/contribution/CONTRIBUTING.md)を参照してください。

## 🏆 このリファレンスアーキテクチャについて

このリファレンスアーキテクチャは、スケジュール実行のサーバーレスな変更検知・通知パイプラインを構築するためのAWS CDKベストプラクティスを示しています。

**対象レベル**: 200(中級)

---

**注意**: これはリファレンス実装です。本番環境にデプロイする前に、必ず特定の要件および組織のポリシーに従ってレビューおよびカスタマイズしてください。
