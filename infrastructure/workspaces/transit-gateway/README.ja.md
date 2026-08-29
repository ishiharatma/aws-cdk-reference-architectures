# マルチVPC Transit Gateway - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **レベル: 300 (Advanced)**

**AWS Networking Workshop** の Transit Gateway ラボを、**シングルアカウント・シングルリージョン**で再現します。
3 つの VPC（A / B / C）を **1 つの Transit Gateway** と **明示的に管理する単一の Transit Gateway ルートテーブル** でフルメッシュに接続し、
各 VPC に SSM 管理のテスト用インスタンスを 1 台ずつ配置して疎通をエンドツーエンドで確認できるようにします。AWS Well-Architected Framework の 6 本の柱すべてに整合しています。

## 📑 目次

- [アーキテクチャ概要](#アーキテクチャ概要)
- [設計判断とベストプラクティス](#設計判断とベストプラクティス)
- [コスト最適化](#コスト最適化)
- [セキュリティ考慮事項](#セキュリティ考慮事項)
- [前提条件](#前提条件)
- [デプロイ手順](#デプロイ手順)
- [テスト戦略](#テスト戦略)
- [カスタマイズ](#カスタマイズ)
- [トラブルシューティング](#トラブルシューティング)
- [参考資料](#参考資料)

## 🏗️ アーキテクチャ概要

![アーキテクチャ図](overview.drawio.svg)

```text
AWS リージョン（既定は us-east-1。デプロイプロファイルのリージョンが優先）

  VPC A 10.0.0.0/16        VPC B 10.1.0.0/16        VPC C 10.2.0.0/16
  ├─ Public /24  x2 AZ     ├─ Public /24  x2 AZ     ├─ Public /24  x2 AZ
  │   └─ EC2 test          │   └─ EC2 test          │   └─ EC2 test
  └─ Tgw /28    x2 AZ      └─ Tgw /28    x2 AZ      └─ Tgw /28    x2 AZ
       │  (アタッチメント ENI)   │                        │
       └───────────────┬───────┴────────────┬───────────┘
                       │                    │
              ┌────────┴────────────────────┴────────┐
              │           Transit Gateway            │  ASN 64512
              │  デフォルト関連付け/伝播 = 無効       │
              ├──────────────────────────────────────┤
              │  TGW ルートテーブル（単一・共有）    │
              │   10.0.0.0/16 → VpcA アタッチメント   │  ← すべてのアタッチメントで
              │   10.1.0.0/16 → VpcB アタッチメント   │     関連付け + 伝播
              │   10.2.0.0/16 → VpcC アタッチメント   │
              └──────────────────────────────────────┘

  VPC ルートテーブル（Public + Tgw サブネット）に付与: <他 VPC の CIDR> → tgw-…
```

### 主要コンポーネント

| コンポーネント | 役割 |
|----------------|------|
| **`TransitGatewayConstruct`**（`@common/constructs/vpc/transit-gateway`） | Transit Gateway、共有 TGW ルートテーブル、VPC ごとのアタッチメント + 関連付け + 伝播を作成し、指定した VPC ルートテーブルへ `<対向 CIDR> → TGW` のルートを追加する。他ワークスペースからも再利用可能。 |
| **`VpcConstruct`**（`@common/constructs/vpc/vpc`） | 各 VPC を作成。`Public` サブネットグループ（テストインスタンス用）と、専用の `/28` `Tgw` isolated サブネットグループ（アタッチメント ENI 用）、2 AZ、NAT Gateway なし。 |
| **`TestInstance`**（`@common/constructs/ec2/ec2-testinstance`） | 各 VPC の Public サブネットに `t4g.nano` Amazon Linux 2023 を 1 台。IMDSv2 のみ、EBS 暗号化、SSM Session Manager で接続可能。 |
| **セキュリティグループ** | `10.0.0.0/8`（メッシュのスーパーネット）からの ICMP + SSH を許可し、**加えて** 運用者自身のグローバル IP `/32` からの SSH のみを許可。`0.0.0.0/0` は一切使わない。 |

### アーキテクチャの特性

| 特性 | 値 | 根拠 |
|------|----|------|
| 可用性 | マルチ AZ（2 AZ）アタッチメント | TGW の VPC アタッチメントは AZ ごとに 1 サブネットで終端する。2 AZ にすることで 1 AZ 障害時もデータ経路を維持。 |
| 拡張性 | ハブ&スポーク | VPC を 4 個目以降に増やすのはアタッチメント + 関連付け + 伝播を 1 組追加するだけ。ピアリングの `N(N-1)/2` 本は不要。 |
| セキュリティ | 最小権限 SG、専用アタッチメントサブネット | アタッチメント ENI はワークロードとルートテーブルを共有しない。SSH は自分の IP に固定。 |
| コスト | NAT Gateway なし、`t4g.nano`、フローログは既定オフ | 学習用スタックを安価に保つ。本番向けの切り替えポイントは後述。 |

## 🧭 設計判断とベストプラクティス

### 1. デフォルトルートテーブルではなく、明示管理の TGW ルートテーブルを 1 つ

**判断**: Transit Gateway を `DefaultRouteTableAssociation = disable`、`DefaultRouteTablePropagation = disable` で作成し、
`AWS::EC2::TransitGatewayRouteTable` を **1 つ** 作成。すべてのアタッチメントをそれに *関連付け*（受信トラフィックがこのテーブルで評価される）し、
*伝播*（その VPC の CIDR が他へ広告される）する。

**理由**: 暗黙のデフォルトルートテーブルは便利だが IaC からもコンソールの「ルートテーブル」一覧からも見えず、レビュー・タグ付け・差分確認ができない。
自前のルートテーブルにすればルーティングドメインが監査可能になり、将来のセグメント化（例: "prod" と "shared-services" のテーブル分割）の出発点になる。
3 つのアタッチメントを 1 つのテーブルに関連付け + 伝播すれば、最小の可動部品でフルメッシュになる。

**トレードオフ**: アタッチメントごとに CloudFormation リソースが 2 つ増える。無視できるコストであり、いずれ必要になる形。

### 2. ワークロードから隔離した専用 `/28` アタッチメントサブネット

**判断**: 各 VPC に `PRIVATE_ISOLATED` の `/28` サブネット（AZ ごとに 1 つ）からなる `Tgw` サブネットグループを持たせ、**アタッチメント ENI 専用** とする。
ワークロードは `Public` サブネットに置く。

**理由**: AWS のガイダンス自体が、アタッチメントには専用サブネットを与えてワークロードのルーティングと絡ませないことを推奨している。
`/28`（利用可能 11 IP）は ENI には十分で、アドレス空間を実サブネットに残せる。

### 3. 集約スーパーネットではなく、対向 CIDR ごとの個別ルート

**判断**: コンストラクトは各ルーティング対象サブネットのルートテーブルに、リモート VPC ごとの `<対向 VPC CIDR> → TGW` を 1 本ずつ追加する。
`10.0.0.0/8 → TGW` の 1 本にはしない。

**理由**: 広いスーパーネットルートは、将来プライベート IP で到達する同一リージョンのサービスが `10/8` に含まれる場合に、それを無言でブラックホール化する。
個別ルートなら誤設定の影響範囲をちょうど 1 VPC に閉じ込められ、`cdk diff` でどの到達性が変わったかが明確になる。
`10.0.0.0/8` という値はメッシュ内 ICMP/SSH を許可する **セキュリティグループ** ルールでのみ使う。そこでは SG が 2 段目のゲートなので広めでも許容できる。

### 4. テストインスタンスは Public サブネット、NAT Gateway なし

**判断**: `natCount: 0`。VPC ごとのテストインスタンスはパブリック IP 付きで Public サブネットに置く。

**理由**: インスタンスは Session Manager のために SSM エンドポイントへ外向き HTTPS が必要で、このスタックの目的は *TGW をパケットが越える様子を見る* ことであり本番ワークロードのモデル化ではない。
VPC ごとの NAT Gateway は学習上の価値なく約 $0.045/時 × 3 を上乗せするだけ。本番ワークロードは NAT 配下または VPC エンドポイント付きのプライベートサブネットへ（[カスタマイズ](#カスタマイズ)参照）。

### 5. `TransitGatewayConstruct` は `@common` に置く

引数は `ec2.IVpc` + サブネットリストのみで、このワークスペースのパラメータに依存しない。よって `vpc-peering.ts` と並べて
`infrastructure/common/constructs/vpc/` に置き、将来のどのアーキテクチャからも再利用できる。

## 💰 コスト最適化

**us-east-1**、オンデマンド、24×7 稼働の概算。データ処理は TGW への入出力それぞれ GB 単位で課金される。

| リソース | 数量 | 単価 | 月額概算 |
|----------|------|------|----------|
| Transit Gateway アタッチメント | 3 | $0.05 / アタッチメント時 | 約 $108 |
| Transit Gateway データ処理 | — | $0.02 / GB | $0.02 × 転送 GB |
| EC2 `t4g.nano` | 3 | $0.0042 / 時 | 約 $9 |
| EBS gp3 8 GiB | 3 | $0.08 / GB 月 | 約 $2 |
| Elastic IP（使用中） | 0 | — | $0 |
| **合計（アイドル時）** | | | **約 $120 / 月** |

コストの押さえどころ:

- **アタッチメント時間が支配的。** これは Transit Gateway の本質で、3 アタッチメントは 1 バイトも流れる前から約 $108/月。
  VPC ピアリングに時間課金はない。少数かつ静的な VPC 構成なら [`vpc-peering`](../vpc-peering/) の方が安い。VPC 数が増えるほど TGW が運用のシンプルさで勝る。
- 検証が終わったら即 `cdk destroy`。このスタックは短命前提。
- デモ中は `enableFlowLogsToCloudWatch: false`（既定）のまま。本番では VPC 単位で有効化し、CloudWatch Logs ではなくライフサイクルポリシー付きの S3 へ送る。
- Graviton の `t4g.nano` は既に下限。スタックを残す場合はセッションの合間にインスタンスを停止する。

## 🔒 セキュリティ考慮事項

| 対策 | 実装 |
|------|------|
| **SSH の露出** | テストインスタンスの SG は TCP 22 を運用者自身のグローバル IP `/32` のみから許可（`checkip.amazonaws.com` で自動検出、または `ALLOWED_IPS` を指定）。`0.0.0.0/0` を使うルールはなく、ユニットテストでそれを検証。 |
| **メッシュ内到達性** | `10.0.0.0/8` からの ICMP + TCP 22。3 VPC が占める RFC 1918 空間に意図的に限定し、インターネットは含めない。 |
| **アタッチメントの隔離** | ENI はインターネットへの経路を持たない専用 `PRIVATE_ISOLATED` `/28` サブネットに配置。 |
| **インスタンスのハードニング** | IMDSv2 必須、EBS 暗号化、長期 SSH 鍵ではなく SSM Session Manager（ブレークグラス用にキーペアは作成される）。 |
| **最小権限 IAM** | インスタンスには `AmazonSSMManagedInstanceCore` のみ。CDK Nag（`AwsSolutionsChecks`）を CI で実行し、抑制はすべてパス単位で理由付き。 |
| **影響範囲** | VPC ルートテーブルは `10/8` ではなく個別 `/16` ルート。誤ルートは 1 VPC に留まる。 |
| **デフォルト SG** | `@aws-cdk/aws-ec2:restrictDefaultSecurityGroup` が有効（リポジトリ全体の `cdk.json`）なので、各 VPC のデフォルト SG は全通信を拒否。 |

本番ハードニング: すべての VPC で VPC フローログを有効化し、ワークロードをプライベートサブネットへ移し、環境ごとに TGW ルートテーブルを分けて
（例）dev VPC が prod VPC へルーティングできないようにする。

## ✅ 前提条件

- Node.js 20 以上、リポジトリのブートストラップ済み（`infrastructure/` で `npm install`）
- AWS アカウントと名前付きプロファイル `${PROJECT}-${ENV}`（例: `transit-gateway-dev`）
- 対象アカウント/リージョンで CDK ブートストラップ済み: `npm run bootstrap -w workspaces/transit-gateway`
- `cdk` を実行するマシンから `checkip.amazonaws.com` への外向き `curl` が可能（または `ALLOWED_IPS` を指定）

## 🚀 デプロイ手順

```bash
export PROJECT=transit-gateway
export ENV=dev            # dev | stg | prd …

# 1. 合成（SSH 許可リスト用に自分のグローバル IP を自動検出）
npm run synth -w workspaces/transit-gateway

#    …または許可リストを明示指定（カンマ区切り）:
ALLOWED_IPS=203.0.113.10 npm run synth -w workspaces/transit-gateway

# 2. 単一スタックをデプロイ
npm run deploy:all -w workspaces/transit-gateway

# 3. 疎通確認（テスト戦略を参照）後、削除
npm run destroy:all -w workspaces/transit-gateway
```

リージョン: ワークショップは `us-east-1` で実施するが、（プロファイル由来の）`CDK_DEFAULT_REGION` が優先され、リポジトリ内の他ワークスペースと同じ挙動になる。
必要なら `parameters/dev-params.ts` の `region` を明示的に上書きする。

## 🧪 テスト戦略

| 層 | ファイル | 検証内容 |
|----|----------|----------|
| スナップショット | `test/snapshot/snapshot.test.ts` | スタック全体のテンプレートと、リソース種別/数のスナップショット。 |
| ユニット | `test/unit/transit-gateway-stack.test.ts` | VPC 3 個、デフォルト関連付け/伝播が無効の TGW 1 個、ルートテーブル 1 個、アタッチメント/関連付け/伝播が各 3 個、それぞれ自 VPC のアタッチメントに依存する 24 本の `<対向 CIDR> → TGW` ルート、VPC ごとのテストインスタンス、SG ルール（運用者 `/32`、`10/8` の ICMP+SSH、`0.0.0.0/0` なし）、`TransitGatewayConstruct` のバリデーション（アタッチメント 2 個以上、名前の一意性）。 |
| コンプライアンス | `test/compliance/cdk-nag.test.ts` | `AwsSolutionsChecks`。抑制はパス単位・理由付きのもの（フローログ無効、デモ用テストインスタンス）のみ。 |

```bash
npm test -w workspaces/transit-gateway
npm run test:snapshot:update -w workspaces/transit-gateway   # 意図的な変更後
```

### 手動での疎通確認

```bash
# VPC A のインスタンスへセッションを開く（ID はスタック出力から）
aws ssm start-session --target <VpcA テストインスタンス ID> --profile transit-gateway-dev

# VPC A 内から、VPC B / VPC C のインスタンスのプライベート IP へ ping
ping <VpcB インスタンスのプライベート IP>     # 10.1.x.x  → TGW 経由で成功
ping <VpcC インスタンスのプライベート IP>     # 10.2.x.x  → TGW 経由で成功
```

アタッチメントが `available` になり、ルートテーブルが収束すれば（通常 `deploy` 完了後 1 分未満）両方の ping が通る。
ping が固まる場合は [トラブルシューティング](#トラブルシューティング) へ。

## 🔧 カスタマイズ

| 目的 | 変更点 |
|------|--------|
| CIDR や AZ 数の変更 | `parameters/dev-params.ts` の `vpc{A,B,C}Config.createConfig`（`cidr`、`maxAzs`）。 |
| 4 つ目の VPC 追加 | `vpcDConfig` を追加し、`TransitGatewayParams` 型とスタックの `definitions` 配列を拡張。コンストラクトは既に N アタッチメントに対応。 |
| プライベートワークロード | `PRIVATE_WITH_EGRESS` サブネットグループを追加、`natCount: 1` に設定、`TestInstance` を `targetSubnetType: PRIVATE_WITH_EGRESS` で起動。 |
| セグメント化ルーティング | コンストラクトにルートテーブルを複数持たせ、関連付け/伝播を選択的に行う（例: shared-services 用テーブル）。 |
| カスタム ASN | パラメータの `amazonSideAsn`（プライベート利用は 64512–65534）。 |
| メッシュ SG を厳格化 | `connectedNetworkCidr` をより狭いスーパーネットにするか、`10/8` ルールを対向ごとの `/16` ルールに置き換える。 |

## 🩺 トラブルシューティング

| 症状 | 想定原因 | 対処 |
|------|----------|------|
| `synth` が *Could not retrieve global IP address* で失敗 | `checkip.amazonaws.com` への外向き `curl` 不可（CI、制限ネットワーク） | `ALLOWED_IPS=<自分の IP>` を明示指定。 |
| VPC 間の ping がタイムアウト | アタッチメントがまだ `pending`、または SG に ICMP ルールがない | `aws ec2 describe-transit-gateway-attachments` を確認。対象 SG が `10.0.0.0/8` からの ICMP を許可しているか確認。 |
| ping が片方向のみ通る | 対向 VPC のサブネットルートテーブルに戻りルートがない | そのサブネットのルートテーブルに `<発信元 CIDR> → tgw-…` があるか確認。本スタックは Public と `Tgw` サブネットにのみ追加する。 |
| SSM `start-session` が失敗 | インスタンスに外向き HTTPS がない（パブリック IP 未割り当て、または IGW ルート欠落） | インスタンスが `Public` サブネットにありパブリック IP を持つか、`0.0.0.0/0 → igw` ルートがあるか確認。 |
| `cdk destroy` で TGW が残る | アタッチメントは削除されたが、別経路で作った TGW ルートがまだ参照している | 帯域外で作った TGW ルート/アタッチメントを削除してから再実行。 |
| 編集後に CDK Nag テストが失敗 | 新リソースがルールに抵触 | `test/compliance/cdk-nag.test.ts` に **パス単位・理由付き** の抑制を追加。既存の抑制を広げないこと。 |

## 📚 参考資料

- AWS Networking Workshop — Multi-VPC → Transit Gateway: <https://catalog.workshops.aws/workshops/e4953d7d-f92f-4521-89a5-0002765de750/en-US/foundational/multivpc/transit-gw>（ワークショップトップ: <https://catalog.workshops.aws/workshops/e4953d7d-f92f-4521-89a5-0002765de750/en-US>）
- [Amazon VPC attachments in AWS Transit Gateway](https://docs.aws.amazon.com/vpc/latest/tgw/tgw-vpc-attachments.html)
- [Transit gateway route tables](https://docs.aws.amazon.com/vpc/latest/tgw/tgw-route-tables.html)
- [How AWS Transit Gateway works](https://docs.aws.amazon.com/vpc/latest/tgw/how-transit-gateways-work.html)
- 関連ワークスペース: [`vpc-peering`](../vpc-peering/) — 同じ 3 VPC をピアリングで接続した場合。安価だがスケールしにくい理由も解説。
