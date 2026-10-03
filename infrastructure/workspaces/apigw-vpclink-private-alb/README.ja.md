# API Gateway + VPC Link + プライベートALB (ECS Fargate) - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

プライベートサブネットにあるサービスを **API Gateway だけを入口にして公開する** 構成です。APIキー、使用量プラン、スロットリングを備えた REST API を、**VPC Link (v2)** で **内部 Application Load Balancer** のリスナーに直接つなぎ、その背後に ECS Fargate のタスクを置きます。ALB にはパブリックなアドレスがないため、APIキーとスロットリングを迂回できません。

```text
クライアント --(x-api-key)--> REST API --VPC Link v2--> 内部ALB --> Fargateタスク(プライベートサブネット)
```

## 📑 目次

- [アーキテクチャ概要](#️-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [Well-Architected との対応](#️-well-architected-との対応)
- [コスト最適化](#-コスト最適化)
- [セキュリティ上の考慮事項](#-セキュリティ上の考慮事項)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [動作確認スクリプト](#-動作確認スクリプト)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#️-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![Architecture Diagram](overview.drawio.svg)

### 主要コンポーネント

- **VPC**: 2 AZ。パブリックサブネットには NAT ゲートウェイだけを置き、それ以外はすべてプライベートサブネットに置きます。デフォルトセキュリティグループは制限し、拒否された通信の Flow Logs を CloudWatch Logs に出力します。
- **ECS Fargate サービス**: プライベートサブネットで ARM64 のタスクを2つ起動します(ECR Public の nginx)。パブリックIPはなく、デプロイサーキットブレーカーでロールバックします。エントリポイントが `{"service":"backend","task":"<hostname>"}` を書き出すので、どのタスクが応答したか分かります。
- **内部 ALB**: スキームは `internal`、HTTP:80 のリスナーで、不正なヘッダーフィールドは破棄します。セキュリティグループは **VPC Link のセキュリティグループからの 80 番だけ** を許可し、タスクは ALB からの 80 番だけを許可します。
- **VPC Link (v2)**: `AWS::ApiGatewayV2::VpcLink`。プライベートサブネットに ENI を置き、専用のセキュリティグループ(ALB 宛ての送信だけ許可)を持ちます。
- **REST API**: `ANY /` と `ANY /{proxy+}` を VPC Link 経由の `HTTP_PROXY` 統合にし、`apiKeyRequired`、使用量プラン(レート、バースト、日次クォータ)、ステージのスロットリング、JSON アクセスログを設定します。
- **`test-api.sh`**: 上記の性質をデプロイ済みスタックに対して通しで確認するスクリプトです。

## 🎯 設計判断とベストプラクティス

### 1. API Gateway を唯一の入口にする

ALB は `internal` で、セキュリティグループの許可ルールは VPC Link のセキュリティグループ1つだけです。APIキーと使用量プランを迂回する経路がなく、後から閉じ忘れる心配もありません。パブリックな ALB に「API Gateway を許可する」ルールを置く方法では、API Gateway の送信元アドレスが固定でないため、この保証は得られません。

### 2. VPC Link v2 は ALB に直接つながる

従来の REST API 用 VPC Link(`AWS::ApiGateway::VpcLink`)は Network Load Balancer しか指定できず、ALB のバックエンドには前段に NLB が必要でした。VPC Link v2(`AWS::ApiGatewayV2::VpcLink`、HTTP API と同じリソース)を使うと、REST API の統合から余計なホップなしで ALB を指定できます。REST API 向けの CDK L2(`apigateway.VpcLink`)はこれに対応していないため、このスタックは L1 の Method に `addPropertyOverride` で3つのプロパティを設定します。

| プロパティ | 値 |
|---|---|
| `Integration.ConnectionType` | `VPC_LINK` |
| `Integration.ConnectionId` | v2 VPC Link の ID |
| `Integration.IntegrationTarget` | **ALB の ARN**(リスナーの ARN ではない) |

統合 URI は通常どおり `http://<alb-dns>/{proxy}` の形式のままです。URI はパスと `Host` ヘッダーを決め、通信の宛先は `IntegrationTarget` が決めます。

### 3. 使用量プランにはAPIキーが必要だが、APIキーは認証ではない

`apiKeyRequired` と使用量プランで、クライアントごとのスロットリングとクォータを設定できます。APIキーは計測のために呼び出し元を識別するもので、強い認証情報ではありません。エンドユーザーの認可には Authorizer を追加してください([`cognito-apigw-auth`](../cognito-apigw-auth/) を参照)。

### 4. 2段階のスロットリング

ステージのスロットリングは API 全体を、使用量プランはキーごとに上限を決めます。どちらも `EnvParams` から設定するので、スタックを変えずに dev は厳しく、本番は緩くできます。

### 5. VPC 内は HTTP

VPC Link から ALB までの通信は VPC の外に出ず、証明書にはドメインが必要なため、ALB のリスナーは HTTP にしています。すべての区間で転送時の暗号化が必要な場合は、ACM 証明書と HTTPS リスナーを追加し、統合の URI を `https://` にしてください。

### 6. 環境別パラメータ

`parameters/<env>-params.ts` で CIDR、NAT ゲートウェイ数、タスク数、使用量プランの上限を設定します。

## 🏛️ Well-Architected との対応

| 柱 | この構成での対応 |
|---|---|
| 運用上の優秀性 | CloudFormation 管理、`test-api.sh` による通し確認、API アクセスログ、タスクの awslogs、Container Insights |
| セキュリティ | 内部 ALB、セキュリティグループ同士の許可、タスクにパブリックIPなし、APIキーと使用量プラン、拒否通信の Flow Logs |
| 信頼性 | 2 AZ、2タスク、ALB ヘルスチェック、サーキットブレーカーによるロールバック、`minHealthyPercent: 100` |
| パフォーマンス効率 | ARM64 の Fargate、NLB のホップなし、リージョナルエンドポイント |
| コスト最適化 | dev では NAT ゲートウェイ1つ、小さなタスク、ARM64、ログ保持1週間(下記参照) |
| 持続可能性 | Graviton (ARM64) のタスク、0.25 vCPU / 0.5 GiB のサイズ |

## 💰 コスト最適化

`ap-northeast-1` で起動し続けた場合の月額の目安です(料金ページで確認してください)。

| 項目 | 目安 |
|---|---|
| NAT ゲートウェイ(1つ) | 約45 USD + データ処理料金 |
| Application Load Balancer | 約18 USD + LCU |
| Fargate 2 × (0.25 vCPU、0.5 GiB、ARM64) | 約18 USD |
| API Gateway REST API | 100万リクエスト単位の従量課金。検証では無視できる額 |
| VPC Link、ログ、Flow Logs | 少額 |

約15分の検証であれば数セントです。NAT ゲートウェイは、タスクが公開の nginx イメージを取得するためだけに置いています。自分の ECR リポジトリのイメージを使う場合は、ECR、S3、CloudWatch Logs の VPC エンドポイントで置き換えられます。

## 🔒 セキュリティ上の考慮事項

### 実装済み

- 内部 ALB。ALB、VPC Link、タスクのセキュリティグループは互いを参照し、CIDR による許可はありません。
- タスクはパブリックIPなしのプライベートサブネット。VPC のデフォルトセキュリティグループは制限済みです。
- すべてのメソッドで APIキーが必須。使用量プランとステージのスロットリングを設定しています。
- API アクセスログと、拒否通信の VPC Flow Logs。

### CDK Nag の抑制(理由付き)

| ルール | 理由 |
|---|---|
| AwsSolutions-IAM4 / IAM5 | ECS と API Gateway のログ出力に必要なマネージドポリシーとワイルドカード |
| AwsSolutions-ELB2 | VPC Link からのみ到達できる内部 ALB。アクセスログ用バケットはスコープ外 |
| AwsSolutions-ECS2 | コンテナの環境変数に機密情報や環境固有の値がない |
| AwsSolutions-APIG2 | 純粋なプロキシで、入力の検証はバックエンドが行う |
| AwsSolutions-APIG3 | WAFv2 の Web ACL は固定の月額費用がかかる。ここではキー、使用量プラン、スロットリングで濫用を抑える |
| AwsSolutions-APIG4 / COG4 | 呼び出し元は APIキーで識別する。エンドユーザー向けには Authorizer を追加する |

### スコープ外(環境ごとに追加)

ステージへの AWS WAF、Authorizer(Cognito または Lambda)、VPC Link と ALB 間の HTTPS、カスタムドメイン名。

## 📋 前提条件

- Node.js 24 以上、AWS CDK v2、CDK ブートストラップ済みの AWS アカウント
- `test-api.sh` 用の `aws`、`curl`、`jq`

## 🚀 デプロイ手順

```bash
export PROJECT=<project> ENV=dev
npm install
npm run stage:deploy:all -w workspaces/apigw-vpclink-private-alb   # 約4分
```

出力として、API URL、APIキーのID、(内部の)ALB の DNS 名が表示されます。

## 🧪 動作確認スクリプト

`./test-api.sh --project <project> --env <env>` は、スタックの出力を読み、APIキーを取得して次を確認します。

1. APIキーなしは `403`
2. APIキーありは VPC Link 経由で Fargate のタスクから `200`
3. 存在しないパスも転送され、バックエンドが `404` を返す
4. 2つのタスクの両方がリクエストを処理する
5. ALB のスキームが `internal` で、VPC の外からは応答しない
6. 60並列のバーストで `429` が返る

2026-10-03 に `ap-northeast-1` で検証し、すべて成功しました。

## 🧪 テスト戦略

```bash
npm test -w workspaces/apigw-vpclink-private-alb
```

- **スナップショット**: テンプレート全体とリソース数。
- **ユニット**: 内部 ALB、CIDR 許可のないセキュリティグループの連鎖、パブリックIPのないタスク、VPC Link の配置、すべてのメソッドが ALB の ARN を指定した VPC Link 経由で統合されること、全メソッドのAPIキー、使用量プランとステージのスロットリング。
- **コンプライアンス**: 上記の理由付きの CDK Nag `AwsSolutionsChecks`。

## ⚙️ カスタマイズ

| パラメータ | 意味 |
|---|---|
| `vpcCidr`、`natGateways` | ネットワークの規模。本番では AZ ごとに NAT ゲートウェイを1つ |
| `desiredCount` | タスク数 |
| `apiRateLimit`、`apiBurstLimit`、`apiDailyQuota` | ステージと使用量プランの上限 |

自分のアプリケーションを使うには、スタックのコンテナイメージとヘルスチェックのパスを置き換えます。

## 🔧 トラブルシューティング

### `... is not a valid ALB or NLB arn`

`IntegrationTarget` にリスナーの ARN を渡しています。ロードバランサーの ARN を渡してください。

### APIキーを付けても `403 Forbidden`

キーが使用量プランに関連付けられていないか、使用量プランにステージがありません。どちらもスタックが設定するため、`aws apigateway get-usage-plan-keys` で確認してください。日次クォータを使い切った場合も `403` になります。

### API から `504`

VPC Link から ALB に到達できていません。VPC Link のセキュリティグループに ALB 宛ての送信ルールがあるか、ALB のセキュリティグループに VPC Link からの受信ルールがあるかを確認してください。統合のタイムアウトは10秒です。

### `test-api.sh` のスロットリング確認で `429` が出ない

もう一度実行してください。スロットリングはステージごと、キーごとのトークンバケットなので、実行環境が遅いとバーストを超えないことがあります。

## 🧹 クリーンアップ

```bash
npm run stage:destroy:all -w workspaces/apigw-vpclink-private-alb
```

## 📚 参考資料

- [Private integrations for REST APIs in API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-private-integration.html)
- [Usage plans and API keys for REST APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html)
- [AWS::ApiGateway::Method Integration](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-apigateway-method-integration.html)
