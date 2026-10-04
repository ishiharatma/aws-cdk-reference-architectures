# Transit Gateway による集中インスペクション(AWS Network Firewall) - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

1つの **AWS Network Firewall** で、すべてのスポーク VPC の通信を検査します。インターネット向きの通信と、スポーク **間** の通信の両方です。独自のインターネット経路を持たない2つのスポーク VPC がすべての通信を **Transit Gateway** に送り、Transit Gateway はそれを **検査 VPC** に渡します。検査 VPC ではファイアウォールが許可したドメインだけを通し、east-west のルールを適用し、NAT ゲートウェイがインターネットへの出口になります。[`transit-gateway`](../transit-gateway/)(フルメッシュと共有 Egress)の直接の発展形で、インスペクションを加えたものです。

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

- **スポーク VPC A と B**: それぞれプライベートサブネット1つ(と Transit Gateway アタッチメント用の小さなサブネット)を持ち、デフォルトルートは Transit Gateway です。インターネットゲートウェイも NAT ゲートウェイもありません。A にクライアント、B に小さな HTTP サーバー(8080番)を置きます。インスタンスには SSM Session Manager 経由でのみ接続できます。
- **Transit Gateway**: デフォルトの関連付けと伝播は **無効** で、ルートテーブルは2つです。*スポーク* テーブルは `0.0.0.0/0` を検査 VPC のアタッチメントに向け、*検査* テーブルは各スポークの CIDR をそれぞれのアタッチメントに戻します。検査 VPC のアタッチメントは **アプライアンスモード** です。
- **検査 VPC**: 3つのサブネットを持ちます。`tgw`(アタッチメント。デフォルトルートはファイアウォールエンドポイント)、`firewall`(エンドポイント。デフォルトルートは NAT ゲートウェイ、スポークの CIDR は Transit Gateway へ戻す)、`public`(NAT ゲートウェイ。スポークの CIDR はファイアウォールエンドポイント経由で戻す)。
- **AWS Network Firewall**: ステートフルルールグループ2つを持つポリシーです。**ドメイン許可リスト**(HTTP ホストと TLS SNI、既定は `.amazonaws.com`)と、**east-west ルール**(スポーク間の TCP 8080 を通し、ICMP を破棄)。アラートログとフローログは CloudWatch Logs に出力します。
- **`test-inspection.sh`**: SSM 経由でスポークのインスタンス上で確認を実行し、ファイアウォールのアラートログを読みます。

## 🎯 設計判断とベストプラクティス

### 1. 2つの Transit Gateway ルートテーブルで、すべての通信をファイアウォール経由にする

ルートテーブルが1つだと、スポーク同士は直接通信できてしまいます。この構成ではスポークのテーブルに検査 VPC のアタッチメントへのデフォルトルートしかないため、スポーク間の通信でも、いったん Transit Gateway を出てファイアウォールを通り、戻ってきます。デフォルトの伝播を無効にしているので、アタッチメントがうっかり近道を作ることもありません。

### 2. アプライアンスモードで、通信の往復を同じファイアウォールエンドポイントに揃える

アプライアンスモードがないと、Transit Gateway は戻りの通信を別の AZ のアタッチメント経由で送ることがあり、片方向しか見えないステートフルファイアウォールはそれを破棄します。1 AZ なら起きませんが、この設定に費用はかからず、マルチ AZ ではこの設定が前提になります。

### 3. ドメイン許可リストは east-west を含むすべての HTTP と TLS に適用される

ステートフルのドメインリスト(`ALLOWLIST`)は、ホストが載っていない HTTP や TLS の通信を **宛先に関係なく** 破棄します。最初の east-west テスト `curl http://10.2.0.14:8080` はタイムアウトし、アラートログに理由が出ていました。`not matching any HTTP allowlisted FQDNs`(ホスト名が IP アドレスだったため)です。対処は、east-west のサービスに対する明示的な **`pass` ルール** で、エンジンは許可リストの破棄より先にこれを評価します。

```text
pass tcp 10.1.0.0/24 any <> 10.2.0.0/24 8080
```

スポーク間で動かすサービスには、このようなルールか、ドメインを基準にした別の設計が必要です。

### 4. ICMP の破棄は、プロトコル単位の east-west 制御

セキュリティグループは、スポーク間の ICMP を意図的に許可しています。それでも A から B への ping は100%ロスで失敗し、アラートログに `east-west ICMP blocked` が記録されます。判断したのがセキュリティグループではなくファイアウォールだと分かります。

