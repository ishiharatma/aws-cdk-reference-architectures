# Route 53 Resolver インバウンド/アウトバウンドエンドポイント - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **レベル: 300（上級）**

**Amazon Route 53 Resolver** のインバウンド/アウトバウンドエンドポイントを使ったハイブリッドDNSのリファレンスアーキテクチャです。検証用VPCがプライベートホストゾーン `system.example.com` と両エンドポイントを所有し、もう一方のVPCはオンプレミス相当として自前のBIND9 DNSサーバーを立て、単純なVPCピアリングで接続します。インバウンドエンドポイントの種別（`INBOUND` か、2025年6月に追加された `INBOUND_DELEGATION` か）はコード変更なしにパラメータで切り替えられます。

## 📑 目次

- [アーキテクチャ概要](#アーキテクチャ概要)
- [設計判断とベストプラクティス](#設計判断とベストプラクティス)
- [コスト最適化](#コスト最適化)
- [セキュリティ考慮事項](#セキュリティ考慮事項)
- [前提条件](#前提条件)
- [デプロイガイド](#デプロイガイド)
- [テスト戦略](#テスト戦略)
- [カスタマイズ](#カスタマイズ)
- [トラブルシューティング](#トラブルシューティング)
- [参考資料](#参考資料)

## 🏗️ アーキテクチャ概要

![Architecture Diagram](overview.drawio.svg)

```text
VerifyVpc 10.10.0.0/16 (2 AZ)                     OnPremVpc 10.20.0.0/16 (1 AZ)
├─ Public /24  (テストインスタンス)                 ├─ Public /24 (BIND9 EC2)
└─ Resolver /27 x2 AZ                              │    onprem.example.com の
    ├─ インバウンドエンドポイント (INBOUND | INBOUND_DELEGATION)  権威DNSサーバー
    └─ アウトバウンドエンドポイント (OUTBOUND) ─────┐  │
                                                   │  │
        VPC ピアリング（双方向でDNS解決を許可）      │  │
        ◄──────────────────────────────────────────┘

プライベートホストゾーン system.example.com  →  VerifyVpc に関連付け
  app.system.example.com  A  10.10.200.10                 （ローカルで応答）

Resolver Rule（FORWARD, domain=onprem.example.com）
  → アウトバウンドエンドポイント → BIND9のプライベートIP        （ピアリング経由で応答）
```

### 主要コンポーネント

| コンポーネント | 役割 |
|-----------|------|
| **`ResolverEndpointConstruct`** (`@common/constructs/route53/resolver-endpoint`) | `AWS::Route53Resolver::ResolverEndpoint` とそのセキュリティグループをラップ。`INBOUND` / `OUTBOUND` / `INBOUND_DELEGATION` の方向を扱い、委任時は `Protocols: [DO53]` を強制し、決定論的な静的IPの割当にも対応。両ワークスペースで再利用。 |
| **`VpcConstruct`** (`@common/constructs/vpc/vpc`) | `VerifyVpc`（`Public` + 専用の `Resolver` isolatedサブネットグループ）と `OnPremVpc`（`Public` のみ）を作成。NAT Gatewayなし。 |
| **`VpcPeering`** (`@common/constructs/vpc/vpc-peering`) | 単純なVPCピアリング接続。カスタムリソースで双方向に `AllowDnsResolutionFromRemoteVpc` を有効化し、各サブネットにルートを追加。 |
| **`TestInstance`** (`@common/constructs/ec2/ec2-testinstance`) | `VerifyVpc` のテストインスタンス、および `OnPremVpc` のBIND9によるオンプレミス相当DNSサーバー（同一コンストラクトにBIND9用user dataを渡して構成）。 |
| **プライベートホストゾーン** | `system.example.com`。`VerifyVpc` のみに関連付け、デモ用の `A` レコード（`app.system.example.com`）を1件保持。 |
| **Resolver FORWARDルール** | `onprem.example.com` へのクエリをアウトバウンドエンドポイント経由でBIND9インスタンスのプライベートIPへ転送。 |

### アーキテクチャ特性

| 特性 | 値 | 根拠 |
|-----------------|-------|-----------|
| 可用性 | Resolverエンドポイントは2AZ | Route 53 Resolverはエンドポイントごとに最低2サブネットを要求するため、2AZが最小構成。 |
| 接続方式 | Transit Gatewayではなく VPCピアリング | VPCが2つ・関係も1つのみのため、時間課金のないピアリングを採用。4VPC構成のTransit Gatewayケースは [`route53-phz-delegation`](../route53-phz-delegation/) ワークスペースを参照。 |
| セキュリティ | DNSトラフィックはピアVPCのCIDRのみに限定 | すべてのResolver/BIND9セキュリティグループは特定のピアCIDRに対してのみTCP/UDP 53を開放し、`0.0.0.0/0` は使用しない。 |
| コスト | NAT Gatewayなし | テスト/BIND9インスタンスはパブリックサブネットに置きSSMでアクセス。エンドポイント時間課金とENI課金のみが発生。 |

## 🧭 設計判断とベストプラクティス

### 1. インバウンドエンドポイントの種別はコード分岐ではなくパラメータ

**決定**: `params.inboundEndpointType`（`'DEFAULT' | 'DELEGATION'`）を、`ResolverEndpointConstruct` 内で直接 Resolverエンドポイントの `Direction`（`INBOUND` または `INBOUND_DELEGATION`）にマッピングする。他のリソースは変更しない。

**理由**: 2025年6月、AWSは `ResolverEndpoint` の方向（Direction）に `INBOUND` / `OUTBOUND` に加えて第三の選択肢 `INBOUND_DELEGATION` を追加した（[What's New](https://aws.amazon.com/about-aws/whats-new/2025/06/amazon-route-53-resolver-endpoints-dns-delegation-private-hosted-zones/)）。委任インバウンドエンドポイントを使うと、外部（オンプレミス）DNSサーバーが通常のNSレコードでサブドメインをRoute 53のプライベートホストゾーンに委任できるようになり、オンプレミス側リゾルバの運用者がサブドメインごとにコンディショナルフォワーディングルールを維持する必要がなくなる。両方向とも「自分のサブネットのENIでインバウンドDNSトラフィックを終端する」という点では似ているため、本ワークスペースではこれを純粋な設定値として扱う。パラメータを切り替えるだけで `cdk diff` は（後述のプロトコル制限を除けば）プロパティ1件の変更のみを示す。

**トレードオフ**: `Direction` の変更は（CloudFormationリファレンスの `Update requires: Replacement` の通り）リソースの置き換えを伴うため、デプロイ済みスタックでパラメータを切り替えるとエンドポイントが置き換わり、IPアドレスも変わる。

### 2. 委任エンドポイントはDo53のみ

**決定**: `direction === 'INBOUND_DELEGATION'` の場合、`ResolverEndpointConstruct` は常に `Protocols: ['DO53']` を強制する。

**理由**: `AWS::Route53Resolver::ResolverEndpoint` のCloudFormationリファレンスには「委任インバウンドエンドポイントではDo53のみ使用可能」と明記されている。DoH / DoH-FIPSはデフォルトインバウンドエンドポイントでのみ有効。これをコンストラクト側で固定化することで、呼び出し側が誤って無効な組み合わせをリクエストできないようにしている。

### 3. アウトバウンドエンドポイントは通常のFORWARDルールを使用（委任ではない）

**決定**: `onprem.example.com` → BIND9 の経路には、明示的な `TargetIps` を持つ `RuleType: FORWARD` を使用し、新しい `RuleType: DELEGATE` は使わない。

**理由**: `DELEGATE` ルールは、Route 53が所有するゾーンに既に存在するNS＋グルーレコードを介して転送先を解決する仕組みである（この仕組みをRoute 53同士の委任のために丸ごと実装しているのが [`route53-phz-delegation`](../route53-phz-delegation/) ワークスペース）。本ワークスペースでの転送先は、固定のプライベートIPを持つ従来型の自己管理DNSサーバーであり、まさに `FORWARD` が想定するユースケースそのものである。これにより本ワークスペースは「インバウンド委任の切り替え」の実演に集中でき、1つのスタックに両方向の委任機構を混在させずに済む。

### 4. Transit GatewayではなくVPCピアリング

**決定**: 2つのVPCは `VpcPeering`（`AWS::EC2::VPCPeeringConnection` 1本）で接続し、Transit Gatewayは使わない。

**理由**: ユーザー要件に明記されていた通り（「接続は簡単にVPCピアリングでいい」）。VPCが2つだけの場合はまさに、時間課金のないピアリングがTransit Gatewayのアタッチメント課金に勝るケースである。TGWが真価を発揮するのは同じ接続性を3つ目以降のVPCにも必要になったときであり、そのシナリオは [`route53-phz-delegation`](../route53-phz-delegation/) ワークスペースで実演している。

### 5. `ResolverEndpointConstruct` は `@common` に配置

`ec2.IVpc` + サブネット + 方向のみを受け取り、本ワークスペース固有のパラメータに依存しないため、`infrastructure/common/constructs/route53/` に置き、Route 53 Resolverを扱う両ワークスペースで共有している。

## 💰 コスト最適化

概算 **ap-northeast-1**、オンデマンド、24時間稼働想定。

| リソース | 数量 | 単価 | 月額目安 |
|----------|-----|------|----------|
| Resolverエンドポイント（インバウンド+アウトバウンド） | 2 | $0.125 / エンドポイント時間 | ~$182 |
| Resolverエンドポイント用ENI | 4 | エンドポイント課金に含まれる | $0 |
| 処理DNSクエリ | — | $0.40 / 100万クエリ | デモ規模では無視できる程度 |
| EC2 `t4g.nano`（テスト + BIND9） | 2 | $0.0042 / 時間（リージョン係数あり） | ~$6 |
| EBS gp3 8 GiB | 2 | $0.08 / GB月 | ~$1.3 |
| VPCピアリング | 1 | $0（時間課金なし） | $0 |
| **合計（アイドル時）** | | | **~$190 / 月** |

コスト削減の勘所:

- **エンドポイント時間課金が支配的**。姉妹ワークスペースのTransit Gatewayアタッチメント課金と同様、これはResolverエンドポイントに内在するコストであり設定では回避できない。検証が終わったら速やかに `cdk destroy` すること。
- NAT Gatewayは一切使用しない。テスト/BIND9インスタンスはインターネットゲートウェイとSSMのみで足りる。
- VPCピアリングはTransit Gatewayと異なり時間課金が発生しない（[設計判断4](#4-transit-gatewayではなくvpcピアリング) 参照）。

## 🔒 セキュリティ考慮事項

| 制御 | 実装内容 |
|---------|----------------|
| **DNSトラフィックの範囲** | すべてのResolverエンドポイントおよびBIND9のセキュリティグループは、特定のピアVPC CIDRに対してのみTCP/UDP 53を開放し、`0.0.0.0/0` は使わない。ユニットテストで検証済み。 |
| **委任プロトコル制限** | `INBOUND_DELEGATION` エンドポイントは `ResolverEndpointConstruct` 内で `Protocols: ['DO53']` に固定。 |
| **インスタンスの堅牢化** | IMDSv2必須、EBS暗号化、長期的なSSH鍵の代わりにSSM Session Managerを使用。 |
| **最小権限IAM** | インスタンスには `AmazonSSMManagedInstanceCore` のみを付与。CDK Nag（`AwsSolutionsChecks`）をテストで実行し、すべての抑制はパスと理由付きでスコープしている。 |
| **ゾーンの分離** | `system.example.com` は *プライベート* ホストゾーンであり `VerifyVpc` にのみ関連付けている。VPC/ピアリング境界の外からは解決できない。 |
| **デフォルトSG** | リポジトリ全体で `@aws-cdk/aws-ec2:restrictDefaultSecurityGroup` を有効化しているため、各VPCのデフォルトSGは全トラフィックを拒否する。 |

本番環境での強化ポイント: コスト都合でデフォルト無効にしているVPC Flow Logsを有効化する。オンプレミスDNSサーバーが実際の外部エンドポイントである場合は、アウトバウンドエンドポイントの送信先セキュリティグループをピアVPC全体ではなく、そのサーバーの特定のIPに限定する。

## ✅ 前提条件

- Node.js 20以降、リポジトリのセットアップ済み（`infrastructure/` で `npm install`）
- AWSアカウントと、名前付きプロファイル `${PROJECT}-${ENV}`（例: `route53-resolver-endpoints-dev`）
- デプロイ先アカウント/リージョンでのCDKブートストラップ: `npm run bootstrap -w workspaces/route53-resolver-endpoints`

## 🚀 デプロイガイド

```bash
export PROJECT=route53-resolver-endpoints
export ENV=dev

# 1. 合成
npm run synth -w workspaces/route53-resolver-endpoints

# 2. デプロイ
npm run deploy:all -w workspaces/route53-resolver-endpoints

# 3. 検証（テスト戦略を参照）後、削除
npm run destroy:all -w workspaces/route53-resolver-endpoints
```

インバウンドエンドポイントを委任モードに切り替えるには、`parameters/dev-params.ts` の `inboundEndpointType` を `'DELEGATION'` にしてから再デプロイする。スタック出力の `InboundEndpointDirection` で現在のモードを確認でき、`InboundEndpoint/ResolverEndpointIps`（コンストラクトのCfnOutput）で、オンプレミス側のNSレコードが委任すべき2つの静的IPを確認できる。

## 🧪 テスト戦略

| 層 | ファイル | 検証内容 |
|-------|------|----------------|
| スナップショット | `test/snapshot/snapshot.test.ts` | テンプレート全体、およびリソース種別/数のスナップショット。 |
| ユニット | `test/unit/route53-resolver-endpoints-stack.test.ts` | 想定CIDRの2VPC、DNS解決が有効な1本のピアリング接続、プライベートホストゾーンとデモレコード、2AZ×2IPのResolverエンドポイント（インバウンド/アウトバウンド）、`inboundEndpointType` 設定時に `INBOUND_DELEGATION` + `Protocols: [DO53]` へ切り替わること、FORWARDルールと関連付け、DNSを `0.0.0.0/0` に開放するセキュリティグループが存在しないこと。 |
| コンプライアンス | `test/compliance/cdk-nag.test.ts` | `AwsSolutionsChecks` を実行し、スコープと理由を明記した抑制のみを許可。 |

```bash
npm test -w workspaces/route53-resolver-endpoints
npm run test:snapshot:update -w workspaces/route53-resolver-endpoints   # 意図した変更後に更新
```

### 手動でのDNS解決確認

```bash
# VerifyTestInstance にセッションを開く（IDはスタック出力から取得）
aws ssm start-session --target <VerifyTestInstance id> --profile route53-resolver-endpoints-dev

# プライベートホストゾーンで直接解決される
dig app.system.example.com +short          # → 10.10.200.10

# アウトバウンドエンドポイント + VPCピアリング経由でBIND9へ転送される
dig host1.onprem.example.com +short        # → BIND9インスタンスのプライベートIP
```

スタックが `CREATE_COMPLETE` になってから数秒以内にどちらも解決できるはず。

## ⚙️ カスタマイズ

| やりたいこと | 変更箇所 |
|------|--------|
| ゾーン名/ドメイン名を変更 | `parameters/dev-params.ts` の `privateHostedZoneName` / `onPremDomainName`。 |
| 委任をエンドツーエンドで試す | `inboundEndpointType: 'DELEGATION'` を設定し、実際のオンプレミスリゾルバで `InboundEndpoint` コンストラクトの静的IP（スタック出力を参照）へ向けたサブドメインのNSレコードを追加する。 |
| Resolverエンドポイントを増AZ化 | `verifyVpcConfig.createConfig.maxAzs` を増やす（Resolverエンドポイントは最大20 IPまでサブネット数に応じてスケール）。 |
| CIDRを変更 | `parameters/dev-params.ts` の `verifyVpcConfig` / `onPremVpcConfig`。 |
| エンドポイントコンストラクトを他で再利用 | `ResolverEndpointConstruct` は `vpc` / `subnets` / `direction` / `allowedCidrs` のみが必要で、本ワークスペースへの依存はない。 |

## 🔧 トラブルシューティング

| 症状 | 想定される原因 | 対処 |
|---------|--------------|-----|
| テストインスタンスから `dig app.system.example.com` が失敗する | プライベートホストゾーンがまだ関連付けられていない、または誤ったVPCから問い合わせている | インスタンスが `VerifyVpc` にあることを確認し、`aws route53 get-hosted-zone` でVPC関連付けを確認する。 |
| ローカルレコードは引けるのに `dig host1.onprem.example.com` が失敗する | ピアリングがまだ `active` でない、またはBIND9が起動していない | `aws ec2 describe-vpc-peering-connections` を確認し、SSM経由でBIND9インスタンスの `systemctl status named` を確認する。 |
| CloudFormation ValidateがResolverエンドポイントの `Name` について警告を出す | `[a-zA-Z0-9\-_ ]` 以外の文字が含まれている | `ResolverEndpointConstruct` はスラッシュを既にサニタイズ済み。`project`/`environment` に他の記号を含めた場合はサニタイズ処理を調整する。 |
| `inboundEndpointType` の切り替えでデプロイが失敗する | `Direction` の変更はリソース置き換えを伴い、置き換え前のエンドポイントARNへの参照が他に残っている可能性がある | CDK視点ではインプレースのスタック更新（内部でエンドポイントリソースが置き換わる）。停滞する場合は、自作の拡張部分に古い参照が残っていないか確認する。 |
| 変更後にCDK Nagのテストが失敗する | 新規リソースがルールに抵触 | `test/compliance/cdk-nag.test.ts` に**スコープと理由を明記した**抑制を追加する。既存の抑制を広げないこと。 |

## 📚 参考資料

- [Amazon Route 53 Resolver endpoints now support DNS delegation for private hosted zones（AWS What's New, 2025/06/24）](https://aws.amazon.com/about-aws/whats-new/2025/06/amazon-route-53-resolver-endpoints-dns-delegation-private-hosted-zones/)
- [AWS::Route53Resolver::ResolverEndpoint（CloudFormationリファレンス）](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53resolver-resolverendpoint.html)
- [AWS::Route53Resolver::ResolverRule（CloudFormationリファレンス）](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53resolver-resolverrule.html)
- [VPCとネットワーク間でのDNSクエリの解決](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver.html)
- 関連ワークスペース: [`route53-phz-delegation`](../route53-phz-delegation/) — Transit Gateway上でのRoute 53同士のプライベートホストゾーン委任（`RuleType: DELEGATE`）。
