# FIS カオスエンジニアリング — アーキテクチャ A: CloudFront + Internal ALB + ECS Fargate + Aurora PostgreSQL

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20CloudFront%20%7C%20ALB%20%7C%20ECS%20Fargate%20%7C%20Aurora%20PostgreSQL-orange?style=flat-square)

## はじめに

本プロジェクトは、**コンテナベースの 3 層 Web アーキテクチャ**に対する AWS Fault Injection Simulator (FIS) を用いたカオスエンジニアリングのリファレンス実装です。CloudFront が VPC Origin 経由でトラフィックを Internal ALB に転送し、ALB が Private サブネットの ECS Fargate タスク（nginx）にルーティングし、タスクが Isolated サブネットの Aurora PostgreSQL Serverless v2 クラスターに接続します。

4 つの FIS 実験テンプレートが、データ・コンピュート・ネットワーク各層で異なる障害シナリオを注入します。

| シナリオ | 注入する障害 | 実行時間 | 検証内容 |
| -------- | ------------ | -------- | -------- |
| **A-1** Aurora DB フェイルオーバー | `aws:rds:failover-db-cluster` — Writer→Reader プロモーションをトリガー | 約5分 | 接続プールの回復、リトライロジック、RDS 再接続動作 |
| **A-2** ECS 全タスク停止 | `aws:ecs:stop-task` — 実行中の全タスクを同時停止 | 5分 | ALB 503 ハンドリング、CloudFront フォールバックページの起動、ECS サービス回復速度 |
| **A-3** ECS→DB ネットワーク遮断 | `aws:ecs:network-blackhole-port` — ECS タスクから TCP 5432 の送信をブロック | 5分 | クエリタイムアウト設定、サーキットブレーカーパターン、DB 到達不能時の縮退運転 |
| **A-4** ALB→ECS ネットワーク遮断 | `aws:ecs:network-blackhole-port` — ECS タスクへの TCP 80 の受信をブロック | 5分 | ALB 異常ホスト検出速度、CloudFront フォールバック起動 |

全実験テンプレートは CloudWatch Alarm の停止条件を共有します。ALB 5xx エラー数が 1 分間に 10 件以上になると実験が自動停止し、長時間障害を防ぎます。

## アーキテクチャ概要

```
ユーザー (HTTPS)
    │
    ▼
CloudFront Distribution  (VPC Origin プライマリ、S3 エラーページ フォールバック)
    │  Origin Group: プライマリ=VPC Origin、502/503/504 でフォールバック
    ▼
Internal ALB  (Private サブネット、CloudFront プレフィックスリストからのみ受信)
    │  HTTP/80 → ECS Fargate ターゲットグループ
    ▼
ECS Fargate サービス  (nginx、タスク数 2、enableExecuteCommand=true)
    │  TCP 5432
    ▼
Aurora PostgreSQL Serverless v2  (Writer 1 台 + Reader 1 台、Isolated サブネット)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS 実験テンプレート (FisStack)

A-1  aws:rds:failover-db-cluster ──────────► Aurora クラスター
     Writer→Reader プロモーションをトリガー

A-2  aws:ecs:stop-task ─────────────────────► ECS タスク (ALL)
     全タスクを停止。ECS スケジューラーが代替タスクを起動

A-3  aws:ecs:network-blackhole-port ────────► ECS タスク (ALL)
     送信 TCP 5432 を 5 分間ブロック

A-4  aws:ecs:network-blackhole-port ────────► ECS タスク (ALL)
     受信 TCP 80 を 5 分間ブロック
```

### VPC レイアウト

```
VPC 10.10.0.0/16 (2 AZ)
  Public サブネット  /24 ×2   — NAT Gateway、CloudFront VPC Origin ENI
  Private サブネット /24 ×2   — Internal ALB、ECS Fargate タスク
  Isolated サブネット /24 ×2  — Aurora PostgreSQL クラスター
```

### 設計上のポイント

| 特徴 | メリット |
| ---- | -------- |
| CloudFront VPC Origin → Internal ALB | ALB はインターネットから到達不可。CloudFront が唯一の受信経路 |
| S3 フォールバック付き Origin Group | A-2/A-4 でタスクが全停止した際、CloudFront が S3 のメンテナンスページを配信 |
| `enableExecuteCommand: true` | FIS の `aws:ecs:network-blackhole-port` / `aws:ecs:stop-task` (SSM ベース) に必須 |
| `propagateTags: SERVICE` | FIS がサービスから伝播した `fis-target: app-service` タグでタスクをターゲット |
| Aurora に Writer + Reader 各 1 台 | `aws:rds:failover-db-cluster` の実行に Reader が最低 1 台必要 |
| 共通の停止条件 | 1 つの CloudWatch Alarm (ALB 5xx ≥ 10/分) が 4 つの実験すべてを自動停止 |

## 前提条件

- AWS CLI v2 のインストールと設定
- Node.js 20 以降
- AWS CDK CLI (`npm install -g aws-cdk`)
- TypeScript と VPC ネットワーキングの基礎知識
- FIS サービスリンクロールが作成済みの AWS アカウント（初回 FIS 使用時に自動作成）

> **コスト注意**: NAT Gateway (~$0.045/時間) と Aurora Serverless v2 の最低 ACU 料金が発生します。実験後はスタックを削除してください。

## デプロイ手順

### 1. 依存関係のインストール

```bash
cd infrastructure
npm ci
```

### 2. 環境パラメーターの設定

`parameters/dev-params.ts` を編集してリージョンとアラームメールを設定します：

```typescript
const devParams: EnvParams = {
    region: 'ap-northeast-1',
    // alarmEmail: 'ops@example.com',
    // cloudfrontManagedPrefixList: 'pl-58a04531',  // ap-northeast-1 の CloudFront プレフィックスリスト
};
```

### 3. CDK ブートストラップ（初回のみ）

```bash
PROJECT=fis-chaos ENV=dev npm run bootstrap
```

### 4. 全スタックのデプロイ

```bash
PROJECT=fis-chaos ENV=dev npm run stage:deploy:all
```

依存関係の順にスタックがデプロイされます：
1. `fis-chaos-dev-a-base` — VPC + Aurora クラスター
2. `fis-chaos-dev-a-app` — ECS Fargate + Internal ALB + CloudFront
3. `fis-chaos-dev-a-fis` — FIS テンプレート + IAM + アラーム

## テスト実行

```bash
cd infrastructure
npm ci

# このワークスペースの全テストを実行
npm run test --workspace=fis-arch-a-ecs-aurora

# スナップショットテストのみ
npm run test:snapshot --workspace=fis-arch-a-ecs-aurora

# CDK Nag コンプライアンスチェック
npm run test:compliance --workspace=fis-arch-a-ecs-aurora

# 意図的な変更後にスナップショットを更新
npm run test:snapshot:update --workspace=fis-arch-a-ecs-aurora
```

## クリーンアップ

```bash
PROJECT=fis-chaos ENV=dev npm run stage:destroy:all
```

全リソースに `removalPolicy: DESTROY` が設定されているため、VPC・Aurora クラスター・ECS サービス・ALB・CloudFront ディストリビューション・FIS テンプレート・CloudWatch ロググループがすべて削除されます。

## 参考資料

- [AWS FIS — サポートされているアクション](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [aws:rds:failover-db-cluster アクションリファレンス](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-rds)
- [aws:ecs:stop-task アクションリファレンス](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-ecs)
- [aws:ecs:network-blackhole-port アクションリファレンス](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-ecs)
- [CloudFront VPC Origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)