### 5. 追加のテストなしで Egress の経路を証明する

2つのインスタンスは、VPC エンドポイントも、自分の VPC のインターネット経路もない状態で、SSM Session Manager に登録されました。SSM には `*.amazonaws.com` への到達が必要なので、登録の成功だけで経路全体が証明されます。スポーク、Transit Gateway、ファイアウォール、NAT ゲートウェイ、インターネット、そして許可リストが AWS のドメインを通していることです。

### 6. 1 AZ はコストの選択であり、設計ではない

ファイアウォールエンドポイントと NAT ゲートウェイを1つにして、リファレンスを安価にしています。本番では、AZ ごとにエンドポイントと NAT ゲートウェイ、アタッチメント用サブネット、検査 VPC の AZ ごとのルートテーブルが必要です。1つの AZ を失っても他の AZ の検査が止まらないようにするためです。

### 7. 環境別パラメータ

`parameters/<env>-params.ts` で、3つの CIDR、ファイアウォールの `HOME_NET`、許可するドメイン、east-west の TCP ポート、east-west の ICMP を破棄するか、ログの保持期間を設定します。

## 🏛️ Well-Architected との対応

| 柱 | この構成での対応 |
|---|---|
| 運用上の優秀性 | `test-inspection.sh` が実際の通信とアラートログでポリシーを検証、すべて CloudFormation 管理 |
| セキュリティ | ドメイン単位の Egress デフォルト拒否、検査される east-west 通信、スポークにインターネット経路もパブリックIPもない、SSH の代わりに SSM、暗号化した EBS、IMDSv2 |
| 信頼性 | アプライアンスモードと明示的なルーティング。ここでは1 AZ、本番では AZ ごとのエンドポイントと NAT ゲートウェイ |
| パフォーマンス効率 | VPC ごとにファイアウォールを置かず、共有の検査経路を使う |
| コスト最適化 | 1つのファイアウォールをすべてのスポークで共有する。コストは時間課金のエンドポイントが支配的(下記) |
| 持続可能性 | 共有インフラと、短時間だけ動かすテスト用インスタンス(t4g.nano、ARM64) |

## 💰 コスト最適化

`ap-northeast-1` の概算です(料金ページで確認してください)。

| 項目 | 目安 |
|---|---|
| Network Firewall エンドポイント(1 AZ) | 1時間あたり約0.4 USD + GB あたりの処理料金 |
| Transit Gateway アタッチメント(3つ) | 1時間あたり約0.15 USD + GB あたりのデータ料金 |
| NAT ゲートウェイ | 1時間あたり約0.06 USD + GB あたりの料金 |
| t4g.nano 2台 | 1時間あたり約0.01 USD |

合計は起動し続けると **1時間あたり約0.6 USD、月約450 USD** で、ほぼすべてが固定の時間課金です。約40分の検証は1 USD 未満でした。検証が終わったらスタックを削除してください。2 AZ にすると、ファイアウォールと NAT の料金はおよそ2倍になります。

## 🔒 セキュリティ上の考慮事項

### 実装済み

- スポークにインターネットゲートウェイも NAT ゲートウェイもパブリックIPもなく、すべての通信が検査されます。
- Egress は一覧のドメイン(HTTP ホストと TLS SNI)に限定し、それ以外は破棄してログに記録します。
- East-west の通信も検査し、宣言した TCP ポートだけを通して、ICMP は破棄します。
- インスタンスは SSM だけで管理し(キーペアも SSH もなし)、EBS は暗号化、IMDSv2 を必須にしています。
- ファイアウォールのアラートログとフローログは CloudWatch Logs に保存します。

### CDK Nag の抑制(理由付き)

| ルール | 理由 |
|---|---|
| AwsSolutions-IAM4 | AmazonSSMManagedInstanceCore は Session Manager 向けの AWS 推奨ポリシー |
| AwsSolutions-EC28 | 詳細モニタリングはインスタンスごとの課金。短時間のテスト用インスタンス |
| AwsSolutions-EC29 | 使い捨てのテスト用インスタンス。終了保護はクリーンアップの妨げになる |
| AwsSolutions-VPC7 | ファイアウォールのアラートログとフローログが対象の通信を網羅する。VPC フローログは重複する |

### スコープ外(環境ごとに追加)

TLS インスペクション(通信の復号には認証局が必要で、信頼モデルが変わる)、脅威インテリジェンスのマネージドルールグループ、AZ ごとのエンドポイント、ファイアウォールポリシーの変更管理。

