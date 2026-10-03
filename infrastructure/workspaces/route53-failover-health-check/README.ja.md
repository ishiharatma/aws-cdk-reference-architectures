# Route 53 フェイルオーバールーティングとヘルスチェック - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 200](https://img.shields.io/badge/Level-200-yellow?style=flat-square)

**Amazon Route 53** による DNS フェイルオーバーの基本形です。**ヘルスチェック** が成功している間は **PRIMARY** レコードを返し、失敗すると **SECONDARY** レコードに切り替わります。エンドポイントには2つの Lambda 関数 URL を使うので、ドメイン名もロードバランサーもなしで動かせます。確認スクリプトがプライマリを停止させ、DNS が切り替わるまでの時間と、戻るまでの時間を測ります。

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

- **2つのエンドポイント**: 関数 URL を持つ Lambda 関数(Node.js 24、ARM64)です。`ROLE` でエンドポイントを区別し、`/health` は 200 を返します(`FAIL=true` の間は 503)。確認スクリプトがプライマリの `FAIL` を切り替えて、スタックに触れずに障害を再現します。
- **Route 53 ヘルスチェック**: HTTPS の 443 番ポート、パスは `/health`、SNI 有効、10秒間隔で、2回連続で失敗すると異常と判定します。
- **プライベートホストゾーン `failover.internal`**: NAT ゲートウェイなど課金されるリソースを持たない小さな VPC に関連付けます。
- **フェイルオーバーレコード**: `app.failover.internal` の CNAME(TTL 10秒)。`PRIMARY`(ヘルスチェック付き)と `SECONDARY`(ヘルスチェックなし、プライマリが異常のときだけ応答)です。
- **名前解決プローブ**: VPC 内の Lambda で、実際のクライアントと同じ VPC リゾルバー経由でレコードを引きます。
- **`test-failover.sh`**: プライマリを停止し、DNS が切り替わるのを待ち、復旧させて、元に戻るのを待ちます。

## 🎯 設計判断とベストプラクティス

### 1. フェイルオーバーは DNS の応答であり、接続のリダイレクトではない

Route 53 が変えるのは **返す値** です。古い応答をすでに持っているクライアントは TTL が切れるまでそれを使い続け、TTL より長くキャッシュするリゾルバーやアプリケーションもあります。切り替わりにかかる時間は、おおよそ「ヘルスチェックの検出時間 + レコードの TTL + クライアント側のキャッシュ」です。

| 要素 | このスタック | 影響 |
|---|---|---|
| チェック間隔 | 10秒(高速) | 検出の速さ |
| 失敗のしきい値 | 2回 | 検出の速さと誤検知のトレードオフ |
| レコードの TTL | 10秒 | クライアントが古い応答を保持する時間 |

