# WAF Log Reporting - AWS CDK リファレンスアーキテクチャ

*他の言語で読む(Read this in other languages):* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **レベル: 300 (上級)**

「WAF Web ACL が何をブロックしたか（および Count モードで運用中のルールなら何をブロックしたはずか）」を日次でダイジェストするという同一の運用課題を、**CloudWatch Logs Insights**（パターン1）と **Amazon Athena**（パターン2）という異なる2つの方式で独立実装したリファレンスアーキテクチャです。両パターンにログを供給するためにスタンドアロンのサンプル WAF を作成しますが、各レポートスタックは既に運用中の WAF のログを対象にすることもできます。

## 📑 目次

- [アーキテクチャ概要](#-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [コスト最適化](#-コスト最適化)
- [セキュリティ考慮事項](#-セキュリティ考慮事項)
- [前提条件](#-前提条件)
- [デプロイガイド](#-デプロイガイド)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![overview](overview.drawio.svg)

```text
サンプル Web ACL（スタンドアロン、どのリソースにもアタッチしない）
  └─► CloudWatch Logs ロググループ "aws-waf-logs-*"
        │
        ├─ パターン1 ────────────────────────────────────────────────────
        │  EventBridge Scheduler（cron、日次）
        │    └─► Lambda: cwlogs-report（CloudWatch Logs Insights クエリ）
        │          └─► SNS Topic ──► Email
        │
        └─ パターン2 ────────────────────────────────────────────────────
           Subscription Filter ─► Kinesis Data Firehose ─► S3（Hive形式prefix）
             └─► Glue Table（パーティション射影、クローラー不要） + Athena Workgroup
                   ▲
                   │ EventBridge Scheduler（cron、日次）
                   └─► Lambda: athena-report（Athena SQL、CROSS JOIN UNNEST）
                         └─► SNS Topic ──► Email

いずれのレポートスタックも既存 WAF のログを対象にできます:
  cwLogsReport.existingLogGroupName  -> パターン1がそのロググループを直接参照
  athenaReport.existingSource        -> パターン2がそのS3ロケーション上にGlueテーブルを構築
                                         （AWS WAFネイティブのS3形式、または自前のFirehose/Hive形式のどちらも対応）
```

### 主要コンポーネント

- **スタック1 — `WafLogReportingSampleWafStack`** – ログを生成するためだけに作成する REGIONAL スコープの WAFv2 Web ACL。ALB / API Gateway / CloudFront のいずれにもアタッチしません。AWS マネージドルールグループを **Count** モードで1つ、**Block** モードで1つ、さらにレートベースの **Block** ルールを1つ組み合わせており、両レポートスタックが常に COUNT・BLOCK 両方のアクティビティを参照できます。
- **スタック2 — `WafLogReportingCwLogsReportStack`**（パターン1） – WAF ロググループに対して CloudWatch Logs Insights クエリを複数回実行し、整形したダイジェストを SNS に発行するスケジュール実行 Lambda。ロググループ以外の追加インフラは不要です。
- **スタック3 — `WafLogReportingAthenaReportStack`**（パターン2） – S3 上の WAF ログに対して構築した Glue Data Catalog テーブル（Athena パーティション射影、クローラー不要）に SQL を実行し、同じ形式のダイジェストを SNS に発行するスケジュール実行 Lambda。
- **レポート Lambda** – Python 製で、バイリンガル（`en`/`ja`）のテキストレポートを生成します。総リクエスト数、Action 別内訳、ブロックルール／送信元IP／国／URI の Top-N、Count モードルールマッチの Top-N（Block昇格候補）、前日比の異常検知フラグを含みます。

### アーキテクチャ特性

| 特性 | 値 | 根拠 |
|---|---|---|
| 可用性 | レポート経路に単一障害点なし、フルマネージド | EventBridge Scheduler、Lambda、SNS、CloudWatch Logs、S3、Glue、Athena はすべてリージョンのマネージドサービス |
| スケーラビリティ | パターン1はロググループへのクエリコストに、パターン2はS3/Athenaコストにスケール | 分岐点は[コスト最適化](#-コスト最適化)を参照 |
| セキュリティ | レポートごとに最小権限のIAM、転送時・保管時ともに暗号化 | IAMは特定のロググループ／Glueテーブル／AthenaワークグループのARNにスコープ、SNSはAWS管理KMSキー＋`enforceSSL`、S3は`BLOCK_ALL`でパブリックアクセスをブロック |
| コスト | 従量課金、常時稼働の固定インフラなし | NAT Gatewayなし、常時起動のコンピュートなし。詳細は[コスト最適化](#-コスト最適化) |

## 🎯 設計判断とベストプラクティス

### 1. 同一レポートを1つではなく2つの独立実装として提供

**決定**: パターン1（CloudWatch Logs Insights）とパターン2（Athena）を、同じ「形」のレポートを生成する独立デプロイ可能な2つのスタックとして提供し、どちらか一方を「最適解」として選定しません。

**根拠**:
- ✅ 2つの方式にはログ量・レイテンシ・精度の面で本質的に異なるトレードオフがあります（後述）。どちらが「正しい」かはログ量と保持期間に依存し、一方が客観的に優れているわけではありません
- ✅ 同一のサンプルWAFに対して両方をデプロイし、実際のレポートを並べて比較できます
- ✅ 同じ運用課題（WAF の Count/Block レポーティング）を、まったく異なる AWS サービスの組み合わせで解いた例を示せます

**トレードオフ**:
- ❌ 片方のパターンしか必要ない場合、単一パターン実装のおよそ2倍のインフラになります
- ❌ レポートのテキスト整形ロジックは、各 Lambda のデプロイパッケージを自己完結させるため、共通化せずに2つの Lambda 関数間で重複しています

### 2. Count と Block を混在させたスタンドアロンのサンプル Web ACL

**決定**: `WafLogReportingSampleWafStack` は、`AWSManagedRulesCommonRuleSet` を **Count** モードで、`AWSManagedRulesKnownBadInputsRuleSet` を **Block** モードで、レートベースルールを **Block** モードで組み合わせた単一の Web ACL を作成し、どのリソースにも関連付けません。

**根拠**:
- ✅ Block ルールしかない Web ACL ではレポートの「Countモード昇格候補」セクションを実演できず、Count ルールしかない Web ACL では BLOCK エントリが一切生成されません。両方を混在させることで、デプロイ直後から両セクションに興味深いデータが揃います
- ✅ 何にもアタッチしないことで、このスタック単体でデプロイ可能になります。パターンの動作確認のために ALB や API Gateway、CloudFront ディストリビューションを用意する必要はありません
- ✅ 「新しいマネージドルールグループをまず Count モードで動かし、既に信頼している既存ルールグループは Block モードのまま運用しつつ、昇格を判断する」という実運用でよくあるシナリオに合致します

**トレードオフ**:
- ❌ 何にもアタッチしないため、自分でトラフィックを発生させない限りサンプル Web ACL にはトラフィックが流れません（発生させる方法は[デプロイガイド](#-デプロイガイド)を参照）

### 3. 差し替え可能なレポート対象：サンプル Web ACL か既存 WAF か

**決定**: 両レポートスタックは、それぞれのサンプル Web ACL の代わりに既に保有しているログを対象にできる、オプションの「既存」パラメータ（`cwLogsReport.existingLogGroupName` / `athenaReport.existingSource`）を受け付けます。

**根拠**:
- ✅ このパターンの現実的なユースケースは、既に本番運用している WAF の上にレポートを追加することです。サンプル Web ACL は、このパターン単体でデプロイ・実演できるようにするためだけに存在します
- ✅ スタック間の参照は `Fn::ImportValue` ではなく**物理名**で解決しています（`cdk-ts-dev-guide` のクロススタック参照に関するガイダンスを参照）。`WafLogReportingSampleWafStack` はロググループに決定的なリテラル名（`aws-waf-logs-<project>-<env>`）を付けているため、レポートスタックはそれをプレーンな文字列 props として受け取れ、CloudFormation の export/import による結合が発生しません。既存ロググループ名への差し替えもスタック変更不要です
- ✅ `athenaReport.existingSource` は、既に持っている可能性が高い2種類の S3 レイアウトの両方に対応しています。AWS WAF ネイティブの直接 S3 ログ出力先（`AWSLogs/<account>/WAFLogs/<region>/<web-acl>/yyyy/MM/dd/HH/...`）と、自前の Firehose パイプラインによる Hive 形式レイアウトです（詳細は `lib/types/waf-log-reporting-params.ts` を参照）

**トレードオフ**:
- ❌ 「既存」モードを使う場合でもサンプル Web ACL スタックは常にデプロイされます。本番で「既存」モードのみを使う場合、`WafLogReportingSampleWafStack` は不要なリソースとして削除を検討してください

### 4. サブスクリプションフィルタによるリアルタイム処理ではなく日次スケジュールクエリ

**決定**: 両パターンとも **EventBridge Scheduler の cron**（デフォルト：日次）で動作し、クエリ実行時にログデータの範囲をまとめて取得します。`sns-basic` リファレンスアーキテクチャの `cwlogs-to-sns` チェーンで使われているような、ログイベントごとにリアルタイム反応する CloudWatch Logs サブスクリプションフィルタは使いません。

**根拠**:
- ✅ 日次「ダイジェスト」は個別イベントへのアラートではなく集計レポートです。「本日のブロックIP Top5」を計算するには、外部に状態を持たせない限り、1日分のデータをまとめて見る必要があります（サブスクリプションフィルタはログバッチごとに1回の Lambda 起動になり、これができません）
- ✅ WAF はデフォルトで評価した*すべて*のリクエストをログに残す高頻度ストリームになり得ますが、これをログバッチごとの Lambda 起動ではなく、日次1回のクエリにまとめてコンピュートコストを集約できます

**トレードオフ**:
- ❌ リアルタイムではありません。急増が見えるのは発生時ではなく次回のスケジュール実行時です（即時アラートが必要な場合は、Web ACL の `BlockedRequests` メトリクスに対する別途の CloudWatch アラームと組み合わせてください）

### 5. Glue クローラーではなく Athena パーティション射影

**決定**: `WafLogReportingAthenaReportStack` の両 Glue テーブルは、S3 をスキャンして自動検出する Glue クローラーではなく、既知の S3 キー構造から計算する[パーティション射影](https://docs.aws.amazon.com/athena/latest/ug/partition-projection.html)を使用します。

**根拠**:
- ✅ AWS WAF ネイティブの S3 ログレイアウトも、本スタック自身の Firehose 出力も、完全に予測可能な日付ベースのキー構造を持つため、S3 を一切リストすることなくパーティション射影でロケーションを計算できます
- ✅ クローラーのスケジューリング・課金・待機が一切不要です。新しいパーティション（本日分）は、データが到着した瞬間に追加のインフラなしでクエリ可能になります
- ✅ 何年もの日次クローラー実行で蓄積する Glue Data Catalog のパーティション数増加（およびそれに伴う `GetPartitions` のコスト・レイテンシ）を回避できます

**トレードオフ**:
- ❌ S3 キー構造が事前に既知かつ安定している必要があります。予測不能、あるいはクローラーでしか検出できないレイアウトには本物のクローラーが必要です

### 6. Countモードの正確な集計のための `CROSS JOIN UNNEST`

**決定**: Athena レポートの Count モードクエリ（`src/lambda/athena-report/index.py` の `query_count_mode_rules`）は `CROSS JOIN UNNEST(nonterminatingmatchingrules)` を使い、リクエストごとの**すべての** Count モードルールマッチを数えます。CloudWatch Logs Insights 版はリクエストごとの*最初の*マッチしか調べられません（Logs Insights には配列を展開する演算子がありません）。

**根拠**:
- ✅ 1つのリクエストが複数の Count モードルールに同時にマッチすることがあり、特定ルールを Block に昇格させて安全かを判断しようとしている場面でこそ、過小カウントが問題になります
- ✅ このリファレンスアーキテクチャの中で「Athena の SQL は Logs Insights のクエリ言語ではできないことができる」という主張を最も明確かつ具体的に示す例です。詳しい説明は両 Lambda 関数内のコードコメントを参照してください

**トレードオフ**:
- ❌ WAF ログの JSON スキーマと Presto/Athena の `UNNEST` 構文への理解が必要です。Logs Insights のよりシンプルな `stats ... by` 構文と比べると学習コストがあります

### Well-Architected フレームワークとの整合性

| Pillar | 実装内容 |
|---|---|
| **運用上の優秀性** | 各スタックが主要リソース名/ARNを `CfnOutput` として出力。レポート Lambda は INFO レベルで構造化JSONログを出力。レポート本文には常にどちらのエンジンが生成したかを明記 |
| **セキュリティ** | IAMは特定のロググループ／Glueテーブル／Athenaワークグループの ARN にスコープ（`*` は使用しない）、SNSはAWS管理KMSキー＋`enforceSSL`、S3は`BLOCK_ALL`でパブリックアクセスをブロック、WAF→CloudWatch Logs のリソースポリシーは特定のWeb ACL ARNにスコープ |
| **信頼性** | 両レポート Lambda はクエリステータスを一定のタイムアウトでポーリングし、非成功ステータスでは部分データを黙って報告せず例外を送出 |
| **パフォーマンス効率** | Athena パーティション射影はクエリ対象の日のみをスキャンし、ログ全履歴はスキャンしない。CloudWatch Logs Insights クエリは設定したレポート期間にバインド |
| **コスト最適化** | 待機コンピュートなし、Athenaクエリ結果のライフサイクル失効設定あり。パターン1とパターン2のログ量によるトレードオフは[コスト最適化](#-コスト最適化)を参照 |
| **持続可能性** | どちらのパターンにもプロビジョニング済み・常時稼働のキャパシティはなく、スケジュール実行の合間はすべてゼロにスケールダウン |

## 💰 コスト最適化

### 月額コスト試算（ap-northeast-1、サンプルWeb ACLのみ、軽量デモトラフィック）

```text
パターン1（CloudWatch Logs Insights）
  CloudWatch Logs 取り込み+保存（<100 MB）:      無料枠 / ~$0.05
  Logs Insights クエリ（月間~5 GBスキャン）:     ~$0.03
  Lambda + EventBridge Scheduler + SNS:          無料枠
  -------------------------------------------
  合計（パターン1、Dev）:                        月$1未満

パターン2（Athena）
  Firehose（<1 GB取り込み）:                     ~$0.03
  S3 ストレージ（<1 GB）:                        ~$0.02
  Athena（月間~1 GBスキャン）:                   ~$0.005
  Glue Data Catalog（1データベース、1テーブル）: 無料枠
  Lambda + EventBridge Scheduler + SNS:          無料枠
  -------------------------------------------
  合計（パターン2、Dev）:                        月$1未満
```

### 本番規模での月額コスト試算（例示: 1日1,000万リクエスト、1ログ行~1.2KB ⇒ 月間~360GBのWAFログ）

```text
パターン1（CloudWatch Logs Insights）
  CloudWatch Logs 取り込み（360GB）:      ~$270   （取り込み~$0.76/GB換算）
  CloudWatch Logs 保存（360GB）:          ~$12    （~$0.033/GB-月換算）
  Logs Insights クエリ（1日あたり~12GBスキャン、1日1回実行）: ~$2
  -------------------------------------------
  合計（パターン1、月間~360GB）:          月$280〜290

パターン2（Athena）
  Firehose 取り込み（360GB）:             ~$10    （~$0.029/GB換算）
  S3 ストレージ（360GB）:                 ~$8     （Standard、~$0.023/GB-月換算）
  Athena クエリ（1日あたり~12GBスキャン × ~6クエリ × 30日）: ~$13  （~$5/TBスキャン換算）
  Glue Data Catalog:                      無料枠
  -------------------------------------------
  合計（パターン2、月間~360GB）:          月$30〜35
```

*これらの数値はあくまで概算・例示です。CloudWatch Logs、S3、Firehose、Athenaの料金はリージョンや時期によって変動します。必ず[AWS Pricing Calculator](https://calculator.aws/)で最新の料金をご確認ください。リージョンや料金が変わっても頑健に成り立つのは、このトレードオフの「形」です。CloudWatch Logs の取り込み料金はクエリするかどうかに関わらず GB あたりで課金されるのに対し、パターン2はより安価な S3 のGBあたりストレージ料金と、Athenaのクエリスキャン量に応じた料金しか払わないため、ログ量が増えるほど2パターン間のコスト差は広がります。*

### コスト最適化戦略

1. **Glue クローラーではなくパーティション射影** — クローラーの継続コストがゼロで、新しいデータも即座にクエリ可能（[設計判断5](#5-glueクローラーではなくathenaパーティション射影)を参照）
2. **Athenaクエリ結果のライフサイクル失効設定**（`athenaReport.queryResultsExpirationDays`、デフォルトDev 7日 / Prod 30日） — クエリ結果用S3バケットのストレージコストを制限
3. **レポートLambda自身のロググループの保持期間を短く設定**（デフォルト`ONE_MONTH`） — WAFロググループ自体は実際の監査・保持要件に応じてサイジングしてください。（パターン1では）これがCloudWatch Logsのストレージコストに直接影響します
4. **ログ量が多くパターン1のCloudWatch Logs取り込みコストが問題になる場合はパターン2を優先** — 上記の本番規模比較を参照
5. **NAT Gateway / VPCなし** — どのLambdaもプライベートネットワークアクセスを必要としないためVPC外で実行

## 🔒 セキュリティ考慮事項

### ネットワークセキュリティ

このリファレンスアーキテクチャにはVPC常駐リソースが一切ありません。すべてのコンポーネント（Lambda、SNS、S3、Glue、Athena、CloudWatch Logs）はパブリックインターネット経由ではなくAWS API経由でアクセスするリージョンのマネージドサービスです。保護すべきインバウンドのネットワーク境界はありません。

### 実装済みのセキュリティベストプラクティス

- ✅ IAM最小権限: `logs:StartQuery` は対象ロググループの ARN にスコープ、`athena:*`/`glue:*` アクションは特定のワークグループ／データベース／テーブルの ARN にスコープ、`s3:GetObject`/`PutObject` の付与は該当するバケットにスコープ（本スタックが書き込むポリシーに `*` リソースは一切ありません）
- ✅ AWS WAF がログを書き込めるようにする CloudWatch Logs リソースポリシーは、「アカウント内の任意のWAF」ではなく、`aws:SourceArn` 条件で特定のWeb ACL ARNにスコープ
- ✅ SNSトピックは `enforceSSL: true` とAWS管理の `alias/aws/sns` KMSキーを使用
- ✅ S3バケットは全パブリックアクセスをブロック（`BlockPublicAccess.BLOCK_ALL`）、SSE-S3を使用、SSLを強制
- ✅ レポートLambdaは各レポートに必要な範囲以外のAWS APIアクセス権限を持たない（ワイルドカードのIAMアクションなし）

### CDK Nag Compliance

3つのスタックすべてが、ドキュメント化されたサプレッションのみで `cdk-nag` の `AwsSolutionsChecks` に準拠しています（正確なルールIDと理由は `test/compliance/cdk-nag.test.ts` を参照。例: CloudWatch Logs Insightsがロググループ ARN へのスコープをサポートしない `logs:GetQueryResults`/`StopQuery` の2アクションに対する `AwsSolutions-IAM5`、サーバーアクセスログを持たないデモ用S3バケットに対する `AwsSolutions-S1`）。

```bash
npm run test:compliance -w workspaces/waf-log-reporting
```

## 📋 前提条件

- 適切な権限を持つAWSアカウント
- AWS CLI v2.x のインストールと設定
- Node.js 20.x以降
- AWS CDK 2.x（`aws-cdk-lib` ^2.236、このワークスペースに同梱）
- Git

### 必要なIAM権限

デプロイを実行するユーザー/ロールには、以下を作成・管理する権限が必要です:
- WAFv2（Web ACL、ロギング設定）
- CloudWatch Logs（ロググループ、リソースポリシー、サブスクリプションフィルタ）
- Lambda（関数）
- EventBridge Scheduler（スケジュール）
- SNS（トピック、サブスクリプション）
- Kinesis Data Firehose（配信ストリーム）
- S3（バケット）
- Glue（データベース、テーブル）
- Athena（ワークグループ）
- IAM（Lambda/Firehose用ロール）

## 🚀 デプロイガイド

### 1. クローンとセットアップ

```bash
cd infrastructure
npm install
```

### 2. 環境パラメータの設定

デプロイ前に `parameters/dev-params.ts` を編集（または環境変数を設定）してください。両レポートトピックのメール購読先はデフォルトでプレースホルダーです:

```bash
export NOTIFICATION_EMAIL_CWLOGS="you@example.com"
export NOTIFICATION_EMAIL_ATHENA="you@example.com"
```

`bin/waf-log-reporting.ts` は、いずれかのプレースホルダーアドレスがまだ使われている場合、synth時に警告を出力します。既存のWAFを対象にする方法は[カスタマイズ](#-カスタマイズ)を参照してください。

### 3. デプロイ

```bash
export PROJECT_NAME=waf-log-reporting
export ENV=dev
npm run bootstrap -w workspaces/waf-log-reporting   # アカウント/リージョンごとに初回のみ
npm run deploy:all -w workspaces/waf-log-reporting
```

### 4. デプロイの確認

```bash
# 両方のEmailサブスクリプションを確認（受信トレイを確認し、各確認リンクをクリック）

# 両レポートにデータを持たせるため、サンプルWeb ACLに対してトラフィックを発生させます。
# Web ACLはどのリソースにもアタッチされていないため、AWS CLIによる
# GetSampledRequestsスタイルのテスト、または一時的にテスト用のALB/API Gateway
# ステージに関連付けてください。詳細は下記参考資料のAWS WAF「Web ACLのテスト」を参照。

# スケジュール実行前にレポートを手動実行:
aws lambda invoke --function-name <cwlogs-report Lambda name output> /dev/stdout
aws lambda invoke --function-name <athena-report Lambda name output> /dev/stdout
```

## 🧪 テスト戦略

### テスト構成

```text
test/
├── snapshot/          # 3スタックすべてのCloudFormationテンプレート全体+リソース数スナップショット
│   └── snapshot.test.ts
├── unit/               # スタックごとの詳細なリソース/プロパティ/関係性の検証
│   ├── sample-waf-stack.test.ts
│   ├── cwlogs-report-stack.test.ts
│   └── athena-report-stack.test.ts
└── compliance/         # cdk-nag AwsSolutionsチェック（スタックごとにdescribeブロック）
    └── cdk-nag.test.ts
```

### 1. スナップショットテスト

**目的**: リファクタリング時のCloudFormationテンプレートの意図しない変更を検知する。

```bash
npm run test:snapshot -w workspaces/waf-log-reporting
npm run test:snapshot:update -w workspaces/waf-log-reporting   # 意図した変更の後
```

### 2. ユニットテスト

**目的**: 各スタック（および「サンプル」対「既存」の対象モードそれぞれ）が期待通りのリソース・プロパティ・関係性を生成することを検証する。

**テストカテゴリ**（21テスト）:
- ✅ サンプルWeb ACL: REGIONALスコープ、Count/Blockの3ルールが正確に存在すること、ロググループ命名、リソースポリシーのスコープ、ロギング設定
- ✅ CloudWatch Logsレポート: デフォルトではサンプルロググループを対象にすること、`existingLogGroupName`設定時はそちらを対象にすること、SNSのSSL/KMS、IAMスコープ、EventBridge Scheduler
- ✅ Athenaレポート: サンプルモードでのFirehoseプロビジョニング（既存モードでは作成されないこと）、`existingSource`に応じたHive形式 対 ネイティブdate射影のパーティション切り替え、パーティション方式の環境変数、S3のパブリックアクセスブロック、ネイティブモードで情報不足時のバリデーションエラー

### 3. コンプライアンステスト

```bash
npm run test:compliance -w workspaces/waf-log-reporting
```

### すべて実行

```bash
npm run build -w workspaces/waf-log-reporting
npm test -w workspaces/waf-log-reporting
npm run lint -w workspaces/waf-log-reporting
```

## ⚙️ カスタマイズ

### パターン1を既存WAFのロググループに向ける

```typescript
// parameters/dev-params.ts
cwLogsReport: {
    existingLogGroupName: 'aws-waf-logs-my-existing-webacl',
},
```

### パターン2を既存WAFのS3ログに向ける

```typescript
// parameters/dev-params.ts
athenaReport: {
    existingSource: {
        bucketName: 'my-existing-waf-logs-bucket',
        webAclName: 'my-existing-webacl',        // AWS WAFネイティブのS3レイアウト
        // -- または、自前のFirehose/Hive形式パイプラインの場合 --
        // keyPrefix: 'my-firehose-prefix/',
        // hiveStylePartitioning: true,
    },
},
```

### レポート内容とスケジュールの調整

```typescript
// parameters/dev-params.ts
cwLogsReport: {
    topN: 10,                        // 各セクションTop-5ではなくTop-10
    anomalyThresholdPercent: 25,     // より小さな増加でも異常検知
    scheduleExpression: 'cron(0 21 * * ? *)',  // 00:00ではなく21:00
    locale: 'en',                    // 日本語ではなく英語のレポート本文
},
```

### サンプルWeb ACLのレート制限を変更

```typescript
// parameters/dev-params.ts
sampleWaf: {
    rateLimitPerIp: 500,   // 閾値を下げ、テスト中にBLOCKエントリを発生させやすくする
},
```

## 🔧 トラブルシューティング

### 問題: Athenaレポート Lambda が「テーブルが見つからない」で失敗する、または常に0件を返す

**症状**: `athena-report` Lambda がエラーになる、またはトラフィック発生後も `total` が常に0。

**解決策**:
1. サンプルモードでは、FirehoseはS3にフラッシュする前にバッファリングします（`firehoseBufferingInterval`、デフォルト60秒）。トラフィック発生後、少なくとも1バッファリング間隔待ってからレポートを実行してください。
2. 期待するプレフィックス配下に少なくとも1つオブジェクトが存在することを確認: `aws s3 ls s3://<WafLogsBucket>/waf-logs/ --recursive`。
3. パーティション射影は本日の日付からパーティションロケーションを計算します。クエリ対象日のデータがまだ存在しない場合、クエリは成功しますが0件を返します（これはエラーではなく想定動作です）。

### 問題: `cdk deploy` が CloudWatch Logs リソースポリシーの作成で失敗する

**症状**: `AWS::Logs::ResourcePolicy` の作成が上限関連のエラーで失敗する。

**解決策**:
1. CloudWatch Logs のリソースポリシーはアカウント/リージョンごとに10個までです。`aws logs describe-resource-policies` で既存のポリシーを確認し、不要なものを削除するか、既に他のWAF/サービス用のポリシーがある場合は `WafLogReportingSampleWafStack` を改修して再利用してください。

### 問題: Emailサブスクリプションが日次レポートを受信しない

**症状**: Lambdaは正常実行されている（CloudWatch Logsで確認）が、メールが届かない。

**解決策**:
1. 受信トレイ（および迷惑メールフォルダ）で「AWS Notification - Subscription Confirmation」メールを確認し、確認リンクをクリックしてください。SNSのEmailサブスクリプションは確認するまで有効になりません。
2. サブスクリプション状態を確認: `aws sns list-subscriptions-by-topic --topic-arn <ReportTopicArn output>`。

### 問題: `cdk deploy` がプレースホルダーの通知メールについて警告する

**症状**: `change-me@example.com` に関するsynth時の警告。

**解決策**:
1. デプロイ前に `NOTIFICATION_EMAIL_CWLOGS` / `NOTIFICATION_EMAIL_ATHENA` を設定するか、`parameters/dev-params.ts` / `parameters/prd-params.ts` を直接編集してください。

## 📚 参考資料

### AWS ドキュメント
- [AWS WAF logging destinations](https://docs.aws.amazon.com/waf/latest/developerguide/logging.html)
- [AWS WAF log fields](https://docs.aws.amazon.com/waf/latest/developerguide/logging-fields.html)
- [CloudWatch Logs Insights query syntax](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax.html)
- [Athena partition projection](https://docs.aws.amazon.com/athena/latest/ug/partition-projection.html)
- [Testing your AWS WAF Web ACL](https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-testing.html)

### AWS Well-Architected
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)

### AWS CDK
- [aws-cdk-lib.aws_wafv2 module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_wafv2-readme.html)
- [aws-cdk-lib.aws_glue module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_glue-readme.html)
- [CDK Best Practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)

### 関連オープンソース
- **Accompanist** — AWS WAF のログ解析を支援するオープンソースのコマンドラインツール。本レポートをよりリッチな、オフラインCLIベースの形にする場合の参考になります（未検証のURLを掲載しないため、リンクはしていません。直接検索してご確認ください）

### 関連アーキテクチャ
- [sns-basic](../sns-basic/) – このパターンのパターン1が土台とするシンプルな「CloudWatch Logs → Lambda → SNS」チェーン、およびパターン2のFirehose代替と比較できる直接Lambda書き込みパターン
- [cloudwatch-logs-s3-archive](../cloudwatch-logs-s3-archive/) – CloudWatch Logs → S3 アーカイブの汎用パターン（Firehose、エクスポートタスク、直接Lambda書き込み）。パターン2のFirehose部分の背景として有用
- [budgets-cost-anomaly-detection](../budgets-cost-anomaly-detection/) – WAFログの代わりにコストデータを対象とした、同様のスケジュール実行ダイジェスト→通知チャネルのパターン（EventBridge Scheduler → 演算 → 通知）

## 📄 ライセンス

このプロジェクトはMITライセンスの下で公開されています。詳細は [LICENSE](../../LICENSE) ファイルを参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します。詳細は [CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。

## 🏆 このリファレンスアーキテクチャについて

このリファレンスアーキテクチャは、本番運用可能なインフラを構築するためのAWS CDKベストプラクティスを示すものです。

**対象レベル**: 300（上級）

---

**注記**: これはリファレンス実装です。本番環境へのデプロイ前に、必ず組織の要件・ポリシーに応じてレビュー・カスタマイズしてください。
