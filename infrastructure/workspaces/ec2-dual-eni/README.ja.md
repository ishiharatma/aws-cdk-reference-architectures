# EC2 デュアルENI パターン<!-- omit in toc -->

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-200-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-EC2%20%7C%20VPC%20%7C%20ENI%20%7C%20EIP-purple?style=flat-square)

## 目次<!-- omit in toc -->

- [はじめに](#はじめに)
- [アーキテクチャ概要](#アーキテクチャ概要)
- [ネットワーク設計](#ネットワーク設計)
- [セキュリティ設計](#セキュリティ設計)
- [プロジェクト構成](#プロジェクト構成)
- [デプロイ](#デプロイ)
- [動作確認](#動作確認)
- [現代的なベストプラクティスとの比較](#現代的なベストプラクティスとの比較)
- [クリーンアップ](#クリーンアップ)

## はじめに

このワークスペースでは、単一のEC2インスタンスに2つのネットワークインターフェース（ENI）を持たせるパターンを実装します。

- **eth0（プライマリENI）**: インターネット向けWebトラフィック用。Elastic IP（EIP）を付与し、HTTP/HTTPSを全インターネットに開放します。
- **eth1（セカンダリENI）**: 管理トラフィック用。SSH（ポート22）を特定のCIDR範囲からのみ許可します。

このパターンはAWS認定試験（ANS-C01など）のネットワーキング問題として頻出するため、**学習・試験対策目的のリファレンス**として提供しています。

> **注意**: 現代のAWSベストプラクティスでは、SSM Session Managerを使用することでSSHキー管理や管理ENIを不要にできます。本パターンと[現代的なベストプラクティス](#現代的なベストプラクティスとの比較)の比較も参照してください。

## アーキテクチャ概要

![アーキテクチャ概要](overview.drawio.svg)

```
Internet
   │
   │ HTTP/HTTPS (0.0.0.0/0)
   ▼
┌──────────────────────────────────────────────┐
│  VPC (10.0.0.0/16)                          │
│                                              │
│  Public Subnet (10.0.1.0/24)                │
│  ┌────────────────────────────────────────┐  │
│  │ EC2 Instance                           │  │
│  │ ┌─────────────────────────────────┐   │  │
│  │ │ eth0 ←── Web SG (HTTP/HTTPS)   │   │  │
│  │ │  └── EIP: 203.x.x.x            │   │  │
│  │ └─────────────────────────────────┘   │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  Management Subnet (10.0.2.0/24) [Isolated] │
│  ┌────────────────────────────────────────┐  │
│  │ eth1 ←── Management SG (SSH only)     │  │
│  │  └── Private IP: 10.0.2.x             │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
        ▲
        │ SSH (port 22) — specified CIDRs only
   Admin Host
```

## ネットワーク設計

| ENI | サブネット | セキュリティグループ | トラフィック |
|-----|----------|------------------|------------|
| eth0 | Public (10.0.1.0/24) | Web SG | HTTP(80)/HTTPS(443) from 0.0.0.0/0 |
| eth1 | Management (10.0.2.0/24) [Isolated] | Management SG | SSH(22) from 指定CIDRのみ |

- eth0にはElastic IP（EIP）を付与し、固定パブリックIPでWebサーバーを公開します。
- eth1は分離サブネット（インターネットゲートウェイなし）に配置し、SSH管理用途に限定します。
- 両ENIは同一AZに配置する必要があります（CDKはmaxAzs: 1で制御）。

## セキュリティ設計

| 項目 | 設定 |
|------|------|
| IMDSv2 | 必須（HttpTokens: required） |
| EBSボリューム | 暗号化有効（gp3） |
| SSM Session Manager | IAMロールで有効化（SSH代替） |
| 管理SSH | 指定CIDRのみ許可 |
| Webトラフィック | HTTP/HTTPSのみ（eth0経由） |

## プロジェクト構成

```
ec2-dual-eni/
├── bin/ec2-dual-eni.ts          # アプリエントリポイント
├── lib/
│   ├── constructs/
│   │   └── ec2-dual-eni.ts      # デュアルENI Construct
│   ├── stacks/
│   │   └── ec2-dual-eni-stack.ts
│   └── stages/
│       └── ec2-dual-eni-stage.ts
├── parameters/
│   ├── environments.ts          # EnvParams 型定義
│   ├── dev-params.ts            # 開発環境パラメータ
│   └── index.ts
├── src/
│   └── nginx-userdata.ts        # デュアルENI情報表示ページ
└── test/
    ├── unit/                    # ユニットテスト
    ├── snapshot/                # スナップショットテスト
    └── compliance/              # cdk-nag チェック
```

## デプロイ

### 環境変数

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `WEB_ALLOWED_CIDRS` | 実行マシンのグローバルIP | eth0（Web）へのHTTP/HTTPSを許可するCIDR（カンマ区切り）|
| `MANAGEMENT_ALLOWED_CIDRS` | 実行マシンのグローバルIP | eth1（管理）へのSSHを許可するCIDR（カンマ区切り）|

> **重要 — Webアクセス制限について**
>
> このパターンの想定アーキテクチャでは eth0 は全インターネット（`0.0.0.0/0`）に開放しますが、
> サンプルをそのままデプロイして意図せずEC2を全開放しないよう、
> **デフォルトでは実行マシンの自IPのみ**に制限しています。
>
> 全インターネットに開放するには `WEB_ALLOWED_CIDRS=0.0.0.0/0` を明示的に指定してください。

```bash
# デフォルト（自IPのみ）でデプロイ
PROJECT=myproject ENV=dev npm run deploy:all

# 全インターネットに開放（想定アーキテクチャ通り）
WEB_ALLOWED_CIDRS=0.0.0.0/0 \
MANAGEMENT_ALLOWED_CIDRS=203.0.113.0/24 \
PROJECT=myproject ENV=dev npm run deploy:all
```

## 動作確認

デプロイ後、CloudFormation Outputsに以下が表示されます：

- `WebUrl`: `http://<EIP>` でWebサーバーにアクセス
- `ElasticIP`: eth0に付与されたEIP
- `ManagementPrivateIP`: eth1のプライベートIP

Webブラウザで `http://<EIP>` にアクセスすると、インスタンス情報と両ENIのIP情報が表示されます。

```
┌─────────────────────────────────────┐
│  🖥 EC2 Dual ENI Demo               │
│                                     │
│  Instance Info                      │
│  Hostname: ip-10-0-1-xxx.ec2...     │
│  Instance ID: i-0abc123def456789    │
│  AZ: ap-northeast-1a                │
│                                     │
│  Network Interfaces                 │
│  eth0 [Internet-facing]             │
│    Public IP (EIP): 203.x.x.x      │
│    Private IP: 10.0.1.x             │
│    ✅ HTTP/HTTPS open to 0.0.0.0/0  │
│                                     │
│  eth1 [Management]                  │
│    Private IP: 10.0.2.x             │
│    🔒 SSH restricted to CIDR only   │
└─────────────────────────────────────┘
```

## 現代的なベストプラクティスとの比較

| 観点 | このパターン（デュアルENI） | 現代的なアプローチ |
|------|--------------------------|------------------|
| 管理アクセス | SSH via eth1（鍵管理必要） | SSM Session Manager（鍵不要） |
| ネットワーク分離 | ENI単位でSG分離 | VPCエンドポイント + プライベートサブネット |
| パブリックIP | EIP（固定） | CloudFront / ALB |
| 認定試験での出題 | ANS-C01頻出 | — |

このパターンを本番環境で使用する場合は、SSM Session Managerへの移行を強く推奨します。

## クリーンアップ

```bash
PROJECT=myproject ENV=dev npm run destroy:all
```

> **注意**: EIPはスタック削除時に自動的に解放されます。ENIはスタック削除時にCloudFormationが削除します。