実測の切り替え時間は [動作確認スクリプト](#-動作確認スクリプト) を参照してください。

### 2. ヘルスチェックは PRIMARY レコードに付ける

PRIMARY レコードにヘルスチェックを付けると、異常のとき Route 53 は SECONDARY を返します。SECONDARY にもヘルスチェックを付けると、両方が異常になったときに何も返さず、PRIMARY を返す(フェイルオープン)動作を把握しやすくなります。

### 3. プライベートホストゾーンと `test-dns-answer`

`aws route53 test-dns-answer` はプライベートホストゾーンを受け付けず、`Cannot send DNS query to a Private Hosted Zone` で失敗します。代わりに VPC 内の名前解決プローブを使うので、実際の解決経路をそのまま確認できます。パブリックホストゾーンなら `test-dns-answer` を使えますが、実クライアント向けには自分で管理するドメインが必要です。

### 4. ヘルスチェックは公開エンドポイントに到達できる必要がある

Route 53 のヘルスチェッカーは VPC の外で動くため、インターネットから到達できるエンドポイントが必要です。プライベートなエンドポイントには、CloudWatch アラームを使ったヘルスチェックを使います(エンドポイントが出すメトリクスをアラームが監視します)。

### 5. 関数 URL はデモ用

Route 53 はリクエストに署名できないため、エンドポイントは `AuthType: NONE` の公開関数 URL にし、固定の JSON だけを返します。本番では、ロードバランサー、CloudFront、API Gateway をエンドポイントにするのが一般的です。

### 6. 環境別パラメータ

`parameters/<env>-params.ts` で、ゾーン名とレコード名、TTL、チェック間隔(10秒または30秒)、失敗のしきい値を設定します。

## 🏛️ Well-Architected との対応

| 柱 | この構成での対応 |
|---|---|
| 運用上の優秀性 | `test-failover.sh` でフェイルオーバーとフェイルバックを計測、関数のログ、CloudFormation 管理 |
| セキュリティ | エンドポイントは固定のドキュメントだけを返す、名前解決プローブは分離サブネット、デフォルトセキュリティグループは制限済み |
| 信頼性 | ヘルスチェック付きのプライマリとセカンダリ、短い TTL、自動フェイルバック |
| パフォーマンス効率 | ARM64 の関数、経路にロードバランサーも NAT もなし |
| コスト最適化 | 従量課金の Lambda、NAT なし、ヘルスチェック1つ(下記参照) |
| 持続可能性 | サーバーレスのエンドポイントはゼロまでスケールする |

## 💰 コスト最適化

起動し続けた場合の月額の目安です(Route 53 の料金ページで確認してください)。

| 項目 | 目安 |
|---|---|
| ホストゾーン(プライベート) | 0.50 USD |
| ヘルスチェック(HTTPS、高速間隔) | 約2〜3 USD |
| Lambda、ログ | 検証では無視できる額 |

検証1回は数セントです。

## 🔒 セキュリティ上の考慮事項

### 実装済み

- 公開エンドポイントは固定の JSON だけを返します。`FAIL` と `ROLE` は環境変数で、リクエストの入力ではありません。
- 名前解決プローブはインターネットに出られません(分離サブネット、NAT なし)。
- VPC のデフォルトセキュリティグループを制限し、ログの保持期間は1週間です。

### CDK Nag の抑制(理由付き)

| ルール | 理由 |
|---|---|
| AwsSolutions-IAM4 | AWSLambdaBasicExecutionRole と VPC 実行用ポリシーは、Lambda 向けの AWS 推奨ポリシー |
| AwsSolutions-VPC7 | VPC はプライベートホストゾーンの関連付けのためだけにあり、記録すべき通信がない |
| AwsSolutions-L1 | ランタイムは作成時点でサポートされる最新の Node.js |

### スコープ外(環境ごとに追加)

ロードバランサー、CloudFront、API Gateway の背後にある実際のエンドポイント、ヘルスチェックの状態に対するアラームと通知、SECONDARY のヘルスチェック。

## 📋 前提条件

- Node.js 24 以上、AWS CDK v2、CDK ブートストラップ済みの AWS アカウント
- `test-failover.sh` 用の `aws`、`curl`、`jq`

## 🚀 デプロイ手順

```bash
export PROJECT=<project> ENV=dev
npm install
npm run stage:deploy:all -w workspaces/route53-failover-health-check   # 約3〜4分
```

## 🧪 動作確認スクリプト

`./test-failover.sh --project <project> --env <env>` は、スタックの出力を読んで次を行います。

1. レコードが(VPC 内で)プライマリに解決されるまで待つ
2. プライマリが `role=primary` を返すことを確認する
3. プライマリの `FAIL=true` を設定し、`/health` が 503 を返すことを確認する
4. レコードがセカンダリに解決されるまでの時間を測り、セカンダリが `role=secondary` を返すことを確認する
5. プライマリを復旧させ、レコードがプライマリに戻るまでの時間を測る

2026-10-03 に `ap-northeast-1` で検証しました(間隔10秒、しきい値2、TTL 10秒)。フェイルオーバーまで **29秒**、フェイルバックまで **18秒** でした。スクリプトは終了時に `FAIL=false` へ戻します。

## 🧪 テスト戦略

```bash
npm test -w workspaces/route53-failover-health-check
```

- **スナップショット**: テンプレート全体とリソース数。
- **ユニット**: エンドポイントと関数 URL、ヘルスチェックの設定、PRIMARY と SECONDARY のレコード、プライベートホストゾーン、VPC 内の名前解決プローブ、NAT ゲートウェイがないこと。
- **コンプライアンス**: 上記の理由付きの CDK Nag `AwsSolutionsChecks`。

## ⚙️ カスタマイズ

| パラメータ | 意味 |
|---|---|
| `zoneName`、`recordName` | プライベートゾーンとレコードの名前 |
| `recordTtl` | クライアントが応答をキャッシュしてよい秒数 |
| `healthCheckIntervalSeconds` | 10(高速、料金が高い)または30 |
| `healthCheckFailureThreshold` | フェイルオーバーするまでの連続失敗回数 |

## 🔧 トラブルシューティング

### `Cannot send DNS query to a Private Hosted Zone`

`test-dns-answer` はプライベートゾーンに対応していません。代わりに VPC 内(名前解決プローブ)から解決してください。

### フェイルオーバーが想定より遅い

検出に最大で `間隔 × しきい値`、それに TTL、さらに TTL を超えるクライアントやリゾルバーのキャッシュが加わります。

### エンドポイントが停止しているのに PRIMARY が返り続ける

ヘルスチェックが PRIMARY レコードに付いていないか、ヘルスチェックがインターネットからエンドポイントに到達できていません(その場合は最初から異常になります)。`aws route53 get-health-check-status` で確認してください。

## 🧹 クリーンアップ

```bash
npm run stage:destroy:all -w workspaces/route53-failover-health-check
```

## 📚 参考資料

- [Configuring DNS failover](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-configuring.html)
- [How Amazon Route 53 determines whether a health check is healthy](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-determining-health-of-endpoints.html)
- [Working with private hosted zones](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/hosted-zones-private.html)
