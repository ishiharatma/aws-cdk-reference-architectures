# SNS Basic - AWS CDK リファレンスアーキテクチャ

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **レベル: 200（中級）**

1つの Amazon SNS トピックを、よく使われるサブスクリプションプロトコル（Email、SQS、Lambda、API Gateway 経由の HTTPS、Amazon Data Firehose）すべてにファンアウトし、さらに「CloudWatch Logs → Lambda → SNS → Lambda」という、SNS を軽量な内部アラート用のホップとして使う別チェーンも実装したパターンです。すべての Lambda は Python で実装し、ログレベル INFO・JSON 形式の構造化ログを出力します。

## 📑 目次

- [アーキテクチャ概要](#-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [コスト最適化](#-コスト最適化)
- [セキュリティ考慮事項](#-セキュリティ考慮事項)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [参考リンク](#-参考リンク)

## 🏗️ アーキテクチャ概要

![overview](overview.drawio.svg)

```text
MainTopic (SNS)
  ├─ Email サブスクリプション
  ├─ SQS（MessageQueue, DLQ付き）────────► Lambda: sqs-message-logger
  ├─ Lambda（直接サブスクリプション）────► Lambda: sns-message-logger
  ├─ HTTPS（API Gateway）───────────────► Lambda: sns-http-endpoint ──► S3 (PayloadBucket)
  │                                                                  └─► DynamoDB (PayloadTable)
  └─ Amazon Data Firehose ───────────────► S3 (FirehoseArchiveBucket)  ※Lambdaを介さない

AppLogGroup（CloudWatch Logs, デモ用ログソース）
  └─ サブスクリプションフィルタ ─────────► Lambda: cwlogs-to-sns
                                                 └─► LogAlertTopic (SNS)
                                                       └─ Lambda（直接サブスクリプション）─► Lambda: log-alert-notifier
```

### 主要コンポーネント

- **MainTopic (SNS)** – 4種類のサブスクリプションプロトコルを1つのトピックで並べて実演
- **MessageQueue (SQS + DLQ)** – 遅い/不安定なコンシューマをトピックから疎結合化。3回失敗するとデッドレターキューへ
- **API Gateway (REGIONAL) + Lambda** – SNS の HTTPS サブスクリプションを確認応答し、通知内容を S3 と DynamoDB に永続化
- **Amazon Data Firehose** – Lambda を介さずに、生メッセージをバッファリングしてバッチでS3に書き込み
- **AppLogGroup + サブスクリプションフィルタ** – デモ用の CloudWatch Logs ソースが、アラート専用の独立した2つ目の SNS トピックへ接続
- **Python Lambda 5関数** – `sqs-message-logger` / `sns-message-logger` / `log-alert-notifier` は受信ログを出力するだけ（INFO, JSON）。`sns-http-endpoint` と `cwlogs-to-sns` が実際の処理を担う

### アーキテクチャ特性

| 特性 | 値 | 根拠 |
|---|---|---|
| 可用性 | フルマネージド、デフォルトでマルチAZ | SNS/SQS/Lambda/API Gateway/DynamoDB/Firehose はすべてリージョナルなマネージドサービス |
| スケーラビリティ | 自動 | どこにもプロビジョニング容量なし（DynamoDBはPAY_PER_REQUEST、他は全て自動スケール） |
| セキュリティ | 転送時・保管時ともに全面暗号化 | SNS/SQS/S3 の `enforceSSL`、SNS 用 AWS 管理 KMS キー、DynamoDB の `TableEncryption.AWS_MANAGED` |
| コスト | 従量課金 | アイドル時の固定費用なし。詳細は[コスト最適化](#-コスト最適化)を参照 |

## 🎯 設計判断とベストプラクティス

### 1. SNS → API Gateway を HTTPS サブスクリプションとしてモデル化

**決定**: 「SNS → API Gateway → S3/DynamoDB」の経路を、API Gateway をトピックの前段に置くのではなく、API Gateway エンドポイントを指す SNS の **HTTPS サブスクリプション**（`UrlSubscription`）として実装する。

**根拠**:
- ✅ SNS が実際に任意の HTTP(S) エンドポイント（Webhook、サードパーティ連携）と統合する方法をそのまま体現できる
- ✅ API Gateway を純粋な「サブスクライバー用バックエンド」として保ち、他の HTTPS ベースのファンアウトにも再利用可能
- ✅ ほとんどの SNS Webhook 連携で実装が必要な、サブスクリプション確認のハンドシェイクを実演できる

**トレードオフ**:
- ❌ Lambda 側で `SubscriptionConfirmation`（`SubscribeURL` の取得）処理を実装する必要があり、単純な Lambda サブスクリプションよりコード量が増える
- ❌ SNS は HTTPS エンドポイントに対して IAM/Cognito 認可を使えないため、エンドポイントは事実上パブリックになる（[セキュリティ考慮事項](#-セキュリティ考慮事項)で緩和策を説明）

### 2. 「Lambdaなし」経路としての Firehose サブスクリプション

**決定**: Amazon Data Firehose の配信ストリームをトピックに直接サブスクライブ（`FirehoseSubscription`）し、生メッセージを S3 に格納する。

**根拠**:
- ✅ SNS のすべてのファンアウト経路に Lambda が必要なわけではないことを示せる。Firehose はカスタムコードなしでバッファリング・S3書き込みを行う
- ✅ 大量メッセージ時、Lambda-per-messageパターンよりメッセージ単価が低い
- ✅ Firehose 自体のバッファリング（`bufferingInterval`/`bufferingSize`）により S3 への PUT リクエスト数を削減

**トレードオフ**:
- ❌ 配信レイテンシはバッファリングウィンドウ（デフォルト60秒）に律速され、Lambda のような準リアルタイムにはならない
- ❌ Firehose の Lambda 変換を追加しない限りメッセージ単位の変換はできない（今回の「basic」パターンではスコープ外）

### 3. CloudWatch Logs チェーン専用の SNS トピックを別途用意

**決定**: `AppLogGroup → cwlogs-to-sns → LogAlertTopic → log-alert-notifier` は `MainTopic` に発行するのではなく、**専用**の SNS トピックを使う。

**根拠**:
- ✅ `MainTopic` にログアラートを発行すると、ログ1行ごとに Email・SQS・API Gateway・Firehose の全サブスクリプションが起動してしまい、意図した動作にならない
- ✅ 今回実演する2つのユースケース（複数プロトコルへのファンアウト／軽量な内部アラート）を独立してテストできる状態に保てる

### 4. メッセージ署名検証ではなく SubscribeURL/TopicArn の検証を採用

**決定**: `sns-http-endpoint` は、受信した `TopicArn` が期待するトピックと一致すること、`SubscribeURL` が本物の `sns.<region>.amazonaws.com` ホストを指していることを検証してから取得を行う。SNS メッセージ署名の完全な検証は行わない。

**根拠**:
- ✅ 偽装リクエストによって Lambda に任意の攻撃者制御下URLを取得させる SSRF（Server-Side Request Forgery）攻撃を防止できる
- ✅ サンプルを小さく、依存関係なしに保てる（署名検証には X.509 証明書の取得と RSA 検証が必要になる）

**トレードオフ**:
- ❌ リクエストが本当に SNS から送信されたことを完全には証明できない（本番運用時の推奨事項は[セキュリティ考慮事項](#-セキュリティ考慮事項)を参照）

### Well-Architected フレームワークとの対応

| 柱 | 実装内容 |
|---|---|
| **運用上の優秀性** | CloudFormation の出力に主要リソースのARN・URL・バケット/テーブル名・ロググループ名を出力し、デプロイ後の確認を容易にする |
| **セキュリティ** | 全体で `enforceSSL`、SNS の AWS 管理 KMS キー、S3 の完全パブリックアクセスブロック、DynamoDB PITR、公開エンドポイントでの TopicArn/SubscribeURL 検証 |
| **信頼性** | SQS DLQ（`maxReceiveCount: 3`）、Lambda イベントソースでバッチ全体の失敗ではなく部分的なバッチ失敗を報告 |
| **パフォーマンス効率** | 完全サーバーレス。Firehose のバッファリングにより大量データ時の S3 リクエスト数を削減 |
| **コスト最適化** | DynamoDB の `PAY_PER_REQUEST`、NAT Gateway/VPC 不使用、アイドルコンピュートなし |
| **持続可能性** | 常時稼働リソースなし。未使用時は全コンポーネントがゼロスケール |

## 💰 コスト最適化

### 月額コスト試算（ap-northeast-1、開発/テストの軽い利用 — 月あたり数千イベント程度）

```text
SNS（トピック2つ、パブリッシュ1,000件未満）:  無料枠内
SQS（MessageQueue + DLQ）:                    無料枠内
Lambda（5関数、1,000回未満の呼び出し）:       無料枠内
API Gateway REST（1,000リクエスト未満）:      ~$0.01
DynamoDB（オンデマンド、書き込み1,000件未満）: 無料枠内
S3（バケット2つ、1GB未満）:                   ~$0.03
Amazon Data Firehose（取り込み1GB未満）:       ~$0.03
CloudWatch Logs（ロググループ7つ、保持1週間）: ~$0.05
-------------------------------------------
合計（開発環境）:                              1ヶ月あたり1ドル未満
```

### 月額コスト試算（ap-northeast-1、月間約100万イベント）

```text
SNS（パブリッシュ100万件 + 配信100万件）:      ~$1.00
SQS（リクエスト100万件）:                      無料枠内（最初の100万件は無料）
Lambda（500万回呼び出し、128〜256MB）:         ~$1.00
API Gateway REST（100万リクエスト）:           ~$3.70
DynamoDB オンデマンド（書き込み100万WRU）:     ~$1.43
S3（ストレージ + PUTリクエスト）:              ~$0.50
Amazon Data Firehose（100万レコード、約1GB）:  ~$0.03
-------------------------------------------
合計:                                          1ヶ月あたり約8〜9ドル
```

*価格は上記リージョンにおける概算です。最新情報は必ず [AWS 料金見積りツール](https://calculator.aws/) で確認してください。*

### コスト最適化戦略

1. **DynamoDB の `PAY_PER_REQUEST`** — 低くスパイクのあるデモ用ワークロードに対して、容量のプロビジョニングや予測が不要
2. **Firehose のバッファリング** — 小さな SNS メッセージを多数まとめて少数の大きな S3 オブジェクトにし、大量データ時の S3 PUT リクエストコストを削減
3. **CloudWatch Logs の保持期間短縮**（開発は `ONE_WEEK`、本番は `ONE_MONTH`） — ログストレージの際限ない増加を防止
4. **NAT Gateway / VPC 不使用** — プライベートネットワークアクセスが不要なため全 Lambda を VPC 外で実行し、NAT Gateway の時間課金・データ処理課金を完全に回避

## 🔒 セキュリティ考慮事項

### ネットワークセキュリティ

1. **必要に迫られたパブリック HTTPS エンドポイント** – `sns-http-endpoint` は SNS からパブリックインターネット経由で到達可能である必要があります（SNS は VPC 内限定エンドポイントへの配信や、HTTP(S) サブスクリプションへの IAM 認可をサポートしません）。この露出はアプリケーションコード側で緩和しています。`TopicArn` が期待するトピックと一致すること、`SubscribeURL` が `sns.<region>.amazonaws.com` に解決されることを、Lambda が取得を行う前に検証しており、偽装リクエストによって任意の攻撃者制御下URLを取得してしまう SSRF 経路を塞いでいます。
2. **全面的な暗号化** – SNS トピックは AWS 管理の `alias/aws/sns` KMS キーを使用、SQS キューは `SQS_MANAGED` 暗号化、S3 バケットは `S3_MANAGED`（SSE-S3）、DynamoDB は `TableEncryption.AWS_MANAGED` を使用しています。
3. **`enforceSSL: true`** を両方の SNS トピック、両方の SQS キュー、両方の S3 バケットに設定し、リソースポリシーで非TLSリクエストを拒否しています。

### 実装済みのセキュリティベストプラクティス

- ✅ S3 バケットは全パブリックアクセスをブロック（`BlockPublicAccess.BLOCK_ALL`）
- ✅ DynamoDB のポイントインタイムリカバリ（PITR）を有効化
- ✅ SQS デッドレターキューでリトライ回数を制限（`maxReceiveCount: 3`）
- ✅ API Gateway のアクセスログを専用の CloudWatch Logs ロググループへ出力
- ✅ API Gateway のリクエストバリデータ（`validateRequestBody` + `validateRequestParameters`）を設定
- ✅ 最小権限の IAM: `grantWrite`/`grantWriteData`/`grantPublish` を特定のバケット/テーブル/トピックにスコープ（ワイルドカードリソースではない）
- ⚠️ **本番運用時の推奨事項**: `sns-http-endpoint` は `TopicArn` と `SubscribeURL` のホストを検証しますが、SNS メッセージ署名（`Signature`/`SigningCertURL`）の完全な検証は行っていません。本番利用時は [SNSメッセージ署名の検証](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html) を追加するか、[SNSメッセージデータ保護](https://docs.aws.amazon.com/sns/latest/dg/sns-message-data-protection.html) の利用を検討してください。

### CDK Nag 準拠

このスタックは `cdk-nag` の `AwsSolutionsChecks` に対して、根拠を明記した抑制のみで準拠しています（具体的なルールIDと理由は `test/compliance/cdk-nag.test.ts` を参照。例: パブリックWebhookエンドポイントに対する `AwsSolutions-APIG3`/`APIG4`/`COG4`、アクセスログ非設定のデモ用バケットに対する `AwsSolutions-S1` など）。

```bash
npm run test:compliance -w workspaces/sns-basic
```

## 📋 前提条件

- 適切な権限を持つ AWS アカウント
- AWS CLI v2.x のインストールと設定
- Node.js 20.x 以降
- AWS CDK 2.x（このワークスペースには `aws-cdk-lib` ^2.236 が同梱）
- Git

### 必要な IAM 権限

デプロイを行うユーザー/ロールには、以下の作成・管理権限が必要です。
- SNS（トピック、サブスクリプション）
- SQS（キュー）
- Lambda（関数、イベントソースマッピング）
- API Gateway（REST API、デプロイメント、ステージ）
- S3（バケット）
- DynamoDB（テーブル）
- Kinesis Data Firehose（配信ストリーム）
- CloudWatch Logs（ロググループ、サブスクリプションフィルタ）
- IAM（Lambda/Firehose用ロール）

## 🚀 デプロイ手順

### 1. クローンとセットアップ

```bash
cd infrastructure
npm install
```

### 2. 環境パラメータの設定

デプロイ前に `parameters/dev-params.ts` を編集するか環境変数を設定してください。Email サブスクライバーのアドレスはデフォルトでプレースホルダーです。

```bash
export NOTIFICATION_EMAIL="you@example.com"
```

プレースホルダーのままの場合、`bin/sns-basic.ts` が synth 時に警告を出力します。

### 3. デプロイ

```bash
export PROJECT_NAME=sns-basic
export ENV=dev
npm run bootstrap -w workspaces/sns-basic   # アカウント/リージョンごとに初回のみ
npm run deploy:all -w workspaces/sns-basic
```

### 4. デプロイの確認

```bash
# Email サブスクリプションを確認（受信トレイを確認し、確認リンクをクリック）

# メイントピックにテストメッセージを発行(全サブスクリプションに一斉配信される)
./publish-sns-message.sh --project sns-basic --env dev

# デモ用ロググループのサブスクリプションフィルタチェーンを確認:
# テストイベントを書き込んだ後、cwlogs-to-snsとlog-alert-notifier自身の
# CloudWatch Logsをポーリングし、CloudWatch Logs -> Lambda -> SNS -> Lambda が
# 実際に動作したことを確認する
./write-test-logs.sh --project sns-basic --env dev

# 保存された通知内容を確認
aws s3 ls s3://<出力されたPayloadBucketName>/notifications/
aws dynamodb scan --table-name <出力されたPayloadTableName>
```

## 🧪 テスト戦略

### テスト構成

```text
test/
├── snapshot/          # CloudFormationテンプレート全体 + リソース数のスナップショット
│   └── snapshot.test.ts
├── unit/               # リソース・プロパティ・関係性のきめ細かいアサーション
│   └── sns-basic.test.ts
└── compliance/         # cdk-nag AwsSolutions チェック
    └── cdk-nag.test.ts
```

### 1. スナップショットテスト

**目的**: リファクタリング時に意図しない CloudFormation テンプレートの変更を検知する。

```bash
npm run test:snapshot -w workspaces/sns-basic
npm run test:snapshot:update -w workspaces/sns-basic   # 意図した変更を行った後
```

### 2. Unit テスト

**目的**: アーキテクチャの各分岐が期待通りのリソース・プロパティ・関係性を生成することを確認する。

**テストカテゴリ**（15テスト）:
- ✅ SNS トピック（暗号化、SSL強制、5種類全てのサブスクリプションプロトコル）
- ✅ SQS 分岐（DLQ、SSL、部分バッチ失敗報告付きイベントソースマッピング）
- ✅ Lambda 関数（JSON/INFO ログ設定、Python 3.14 ランタイム）
- ✅ API Gateway → S3 + DynamoDB 分岐（リージョナルエンドポイント、アクセスログ、リクエストバリデータ、PITR、パブリックアクセスブロック）
- ✅ Firehose → S3 分岐
- ✅ CloudWatch Logs → Lambda → SNS → Lambda チェーン

### 3. コンプライアンステスト

```bash
npm run test:compliance -w workspaces/sns-basic
```

### すべて実行

```bash
npm run build -w workspaces/sns-basic
npm test -w workspaces/sns-basic
npm run lint -w workspaces/sns-basic
```

## ⚙️ カスタマイズ

### Lambda のサイズ・タイムアウト・ログ保持期間の変更

```typescript
// parameters/dev-params.ts
snsBasic: {
    functionMemorySize: 256,
    functionTimeout: cdk.Duration.seconds(30),
    functionLogRetention: logs.RetentionDays.ONE_MONTH,
},
```

### アラートチェーンをトリガーする CloudWatch Logs イベントの絞り込み

```typescript
// parameters/dev-params.ts
snsBasic: {
    cwLogsFilterPattern: '?ERROR ?WARN',
},
```

### Firehose のバッファリング調整（レイテンシ vs S3リクエストコスト）

```typescript
// parameters/dev-params.ts
snsBasic: {
    firehoseBufferingInterval: cdk.Duration.seconds(300),
    firehoseBufferingSize: cdk.Size.mebibytes(5),
},
```

## 🔧 トラブルシューティング

### 問題: Email サブスクリプションにメッセージが届かない

**症状**: `aws sns publish` は成功するがメールが届かない。

**解決策**:
1. 受信トレイ（および迷惑メールフォルダ）で「AWS Notification - Subscription Confirmation」メールを確認し、確認リンクをクリックしてください。SNS の Email サブスクリプションは確認するまで有効になりません。
2. サブスクリプションの状態を確認:
```bash
aws sns list-subscriptions-by-topic --topic-arn <MainTopicArn>
```

### 問題: HTTPS サブスクリプションが "PendingConfirmation" のまま

**症状**: `aws sns list-subscriptions-by-topic` で HTTPS サブスクリプションの ARN が `PendingConfirmation` と表示される。

**解決策**:
1. `sns-http-endpoint` の CloudWatch Logs で `SubscribeURL` 取得時のエラーを確認する（Lambda はデフォルトで VPC 外実行のため、通常はそのまま外部アクセス可能）。
2. API Gateway のデプロイが成功し `/sns` リソースに到達可能か確認する:
```bash
curl -X POST <出力されたApiUrl> -d '{}'
```

### 問題: デプロイ時に「メールアドレスがプレースホルダーのまま」という警告が出る

**症状**: `change-me@example.com` に関する警告が表示される。

**解決策**:
1. デプロイ前に `NOTIFICATION_EMAIL` を設定するか、`parameters/dev-params.ts` / `parameters/prd-params.ts` を直接編集してください。

## 📚 参考リンク

### AWS ドキュメント
- [Amazon SNS の HTTP/HTTPS エンドポイントサブスクライバー](https://docs.aws.amazon.com/sns/latest/dg/sns-http-https-endpoint-as-subscriber.html)
- [Amazon SNS メッセージ署名の検証](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html)
- [SNS サブスクライバーとしての Amazon Data Firehose](https://docs.aws.amazon.com/sns/latest/dg/sns-firehose-as-subscriber.html)
- [CloudWatch Logs サブスクリプションフィルタ](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Subscriptions.html)
- [Lambda Advanced Logging Controls（JSON構造化ログ）](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs.html#monitoring-cloudwatchlogs-advanced)

### AWS Well-Architected
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)

### AWS CDK
- [aws-cdk-lib.aws_sns_subscriptions モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_sns_subscriptions-readme.html)
- [CDK ベストプラクティス](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)

### 関連アーキテクチャ
- [sqs-lambda-firehose](../sqs-lambda-firehose/) – 本パターンで使用している SQS → Lambda → Firehose → S3 経路をより深く扱う
- [cloudwatch-logs-s3-archive](../cloudwatch-logs-s3-archive/) – Firehose・エクスポートタスク・Lambda直接書き込みなど、CloudWatch Logs アーカイブパターンをさらに扱う

## 📄 ライセンス

このプロジェクトは MIT ライセンスの下で公開されています。詳細は [LICENSE](../../LICENSE) を参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します。詳細は [CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。

## 🏆 このリファレンスアーキテクチャについて

このリファレンスアーキテクチャは、本番運用可能なインフラストラクチャを構築するための AWS CDK ベストプラクティスを実演するものです。

**対象レベル**: 200（中級）

---

**注意**: これはリファレンス実装です。本番環境へデプロイする前に、必ず自身の要件と組織のポリシーに照らしてレビュー・カスタマイズしてください。
