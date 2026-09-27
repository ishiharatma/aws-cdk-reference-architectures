# AWS Service EOL Monitor — Bedrock要約付きサーバーレスEOL監視

*他の言語で読む(Read this in other languages):* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-200-yellow?style=flat-square)

> **状態: draft（未デプロイ）。** `npm install`・`tsc --noEmit`・unitテスト・`cdk synth`はすべて成功しており、合成されたテンプレートのStep Functions定義とIAMポリシーも目視で確認済みです。ただし実際のAWSアカウントへの`cdk deploy`はまだ行っておらず、Bedrockモデルへの実アクセスやEventBridge Schedulerの実際の起動といった実行時の挙動は未検証です。利用の前に [Draft状態と注意点](#draft状態と注意点) を必ず確認してください。

## 概要

このプロジェクトは、[`awslabs/aws-service-eol-data`](https://github.com/awslabs/aws-service-eol-data)（EKS/RDSエンジン/Lambdaランタイム/ElastiCache/OpenSearchなどのバージョンライフサイクル終了日をまとめたJSONデータセット）を定期的に監視し、変化があれば優先度付きの要約をメールで通知するサーバーレスパイプラインです。

> このデータセットのREADMEには **"NOT AN OFFICIAL AWS API. This is a community-maintained dataset provided on a best-effort basis"**（公式のAWS APIではなく、ベストエフォートで提供されるコミュニティ管理のデータセット）、**"no guarantee of completeness, accuracy, or timeliness of updates"**（完全性・正確性・更新の即時性は保証されない）と明記されています。各エントリの`sourceUrl`はAWS公式ドキュメントへのリンクで、独自に検証するためのものです。何らかの判断を下す際に正とすべきは、このデータセットや後述の要約メールではなく、その`sourceUrl`先の公式ドキュメントです。詳細は[Draft状態と注意点](#draft状態と注意点)を参照してください。

```text
EventBridge Scheduler (cron)
  └─→ Step Functions (Standard)
        1. FetchEolDiff    – Lambda: eol.jsonを取得しDynamoDBの状態と比較、差分検知＋状態更新
        2. Choice: diffCount > 0 ?
             │ No  → NoChangesDetected (終了)
             │ Yes ▼
        3. GenerateReport  – Lambda: Bedrock(Claude)に差分を渡し、日本語/英語の
                              優先度付きMarkdown要約を生成
        4. PublishReport   – Step Functions標準のSNS連携タスクで通知
  └─→ SNSトピック → メール（Slack/Teams連携もbudgets-cost-anomaly-detection
      ワークスペースと同様の方法で追加可能）

DynamoDBテーブル (Dataスタック)
  PK serviceCode / SK version — status, standardSupportEnd, notifiedUpcoming, lastCheckedAt
```

### なぜ生データをそのまま流さず差分検知するのか

現状データセットは13サービス程度ですが、「毎回全件を取得してそのまま通知する」設計はスケールせず、通知を無視される原因になります。そこでDynamoDBテーブルに各`(serviceCode, version)`の最終状態を保存し、実際に変化があったものだけを報告します。

| 差分タイプ | 発生条件 |
| --- | --- |
| `NEW` | 初めて追跡対象になったバージョン |
| `STATUS_CHANGED` | `status`が変化(例: `STANDARD_SUPPORT` → `DEPRECATED`) |
| `UPCOMING_EOL` | `standardSupportEnd`が新たに`collector.upcomingThresholdDays`以内に入り、かつ未通知 |

`UPCOMING_EOL`はバージョンごとに一度だけ通知されます(DynamoDBの`notifiedUpcoming`フラグ)。閾値内にいる間、毎回通知が来るわけではありません。

### なぜ単純なSNS通知でなくBedrockを使うのか

Fetchステップの時点で差分は既に構造化されており、Lambdaで固定テンプレートに整形してSNSに流すだけでも多くのチームには十分で、その方が安価かつ決定論的です。ここでBedrockを使うのは、ユーザーが挙げたアイデアの1つ「Bedrock連携」を具体化するためで、構造化されたEOL情報を「専門家でなくても読める、優先度付きの説明文」に変換する部分をハードコードのロジックではなくLLMに任せています。プロンプトには差分JSONのみを事実として渡し、「データにない移行手順を創作しない」ことを明示的に指示しています(`src/lambda/generate-report/index.ts`参照)。

## アーキテクチャ概要

上記のパイプライン図を参照してください（このワークスペースは、動作検証が済むまで`overview.drawio.svg`の代わりにテキスト図を採用しています。詳細は[Draft状態と注意点](#draft状態と注意点)）。

### 主要コンポーネント

- **Dataスタック** — DynamoDBテーブル1つ(`TableV2`、オンデマンド課金、PITR有効)。差分検知の状態ストア。
- **Applicationスタック**
  - `FetchEolDiffFunction`(Node.js 22、arm64) — `fetch()`で`eol.json`を取得、状態テーブルをScanして差分を計算、新しい状態をupsert。
  - `GenerateReportFunction`(Node.js 22、arm64) — Bedrockの`ConverseCommand`に差分とロケール別プロンプトを渡し、`{ subject, body }`を返す。
  - **Standard**タイプのStep Functionsステートマシン(JSONPath)。2つのLambdaを`Choice`状態でつなぎ、ネイティブの`SnsPublish`タスクで通知(配信用の3つ目のLambdaは不要)。
  - **EventBridge Scheduler**スケジュール(cron＋タイムゾーン)がステートマシンを起動。
  - **SNSトピック**、`notification.emails`ごとにメールサブスクリプション。

### パラメータ (`parameters/dev-params.ts`)

| キー | 意味 |
| --- | --- |
| `collector.datasetUrl` | データセットの`data/eol.json`のRaw URL。サンプルでは`main`を指しているが、本番ではコミットSHA等に固定し、上流のスキーマ変更で突然パーサーが壊れないようにすべき。 |
| `collector.upcomingThresholdDays` | `standardSupportEnd`がこの日数以内なら`UPCOMING_EOL`として扱う。 |
| `schedule.scheduleExpression` / `scheduleTimeZone` | EventBridge Schedulerのcron式とIANAタイムゾーン。 |
| `report.bedrockModelId` | BedrockのモデルIDまたはクロスリージョン推論プロファイルID(対象アカウント/リージョンでモデルアクセスが有効になっている必要あり)。 |
| `report.locale` | `'ja'`または`'en'` — Bedrockプロンプトの言語とSNS件名の両方に影響。 |
| `notification.emails` | SNSのメール購読者。デプロイ前にプレースホルダーを実アドレスに置き換えること。 |

## デプロイ

```sh
# infrastructure/workspaces/aws-eol-monitor で実行
npm install
PROJECT=myproj ENV=dev npm run bootstrap   # アカウント/リージョンごとに一度だけ
PROJECT=myproj ENV=dev npm run deploy:all
```

デプロイ前に確認すること:

1. `parameters/dev-params.ts`を編集— 実際の`notification.emails`アドレス、アカウントでモデルアクセスが有効な`bedrockModelId`、そして`collector.datasetUrl`を`main`ではなく[タグ付きリリース](https://github.com/awslabs/aws-service-eol-data/tags)に固定する(データセット側のREADMEでも本番利用時の推奨事項として明記されている)。
2. 初回デプロイ後、SNSのメールサブスクリプション確認メールを承認する — 承認しない限り要約は届かない。
3. 対象リージョンでBedrockモデルのアクセス許可をまだリクエストしていない場合はリクエストする(Bedrockコンソール → モデルアクセス)。

## 使い方

スケジュールにより自動実行されます。任意のタイミングで試す場合は、Step Functionsコンソールから`<project>-<env>-eol-monitor`ステートマシンの実行を開始してください(入力は不要)。初回の実行では現在追跡中の全バージョンが`NEW`として報告されますが、これは想定どおりで一度だけ発生します。

## クリーンアップ

```sh
PROJECT=myproj ENV=dev npm run destroy:all
```

DynamoDBテーブルの`RemovalPolicy`は`isAutoDeleteObject`に従います(本番以外は削除、本番は保持)。`ENV=prd`環境で削除する前にスタックの内容を確認してください。

## 料金

Lambda(1回の実行あたり短時間の呼び出し2回)、Step Functions(Standard、実行あたり数ステート遷移)、EventBridge Scheduler(スケジュール1件)、DynamoDB(オンデマンド、少量アイテム)、SNS(メール)はいずれも低頻度な日次実行であれば無料利用枠の範囲内に収まることが多いです。Bedrock ClaudeのConverse呼び出しは入出力トークン単位で課金され、差分が検出された実行時のみ発生します — このアーキテクチャの主要なコストドライバーです。

[AWS 料金見積りツール](https://calculator.aws/#/estimate) — 本README には見積りリンクを固定していません。選択したBedrockモデル・リージョン・実行頻度に応じて見積りを作成してください。

## Draft状態と注意点

このワークスペースは合成(`cdk synth`)・単体テストまでは確認済みですが、実際のAWSアカウントへの**デプロイ・実行時の動作確認はまだ行っていません**。本番相当として扱う前に:

- 本セッションでは`npm install`・`tsc --noEmit`・`npm run test:unit`・`cdk synth`(ダミーの123456789012/ap-northeast-1環境に対して)まではすべて成功しています。ただし`cdk deploy`は未実行のため、Lambdaが実際に動いたことも、Bedrockを実際に呼び出したこともありません。
- `test/unit`はリソース形状の検証(Fine-grained Assertions)のみで、このリポジトリの他ワークスペースと異なりsnapshot/compliance(`cdk-nag`)/integrationテストは未追加です。
- `overview.drawio.svg`は未作成です。アーキテクチャがエンドツーエンドで検証されるまで、上記のテキスト図で代替しています。
- `parameters/dev-params.ts`の`report.bedrockModelId`はサンプル用のクロスリージョン推論プロファイルIDです。デプロイ前に、対象アカウントで実際に呼び出せる正確なIDを確認してください。
- ドラフト状態を反映して`dev`パラメータのみを用意しており、`prd-params.ts`は未作成です。
- `parameters/dev-params.ts`の`collector.datasetUrl`は簡略化のため`main`を指したままです。実際にデプロイする前に、必ずタグ付きリリースへ固定してください([概要](#概要)の注記を参照)。
