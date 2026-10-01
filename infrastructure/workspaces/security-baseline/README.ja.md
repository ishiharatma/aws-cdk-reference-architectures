# セキュリティベースライン: CloudTrail・Config・GuardDuty・Access Analyzer・Security Hub - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **レベル: 200（中級）**

> ✅ **実機デプロイ検証済み**（2026-10-01）。CloudTrail、AWS Config（レコーダー・配信チャネル・マネージドルール11個）、GuardDuty、IAM Access Analyzer、Security Hub のすべてを実際の AWS アカウントにデプロイし、AWS CLI による実機確認を経て、クリーンに破棄しました。検証の過程で実デプロイ時にしか見つからない不具合を2件発見・修正済みです。詳細は[観測結果](#-観測結果)を参照してください。

**単一アカウント向けのセキュリティベースライン**です。監査証跡（**CloudTrail**）、構成履歴とルール（**AWS Config**）、脅威検出（**GuardDuty**）、外部/未使用アクセスの分析（**IAM Access Analyzer**）、そして検出結果を一か所で読むための **Security Hub** を、1つの CDK スタックで構成します。**検出と通知までで、予防は行いません**。操作のブロックや検出結果の自動修復はせず、重大度の高い新しい検出結果は EventBridge と SNS でメール通知します。

| サービス | このスタックが作るもの |
|---|---|
| **CloudTrail** | マルチリージョン証跡 1 本（管理イベント、グローバルサービスイベント、ログファイル検証）→ S3（KMS 暗号化オブジェクト）と CloudWatch Logs |
| **AWS Config** | レコーダー（グローバルリソースを含む全サポート種別）、同じバケットへの配信チャネル、マネージドルール 11 個 |
| **GuardDuty** | S3、EBS マルウェア、RDS ログイン、Lambda ネットワークの各保護プランを持つ検出器（プランごとにパラメータ） |
| **IAM Access Analyzer** | アカウントスコープの外部アクセスアナライザー。任意で未使用アクセスアナライザー（有料、`dev` では無効） |
| **Security Hub** | AWS 基礎セキュリティのベストプラクティスを購読するハブ（追加の標準はパラメータ） |
| **通知** | 新規・アクティブな `CRITICAL`/`HIGH` の Security Hub 検出結果に対する EventBridge ルール → SNS トピック（CMK 暗号化、TLS 必須）→ メール。再試行と DLQ 付き |
| **ログアーカイブ** | プライベート・バージョニング有効・TLS 必須で、ライフサイクルによる期限切れを設定した S3 バケット 1 つと、ローテーション有効な CMK（検出結果のトピックの暗号化にも使用） |

## 📑 目次

- [アーキテクチャ概要](#-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [Well-Architected との対応](#-well-architected-との対応)
- [コスト最適化](#-コスト最適化)
- [セキュリティ考慮事項](#-セキュリティ考慮事項)
- [観測結果](#-観測結果)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#-カスタマイズ)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![アーキテクチャ図](overview.drawio.svg)

### 主なコンポーネント

- **`LogArchiveConstruct`** — 共有 S3 バケット（パブリックアクセスブロック、バージョニング、`enforceSSL`、バケット所有者強制、`logArchiveExpirationDays` 後の期限切れ）と KMS キー。
- **`CloudTrailConstruct`** — `cloudtrail.Trail`。マルチリージョン、`cloudtrail/` プレフィックスへ配信、ログファイルは CMK で暗号化、CloudWatch Logs のロググループの保持期間はパラメータ化。
- **`ConfigConstruct`** — レコーダーロール（AWS 管理の `AWS_ConfigRole`）、Config 配信用のバケットポリシー、レコーダー/配信チャネル/録画開始（`config/` プレフィックス、24 時間ごとのスナップショット。ネイティブの CFN リソースではなく `AwsCustomResource` による SDK 直接呼び出し — 理由は[観測結果](#-観測結果)参照）、マネージドルール。
- **`GuardDutyConstruct`**、**`AccessAnalyzerConstruct`**、**`SecurityHubConstruct`** — 検出器 1 つ、アナライザー最大 2 つ、ハブ 1 つと、購読する標準ごとに 1 つの `AWS::SecurityHub::Standard`。
- **`NotificationConstruct`** — Security Hub の検出結果に対するルール、SNS トピックとメール購読、配信できなかったイベント用の DLQ。暗号化したトピックに EventBridge が発行できるよう、CMK のキーポリシーも拡張します。
- **`SecurityBaselineStack`** — Construct を組み合わせて順序付けします。ハブより前に Config、GuardDuty、Access Analyzer を作成します。

### Config マネージドルール

`S3_BUCKET_LEVEL_PUBLIC_ACCESS_PROHIBITED`、`S3_BUCKET_PUBLIC_READ_PROHIBITED`、`S3_BUCKET_SSL_REQUESTS_ONLY`、`ROOT_ACCOUNT_MFA_ENABLED`、`IAM_ROOT_ACCESS_KEY_CHECK`、`IAM_USER_NO_POLICIES_CHECK`、`ACCESS_KEYS_ROTATED`、`CLOUD_TRAIL_ENABLED`、`EBS_ENCRYPTED_VOLUMES`、`RDS_STORAGE_ENCRYPTED`、`INCOMING_SSH_DISABLED`。

## 🎯 設計判断とベストプラクティス

### 1. 観測して人に知らせるだけで、何も変更しない

ここにあるサービスはすべて観測するだけです。ブロック（SCP などの予防的統制）も、修復（自動修復）も行いません。共有アカウントでリソースを勝手に変更するベースラインは、想定外の事故のもとです。外向きの動作は、重大度の高い新しい検出結果のメール通知だけです。それ以外は Security Hub で読みます。

### 2. CloudTrail と Config で 1 つのバケットを共有

アーカイブが 1 つなら、ライフサイクルもバケットポリシーも確認場所も 1 つで済みます。CloudTrail のオブジェクトは CMK で、Config のオブジェクトはバケット既定（SSE-S3）で暗号化されます。Config にも CMK を使うには、Config の配信経路に対するキーポリシーやグラントの変更が必要になるため、強化策として残しています。

### 3. 証跡はマルチリージョン、それ以外は 1 リージョン

証跡はマルチリージョンにしてもコストが小さく、「誰も見ていないリージョンでの操作」という抜け穴を塞げます。GuardDuty、Config、Security Hub、Access Analyzer は**リージョン単位**です。使うリージョンごとにスタックをデプロイするか、組織レベルの設計に移行してください（[カスタマイズ](#-カスタマイズ)参照）。

### 4. Security Hub は情報源のあとに作る

ハブは Config レコーダー（Security Hub のコントロールは Config のデータを読みます）、GuardDuty、Access Analyzer に依存させ、情報源が先に存在するようにしています。ハブの `enableDefaultStandards` は `false` にして、購読する標準がスタックで宣言したものだけになるようにしています。

### 5. 有料オプションはパラメータで、既定は安い側

GuardDuty の保護プランは個別の真偽値です。未使用アクセスアナライザーは分析対象の IAM ロールとユーザーごとに課金されるため、`dev` では**無効**です。Runtime Monitoring はエージェントの展開が必要で別の判断になるため、提供していません。

### 6. マネージドルールの識別子はテストで固定

各マネージドルールを `SourceIdentifier` で検証し、すべてのルールと配信チャネルがレコーダーに依存していることも検証しています。識別子の 1 つ（`INCOMING_SSH_DISABLED`）は CDK に定数がないため、文字列で渡しています。

### 7. Security Hub へのルール 1 本で全ソースをカバー

GuardDuty、AWS Config、IAM Access Analyzer の検出結果はすべて Security Hub に集まるため、Security Hub の検出結果に対するルール 1 本で全部を通知できます。対象は、設定した重大度（既定は `CRITICAL` と `HIGH`）の**新規かつアクティブ**な検出結果だけなので、あとで解決済みや抑制済みになったものが再び通知されることはありません。メッセージは生のイベントではなく、短いテキスト（重大度、タイトル、アカウント、リージョン、プロダクト、リソース、検出結果 ID）です。

### 8. トピックを暗号化するので、キーポリシーで EventBridge を許可する

カスタマーマネージドキーで暗号化した SNS トピックは、キーポリシーが `events.amazonaws.com` を許可している場合にだけ、EventBridge からのイベントを受け付けます。スタックはそのステートメントを追加します。条件はルールの ARN ではなくこのアカウント（`aws:SourceAccount`）にしています。ルール ARN にすると、キー → トピック → ルール → キーという循環依存になるためです。

### 9. 再試行は有限にして、その先は DLQ

トピックへの配信は最大 3 回、最長 60 分まで再試行し、それでも失敗したものは DLQ（SQS、SSE、TLS 必須、保持 14 日）に入ります。DLQ がなければ、配信の失敗で検出結果が黙って失われます。

### 10. 環境別パラメータ

`logArchiveExpirationDays`、`trailLogGroupRetentionDays`、`guardDuty.*`、`additionalSecurityHubStandardArns`、`enableUnusedAccessAnalyzer`、`unusedAccessAgeDays`、`notification.severities`、`notification.emails` を `parameters/<env>-params.ts` で指定します。

## 🏛️ Well-Architected との対応

| 柱 | 実装 |
|---|---|
| **運用上の優秀性** | すべてコード化。重大度の高い新しい検出結果をメール通知。Config の履歴で「何が変わったか」に答えられる。スナップショットとユニットテストで構成を固定 |
| **セキュリティ** | 整合性検証つきの監査証跡、ローテーション有効な CMK、プライベートで TLS 必須のアーカイブ、脅威検出、基礎セキュリティのベストプラクティス |
| **信頼性** | マルチリージョン証跡、バージョニング付きアーカイブ、通知の有限な再試行と DLQ、故障しうるコンピュートなし |
| **パフォーマンス効率** | マネージドサービスのみ。コンピュートなし |
| **コスト最適化** | 有料オプションはオプトインのパラメータ。ライフサイクルで保存量に上限 |
| **持続可能性** | コンピュートなし。保持期間はパラメータで制限 |

## 💰 コスト最適化

**月額の合計は記載していません。** これらのサービスの単価はリージョンや量によって異なります。コストを左右する要因は次のとおりです。

| サービス | 課金の対象 | 調整手段 |
|---|---|---|
| CloudTrail | 管理イベントの無料コピーを超えて配信されるイベント、ロググループの CloudWatch Logs 取り込みと保存 | 管理イベントのみ（データイベントなし）、`trailLogGroupRetentionDays` |
| AWS Config | 記録された構成項目とルール評価の数 | 全リソース種別の記録は、変更の多いアカウントで最も高くつく。記録対象やルールを絞る |
| GuardDuty | 保護プランごとの分析ログ/イベント量 | `guardDuty.*` の 4 つの真偽値 |
| Security Hub | セキュリティチェックと検出結果の取り込み | 購読する標準の数 |
| Access Analyzer | 外部アクセスは無料。未使用アクセスは分析した IAM ロール/ユーザーごと | `enableUnusedAccessAnalyzer` |
| S3 | ストレージ、リクエスト | `logArchiveExpirationDays` |
| EventBridge | デフォルトバス上の AWS サービスのイベントは EventBridge では課金されない | — |
| SNS / SQS | メール配信とリクエスト（想定する検出結果の量では小さい） | `notification.severities` の重大度フィルター |
| KMS | キーとリクエスト | — |

最新の単価は各料金ページで確認してください: [CloudTrail](https://aws.amazon.com/cloudtrail/pricing/)、[Config](https://aws.amazon.com/config/pricing/)、[GuardDuty](https://aws.amazon.com/guardduty/pricing/)、[Security Hub](https://aws.amazon.com/security-hub/pricing/)、[IAM Access Analyzer](https://aws.amazon.com/iam/access-analyzer/pricing/)。

## 🔒 セキュリティ考慮事項

### 実装済み
- ✅ CloudTrail のログファイル検証、ローテーション有効な CMK による暗号化、マルチリージョンでの記録
- ✅ アーカイブバケット: パブリックアクセスブロック、バージョニング、TLS 必須、バケット所有者強制
- ✅ Config の配信は `config.amazonaws.com` のみに許可し、対象はこのアカウント（`aws:SourceAccount`）、`bucket-owner-full-control`、`config/` プレフィックスのみ
- ✅ GuardDuty、Config、Access Analyzer の検出結果を Security Hub に集約
- ✅ 検出結果のトピックは CMK で暗号化し TLS 必須。キーポリシーは、このアカウントの EventBridge にのみ許可

### CDK Nag の抑制（理由つき）

| ルール | 対象 | 理由 |
|---|---|---|
| `AwsSolutions-S1` | アーカイブバケット | 監査ログの最終保管先であり、サーバーアクセスログを取るとログ用バケットがさらに必要になり、そのバケット自体にもログが必要になるため |
| `AwsSolutions-SQS3` | 検出結果の DLQ | 配信できなかった検出結果の最終的な保管先そのものなので、DLQ の DLQ は意味がないため |
| `AwsSolutions-IAM4` | Config レコーダーロール | `AWS_ConfigRole` は、レコーダーロール向けに AWS が公開している管理ポリシーで、新しいリソース種別に合わせて AWS が更新するため |

### 対象外（環境ごとに追加）
- **チャット連携**（AWS Chatbot / Slack）、ページング、**自動修復**
- **組織全体**での有効化（委任管理者、メンバーアカウントの自動有効化）
- **予防的**統制（SCP、Permission Boundary）と CloudTrail の**データイベント**
- Config への **CMK 適用**、アーカイブの S3 **Object Lock**

## ✅ 観測結果

2026-10-01 に実機で end-to-end 検証しました。`cdk deploy '**'` は `CREATE_COMPLETE` に到達し、各サービスを AWS CLI で実際に稼働していることを確認した上で、`cdk destroy '**'` でクリーンに破棄しました。`cdk synth`・ユニットテスト・スナップショットテスト・CDK Nag のいずれでも検出できず、実デプロイでしか見つからなかった不具合が2件ありました。

- **CloudTrail には KMS キーポリシーへの明示的な許可が必要です。** カスタマーマネージドキーを `cloudtrail.Trail` の `encryptionKey` に渡しても、CloudTrail がそのキーを使う権限は**自動的には付与されません**。`Trail` Construct が自動で管理するのはバケットポリシーだけで、キーポリシーには一切触れません。デプロイは `Insufficient permissions to access S3 bucket ... or KMS key ...` で失敗し、`CloudTrailConstruct` に `cloudtrail.amazonaws.com` 向けの `kms:GenerateDataKey*`（`kms:EncryptionContext:aws:cloudtrail:arn` で条件付け）と `kms:DescribeKey` のステートメントを追加して解決しました。`aws cloudtrail get-trail-status` が `IsLogging: true` を返すことで修正を確認済みです。
- **`AWS::Config::ConfigurationRecorder` / `AWS::Config::DeliveryChannel` は、そもそもネイティブの CloudFormation リソースとしては作成できません。** CloudFormation 自身のレコーダー用リソースハンドラーは、作成完了判定の内部処理として `StartConfigurationRecorder` を呼び出しますが、これには配信チャネルが先に存在している必要があります。一方で配信チャネル自体の作成には、レコーダーが先に存在している必要があります。どちらの宣言順でも両方の要求を同時に満たせません。後から作る方は即座に失敗し、先に作る方は最終的に `did not stabilize` で失敗します。これは全く別の2つの AWS アカウントで同一に再現したため、アカウント固有の偶発的事象ではないと判断しました。**対策**: `ConfigConstruct` は、ネイティブの `CfnConfigurationRecorder`/`CfnDeliveryChannel` の代わりに、3つの `AwsCustomResource` による SDK 直接呼び出し（実際に機能する唯一の順序）でレコーダー・配信チャネル・録画開始を作成するよう変更しました。根本原因の詳細（証拠となる CloudTrail の API 呼び出し順序）は [`docs/knowledge/aws-service-gotchas.md`](../../../docs/knowledge/aws-service-gotchas.md) を参照してください。
- 同じデプロイで見つかったもう一つの小さな不具合: マネージド Config ルール `ACCESS_KEYS_ROTATED` には `inputParameters: { maxAccessKeyAge: '90' }` の明示指定が必要です。指定がないと `required parameter [maxAccessKeyAge] is not present` で作成が失敗します。ルール識別子の名前からはこの要件は読み取れません。

実機で確認した内容（「スタックが `CREATE_COMPLETE` になった」以上の事実）:

| サービス | 確認方法 | 結果 |
|---|---|---|
| CloudTrail | `aws cloudtrail get-trail-status` | `IsLogging: true`、CloudWatch Logs への配信タイムスタンプあり |
| AWS Config | `aws configservice describe-configuration-recorder-status` | `"recording": true, "lastStatus": "SUCCESS"`。マネージドルール11個すべて作成済み |
| GuardDuty | `aws guardduty list-detectors` | 検出器1つが作成済み |
| IAM Access Analyzer | `aws accessanalyzer list-analyzers` | `status: ACTIVE`、ログアーカイブバケットを既に解析済み |
| Security Hub | `aws securityhub describe-hub` / `get-enabled-standards` | ハブは購読済み。AWS 基礎セキュリティのベストプラクティス標準は `PENDING`（有効化直後は正常な状態） |
| 破棄 | `cdk destroy '**'` 後に上記の `describe-*`/`list-*` を再実行 | すべてのリソースが消滅（Config のレコーダー/配信チャネルも、チャネル削除前にレコーダーを停止する形で正しく削除 — 上記の不具合の対策どおり） |

### 今回の検証で確認できていない点

- **通知のイベント形式は、実際の Security Hub 検出結果では確認していません。** EventBridge ルールはドキュメント記載の `Security Hub Findings - Imported` 形式に一致させていますが、今回の検証では GuardDuty のサンプル検出結果を生成してメール配信まで end-to-end で確認してはいません。
- **本番でのリソース保持。** `isAutoDeleteObject: false`（本番）ではスタック削除後もバケットとキーが残りますが、今回の検証は `isAutoDeleteObject: true`（`dev` の既定）でのみ行いました。
- **検証したのは1リージョン・1アカウントのみです。** ここにあるサービスはアカウント・リージョンごとのシングルトンです（[前提条件](#-前提条件)参照）。GuardDuty 検出器、Security Hub のハブ、Config のレコーダー/チャネルが既に存在するリージョン・アカウントへのデプロイはテストしていません（AWS のドキュメント通り、既に存在するエラーで失敗すると想定されます）。

## 📋 前提条件

- CDK をブートストラップ済みの AWS アカウント、`${PROJECT}-${ENV}` という名前のプロファイルを持つ AWS CLI v2、Node.js 20 以上
- 対象リージョンに GuardDuty 検出器、Security Hub のハブ、Config のレコーダー/配信チャネルが**存在しないこと**（これらはアカウント・リージョンごとのシングルトンです）

## 🚀 デプロイ手順

```bash
cd infrastructure
npm install
export PROJECT=<project> ENV=dev

npm run bootstrap        -w workspaces/security-baseline   # 初回のみ
npm run synth            -w workspaces/security-baseline
npm run stage:deploy:all -w workspaces/security-baseline
```

デプロイ後は、（`notification.emails` を設定した場合は）確認メールを承認し、Security Hub のコンソールで検出結果を確認します。GuardDuty の基礎的な検出には設定が不要です。検出結果をすぐ確認するには、GuardDuty コンソールのサンプル検出結果の機能が最も手早い方法です。

## 🧪 テスト戦略

```bash
npm test -w workspaces/security-baseline   # 36 件
```

| 種別 | 対象 |
|---|---|
| スナップショット（2） | テンプレート全体とリソース数 |
| ユニット（32） | アーカイブの堅牢化と環境ごとの削除ポリシー、証跡のプロパティと KMS キーポリシーへの許可、Config のレコーダー・チャネル・録画開始（`AwsCustomResource`）とその順序、`ACCESS_KEYS_ROTATED` の入力パラメータ、バケットポリシー・ルール、GuardDuty の機能（無効化した機能を含む）、2 種類のアナライザー、ハブ・標準・順序、検出結果ルールのパターン、重大度パラメータ、トピックの暗号化と TLS、EventBridge 向けキーポリシー、再試行と DLQ、メッセージのフィールド、購読、出力 |
| コンプライアンス（2） | CDK Nag `AwsSolutions` |

## 🔄 カスタマイズ

- **Config ルールの追加**: `lib/constructs/config-construct.ts` の `MANAGED_RULES` に識別子を追加します。
- **標準の追加**: `additionalSecurityHubStandardArns`（ARN は Security Hub コンソールから、対象リージョンのものをコピー）。
- **他のリージョン**: リージョンごとにスタックをデプロイします。
- **組織**: アカウントが多い場合は、アカウントごとのスタックではなく、委任管理者と組織レベルの有効化を使います。
- **通知**: `notification.emails` を設定し、`notification.severities` を広げたり絞ったりします。チャットに送るには、トピックに AWS Chatbot を購読させます。

## 🧹 クリーンアップ

```bash
npm run stage:destroy:all -w workspaces/security-baseline
```

アーカイブバケットとキーは、非本番（`isAutoDeleteObject: true`）では削除され、本番では残ります。

## 📚 参考資料

### AWS ドキュメント
- [AWS CloudTrail User Guide](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html)
- [AWS Config Developer Guide](https://docs.aws.amazon.com/config/latest/developerguide/WhatIsConfig.html)
- [Amazon GuardDuty User Guide](https://docs.aws.amazon.com/guardduty/latest/ug/what-is-guardduty.html)
- [IAM Access Analyzer](https://docs.aws.amazon.com/IAM/latest/UserGuide/what-is-access-analyzer.html)
- [AWS Security Hub](https://docs.aws.amazon.com/securityhub/latest/userguide/what-is-securityhub.html)

### 関連アーキテクチャ
- [iam-basics](../iam-basics/) — IAM ロール、ポリシー、ユーザー
- [s3-basics](../s3-basics/) — S3 バケットの堅牢化オプション
- [eventbridge-custom-bus](../eventbridge-custom-bus/) — EventBridge のルール、ターゲット、再試行、DLQ を掘り下げた例

## 📄 ライセンス

このプロジェクトは MIT ライセンスです。詳細は [LICENSE](../../LICENSE) を参照してください。

## 🏆 このリファレンスアーキテクチャについて

**対象レベル**: 200（中級）

---

**注意**: 実機デプロイ検証済みです（[観測結果](#-観測結果)参照）。本番で利用する前に、組織レベルの有効化と予防的統制を追加してください。
