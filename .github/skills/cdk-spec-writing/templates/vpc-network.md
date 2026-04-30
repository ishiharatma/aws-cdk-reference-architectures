# VPC / ネットワーク 仕様書テンプレート

> このテンプレートをコピーして `.github/specs/vpc.md` に配置し、プロジェクト固有の値を埋めてください。

---

# VPC / ネットワーク 仕様

## 概要

全リソースが属するネットワーク基盤を定義する。アウトバウンド通信方式（TransitGateway / NAT Gateway / NAT Instance）をパラメータで切り替え可能な構造とする。

---

## 対象 AWS リソース

| リソース | 命名規則 | 備考 |
|----------|---------|------|
| VPC | `<project>-<env>-vpc` | |
| サブネット (Public) | 自動生成 | NAT Gateway 方式のみ |
| サブネット (Private) | 自動生成 | 全方式共通 |
| Internet Gateway | 自動生成 | NAT Gateway 方式のみ |
| NAT Gateway | 自動生成 | NAT Gateway 方式のみ |
| NAT Instance | `<project>-<env>-nat` | NAT Instance 方式のみ |
| TransitGateway Attachment | — | TGW 方式のみ |
| VPC Endpoint (ECR/S3/CW Logs) | — | TGW 方式で必要 |

---

## アウトバウンド通信方式の切り替え

### パラメータによる分岐

| パラメータ | 方式 | ユースケース |
|-----------|------|-------------|
| `transitGatewayId` 指定 | TransitGateway | 共有 NAT を利用（dev/stage） |
| `natGatewayProvider: 'gateway'` | NAT Gateway | 独立 NAT（prod） |
| `natGatewayProvider: 'instance'` | NAT Instance | コスト削減（dev） |

### TransitGateway 方式

```text
Private Subnet → TGW Attachment → 共有 NAT Gateway → Internet
```

- パブリックサブネット不要
- VPC Endpoint が必要（ECR / S3 / CloudWatch Logs）

### NAT Gateway 方式

```text
Private Subnet → NAT Gateway (Public Subnet) → IGW → Internet
```

### NAT Instance 方式

```text
Private Subnet → NAT Instance (Public Subnet) → IGW → Internet
```

- スケジュールによる停止/起動が可能（コスト削減）

---

## サブネット構成

### TransitGateway 方式

| サブネット | 用途 | CIDR 例 |
|-----------|------|---------|
| Private | ECS / Lambda 等 | /24 × AZ 数 |

### NAT Gateway / NAT Instance 方式

| サブネット | 用途 | CIDR 例 |
|-----------|------|---------|
| Public | ALB / NAT Gateway | /24 × AZ 数 |
| Private | ECS / Lambda 等 | /24 × AZ 数 |

---

## パラメータ設計

### 型定義

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `existingVpcId` | `string` | — | 既存 VPC ID（指定時は新規作成しない） |
| `createConfig.cidr` | `string` | ※ | VPC CIDR ブロック |
| `createConfig.azCount` | `number` | ※ | AZ 数 |
| `createConfig.transitGatewayId` | `string` | — | TGW ID（指定時は TGW 方式） |
| `createConfig.natGatewayProvider` | `enum` | — | `'gateway'` / `'instance'` |
| `createConfig.natGatewayCount` | `number` | — | NAT Gateway 数（デフォルト: AZ 数） |

### 環境別パラメータ例

| 設定項目 | dev | stage | prod |
|---------|-----|-------|------|
| CIDR | `10.0.0.0/16` | `10.1.0.0/16` | `10.2.0.0/16` |
| AZ 数 | 2 | 2 | 2 |
| 方式 | TGW | TGW | NAT Gateway |
| NAT 数 | — | — | 2 |

---

## Parameter Store 出力

| SSM キー | 説明 |
|---------|------|
| `/<project>/<env>/network/vpc-id` | VPC ID |
| `/<project>/<env>/network/subnet-ids` | プライベートサブネット ID（カンマ区切り） |

---

## 受け入れ基準（テスト観点）

### Fine-grained assertions

- [ ] TGW 方式: パブリックサブネットが作成されない
- [ ] TGW 方式: TGW Attachment が作成される
- [ ] NAT GW 方式: パブリックサブネット + IGW + NAT Gateway が作成される
- [ ] NAT Instance 方式: NAT Instance が作成される
- [ ] SSM Parameter が出力される

### バリデーションテスト

- [ ] 不正な CIDR 形式でエラーになる
- [ ] `azCount` が 0 以下でエラーになる
- [ ] `transitGatewayId` と `natGatewayProvider` の同時指定でエラーになる

### Compliance tests (cdk-nag)

- [ ] VPC Flow Logs が有効（要件確定後）

---

## 未確定事項・TODO

| 項目 | 暫定値 | 確認先 |
|------|--------|--------|
| VPC CIDR（各環境） | `10.x.0.0/16` | ネットワーク担当 |
| AZ 数 | 2 | インフラ担当 |
| TransitGateway ID | — | ネットワーク担当 |
| prod の通信方式 | NAT Gateway | インフラ担当 |