## 📋 前提条件

- Node.js 24 以上、AWS CDK v2、CDK ブートストラップ済みの AWS アカウント
- `test-inspection.sh` 用の `aws` と `jq`。インスタンスには SSM 経由で接続するので、SSH の準備は不要です

## 🚀 デプロイ手順

```bash
export PROJECT=<project> ENV=dev
npm install
npm run stage:deploy:all -w workspaces/tgw-network-firewall-inspection   # 約9分
```

## 🧪 動作確認スクリプト

`./test-inspection.sh --project <project> --env <env>` は、2つのインスタンスが SSM に登録されるのを待ち、インスタンス上から次を確認します。

1. 許可したドメイン(`https://checkip.amazonaws.com`)が HTTP 200 を返す
2. 許可リストにないドメイン(`example.com`)がブロックされる
3. スポーク A からスポーク B への 8080 番の HTTP が通る
4. スポーク A からスポーク B への ICMP が破棄される
5. ブロックされたドメインと ICMP の両方が、ファイアウォールのアラートログに記録される

2026-10-04 に `ap-northeast-1` で検証し、すべて成功しました(east-west の `pass` ルールを追加した後。設計判断3を参照)。

## 🧪 テスト戦略

```bash
npm test -w workspaces/tgw-network-firewall-inspection
```

- **スナップショット**: テンプレート全体とリソース数。
- **ユニット**: Transit Gateway のルートテーブル、検査アタッチメントだけがアプライアンスモードであること、ドメイン許可リスト、east-west の pass と drop ルール、ステートフルエンジンへの転送、ログ設定、ファイアウォールエンドポイント経由のルーティング、インターネットゲートウェイと NAT ゲートウェイが1つずつであること、インスタンスの堅牢化。
- **コンプライアンス**: 上記の理由付きの CDK Nag `AwsSolutionsChecks`。

## ⚙️ カスタマイズ

| パラメータ | 意味 |
|---|---|
| `spokeACidr`、`spokeBCidr`、`inspectionCidr` | アドレス設計 |
| `homeNet` | ファイアウォールの `HOME_NET`。スポークを含むスーパーネット |
| `allowedDomains` | スポークが到達できるドメイン(先頭のドットはサブドメインに一致) |
| `eastWestAllowedTcpPorts` | スポーク間で許可する TCP ポート |
| `blockEastWestIcmp` | スポーク間の ICMP を破棄する |

## 🔧 トラブルシューティング

### East-west の HTTP がタイムアウトする

ドメイン許可リストが破棄しています。アラートログで `not matching any HTTP allowlisted FQDNs` を探し、サービスのポートを `eastWestAllowedTcpPorts` に追加してください。

### インスタンスが SSM に現れない

Egress の経路が壊れています。スポークの Transit Gateway へのデフォルトルート、スポークと検査の Transit Gateway ルート、ファイアウォールサブネットから NAT ゲートウェイへのルート、パブリックサブネットのファイアウォールエンドポイント経由の戻りルート、そして `.amazonaws.com` が許可リストにあることを確認してください。

### ファイアウォールエンドポイントの作成に数分かかる

ファイアウォールエンドポイントの作成には数分かかります。デプロイはその完了を待ちます。

### 戻りの通信が破棄される

AZ が複数ある場合、検査アタッチメントにアプライアンスモードが必要です。往復が同じファイアウォールエンドポイントを通るようにするためです。

## 🧹 クリーンアップ

```bash
npm run stage:destroy:all -w workspaces/tgw-network-firewall-inspection
```

## 📚 参考資料

- [Centralized inspection architecture with AWS Gateway Load Balancer and AWS Transit Gateway](https://aws.amazon.com/blogs/networking-and-content-delivery/centralized-inspection-architecture-with-aws-gateway-load-balancer-and-aws-transit-gateway/)
- [Deployment models for AWS Network Firewall with VPC routing enhancements](https://aws.amazon.com/blogs/networking-and-content-delivery/deployment-models-for-aws-network-firewall-with-vpc-routing-enhancements/)
- [Stateful domain list rule groups in AWS Network Firewall](https://docs.aws.amazon.com/network-firewall/latest/developerguide/stateful-rule-groups-domain-names.html)
- [Appliance mode on Transit Gateway](https://docs.aws.amazon.com/vpc/latest/tgw/transit-gateway-appliance-scenario.html)
