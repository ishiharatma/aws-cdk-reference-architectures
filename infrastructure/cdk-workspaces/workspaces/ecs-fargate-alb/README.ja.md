# ECS-Fargate-ALB —— ロードバランサーを使用したスケーラブルなコンテナアプリケーションの構築

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

## はじめに

このプロジェクトは、AWS CDKを使用してECS FargateとApplication Load Balancer (ALB)を組み合わせた本番対応のコンテナアプリケーションプラットフォームを構築するリファレンス実装です。

このアーキテクチャでは、以下の実装を確認することができます。

- コスト最適化されたNAT Instanceを使用したマルチAZ VPC
- Bootstrapデプロイモードに対応したECR
- Fargate/Fargate Spotキャパシティプロバイダーを使用したECS Fargate
- HTTPS対応のApplication Load Balancer
- CPU/メモリ使用率に基づくオートスケーリング
- コスト削減スケジューラー（スケジュールによるタスクの起動/停止）
- 可観測性のためのOpenTelemetry/X-Ray統合
- ALB-to-ECS通信のためのセキュリティグループ設計

### なぜECS-Fargate-ALBなのか?

| 特徴 | メリット |
| ------ | --------- |
| サーバーレスコンテナ | EC2インスタンスの管理が不要 |
| オートスケーリング | 需要に応じて自動的にスケール |
| 高可用性 | マルチAZデプロイとヘルスチェック |
| コスト最適化 | Fargate Spot + スケジュール起動/停止 + NAT Instance |
| HTTPS対応 | ACM証明書の統合サポート |
| 可観測性 | OpenTelemetry/X-Rayサポート組み込み |

## アーキテクチャ概要

構築する内容は次のとおりです。

![アーキテクチャ概要](overview.drawio.svg)

---

## 前提条件

- AWS CLI v2のインストールと設定
- Dockerのインストールと起動
- Node.js 20+
- AWS CDK CLI（`npm install -g aws-cdk`）
- TypeScriptの基礎知識
- 適切な権限を持つAWSアカウント
- AWS CLIプロファイル設定

## プロジェクトディレクトリ構造

```text
ecs-fargate-alb/
├── bin/
│   └── ecs-fargate-alb.ts                  # アプリケーションエントリーポイント
├── lib/
│   ├── stacks/
│   │   ├── base-stack.ts                   # VPCとセキュリティグループ
│   │   ├── ecr-stack.ts                    # ECRリポジトリ
│   │   └── ecs-fargate-alb-stack.ts        # ECS FargateとALB
│   └── stages/
│       └── ecs-fargate-alb-stage.ts        # デプロイオーケストレーション
├── parameters/
│   ├── environments.ts                     # 環境タイプ定義
│   └── dev-params.ts                       # 開発環境パラメータ
├── src/
│   └── (サンプルアプリケーションコードは backend/example-nodejs-api)
└── test/
    ├── snapshot/
    │   └── snapshot.test.ts                # スナップショットテスト
    └── unit/
        └── ecs-fargate-alb.test.ts         # ユニットテスト
```

---

### データフロー

```text
Internet
    ↓
Application Load Balancer (HTTPS/HTTP)
    ↓
Target Group (Health Check)
    ↓
ECS Fargate Service (Multi-AZ)
    ├─ Container: Node.js API
    └─ Sidecar: OpenTelemetry Collector
    ↓
Observability (X-Ray, CloudWatch)
```

### 主要コンポーネントと設計ポイント

| コンポーネント | 設計ポイント |
| ------------- | ------------ |
| VPC | マルチAZ (2 AZ)、NAT Instance（自動復旧機能付き）、スケジュール起動/停止 |
| ECR | Bootstrapモード（CDKが初期イメージをビルド＆プッシュ）、ライフサイクルポリシー |
| ALB | ACM証明書によるHTTPS対応（オプション）、IP制限付きセキュリティグループ |
| ECS Fargate | Fargate Spotキャパシティプロバイダー、オートスケーリング、スケジュール起動/停止 |
| Container | サンプルNode.js API (Express)、ヘルスチェックエンドポイント、構造化ロギング |
| Sidecar | 分散トレーシング用のOpenTelemetryまたはX-Rayデーモン |
| Security Groups | ALB → ECS インバウンドルール、最小権限の原則 |

---

## 実装のポイント

### 1. マルチスタックアーキテクチャ

モジュール性とデプロイの柔軟性を向上させるため、アーキテクチャは3つの独立したスタックで構成されています。

```typescript
// Base Stack - VPCとセキュリティグループ
const baseStack = new BaseStack(this, 'Base', {
  vpcConfig,
  allowedIpsforAlb: ['YOUR_IP/32'], // ALBアクセスを制限
  ports: [8080], // コンテナポート
});

// ECR Stack - コンテナイメージリポジトリ
const ecrStack = new EcrStack(this, 'Ecr', {
  config: params,
  isBootstrapMode: process.env.CDK_ECR_BOOTSTRAP === 'true',
  commitHash: process.env.COMMIT_HASH || 'latest',
});

// ECS Fargate + ALB Stack
const ecsFargateStack = new EcsFargateAlbStack(this, 'EcsFargateAlb', {
  vpc: baseStack.vpc.vpc,
  ecsSecurityGroups: [baseStack.ecsSecurityGroup],
  albSecurityGroup: baseStack.albSecurityGroup,
  repositories: ecrStack.repositories,
});
```

### 2. ECR Bootstrapモード

2つのデプロイモードをサポート：

**Bootstrapモード** (CDKからの初回デプロイ):
```bash
CDK_ECR_BOOTSTRAP=true npm run deploy:all -- --project=your-project --env=dev
```

CDKがソースコードからDockerイメージをビルドし、デプロイ中にECRにプッシュします。

**CI/CDモード** (初回デプロイ後):
```bash
npm run deploy:all -- --project=your-project --env=dev
```

イメージが既にECRに存在することを想定（CI/CDパイプラインでプッシュ済み）。

<details>
<summary>📝 ECR設定</summary>

```typescript
ecrConfig: {
  "backend": {
    createConfig: {
      repositoryNameSuffix: 'nodejs-backend-repo',
      imageSourcePath: '../../../../backend/example-nodejs-api',
      dockerfilePath: 'Dockerfile',
      buildArgs: {
        NODE_ENV: 'production'
      }
    }
  }
}
```

</details>

### 3. ECS Fargate with Fargate Spot

Fargate Spotを使用したコスト最適化されたキャパシティプロバイダー戦略：

```typescript
ecsFargateConfig: {
  createConfig: {
    capacityProviderStrategies: {
      fargateSpotWeight: 1,  // コスト削減のためFargate Spotを使用
      // fargateWeight: 1,    // 標準Fargateの場合はコメント解除
    },
    desiredCount: 1,
    taskDefinition: [
      {
        cpu: 512,
        memoryLimitMiB: 1024,
        containerDefinitions: {
          "backend": {
            cpu: 256,
            memoryLimitMiB: 512,
            port: 8080,
            enabledOtelSidecar: true,  // OpenTelemetryサイドカー
            environment: {
              LOG_LEVEL: 'INFO',
              NODE_ENV: 'production'
            },
            healthCheck: {
              path: '/health',
              interval: cdk.Duration.seconds(30),
              timeout: cdk.Duration.seconds(5),
              healthyThresholdCount: 2,
              unhealthyThresholdCount: 5,
            }
          }
        }
      }
    ]
  }
}
```

> **Fargate Spot節約効果**: 標準Fargateと比較して最大70%のコスト削減。フォールトトレラントなワークロードに最適です。

### 4. オートスケーリング設定

CPUとメモリ使用率に基づく自動スケーリング：

```typescript
autoScalingConfig: {
  minCapacity: 1,
  maxCapacity: 10,
  cpuUtilizationTargetPercent: 70,
  memoryUtilizationTargetPercent: 80,
  requestCountPerTarget: 1000  // ALBベースのスケーリング
}
```

### 5. コスト削減スケジューラー

スケジュールに従ってECSタスクを自動的に起動/停止：

```typescript
startstopSchedulerConfig: {
  startCronSchedule: 'cron(5 18 ? * MON-FRI *)',  // 月～金 18:05 JST起動
  stopCronSchedule: 'cron(55 20 ? * MON-FRI *)',   // 月～金 20:55 JST停止
  timeZone: cdk.TimeZone.ASIA_TOKYO,
}
```

**月間節約効果の例（開発環境）**:
- スケジューラーなし: 730時間/月
- スケジューラーあり (3時間 × 5日 × 4週): 60時間/月
- **節約効果: 開発環境で約92%**

### 6. HTTPS対応のApplication Load Balancer

自動証明書管理によるHTTPSサポート（オプション）：

```typescript
// HTTPS対応（hostedZoneIdが必要）
hostedZoneId: 'Z0123456789ABCDEFGHIJ'  // Route53 Hosted Zone ID

// HTTPのみ（テスト用）
// hostedZoneId: undefined
```

`hostedZoneId`を指定した場合：
- ACM証明書が自動的に作成される
- HTTP (ポート80) はHTTPS (ポート443) にリダイレクト
- 推奨SSLポリシーが適用される

<details>
<summary>📝 ALBセキュリティグループ設定</summary>

```typescript
// IPアドレスによるアクセス制限
allowedIpsforAlb: [
  '203.0.113.0/32',  // オフィスIP
  '198.51.100.0/24'  // VPN範囲
]

// またはパブリックアクセスを許可（本番環境では非推奨）
allowedIpsforAlb: []  // 0.0.0.0/0を許可
```

</details>

### 7. OpenTelemetry統合

OpenTelemetryまたはX-Rayによる分散トレーシング組み込み：

```typescript
containerDefinitions: {
  "backend": {
    enabledOtelSidecar: true,   // OpenTelemetry（推奨）
    // enabledXraySidecar: true,  // またはX-Rayデーモン
  }
}
```

**OpenTelemetryのメリット**:
- ベンダーニュートラルな可観測性
- 将来性（AWSはX-Rayデーモンから移行中）
- メトリクス、トレース、ログのサポート
- AWS X-Rayサービスと互換性あり

### 8. 自動復旧機能付きNAT Instance

NAT Gatewayに代わるコスト最適化された選択肢：

```typescript
vpcConfig: {
  createConfig: {
    natCount: 1,
    natType: NatType.INSTANCE,  // NAT Gatewayの代わり
    natSchedule: {
      startCronSchedule: 'cron(0 18 * * ? *)',  // 18:00 JST
      stopCronSchedule: 'cron(0 21 * * ? *)',   // 21:00 JST
      timeZone: cdk.TimeZone.ASIA_TOKYO,
    }
  }
}
```

**コスト比較（ap-northeast-1）**:

| ソリューション | インスタンスタイプ | 月額コスト |
| -------- | ------------- | ------------ |
| NAT Gateway | - | 約$32 (24時間稼働) |
| NAT Instance (t3.nano) | 常時稼働 | 約$10 |
| NAT Instance (スケジュール 3h/日) | スケジュールあり | 約$1.2 |

---

## デプロイガイド

### ステップ1: 環境パラメータの設定

`parameters/dev-params.ts`を編集：

```typescript
const devParams: EnvParams = {
  region: 'ap-northeast-1',
  vpcConfig: { /* VPC設定 */ },
  ecsFargateConfig: { /* ECS設定 */ },
  ecrConfig: { /* ECR設定 */ },
  hostedZoneId: 'Z0123...',  // オプション: HTTPS用
};
```

### ステップ2: CDKのブートストラップ（初回のみ）

```bash
npm run bootstrap -- --project=your-project --env=dev
```

### ステップ3: 初回デプロイ（Bootstrapモード）

CDKデプロイ中にDockerイメージをビルド＆プッシュ：

```bash
CDK_ECR_BOOTSTRAP=true npm run deploy:all -- --project=your-project --env=dev
```

これにより以下が実行されます：
1. VPCとセキュリティグループの作成
2. ECRリポジトリの作成
3. **ソースからDockerイメージをビルド**
4. **イメージをECRにプッシュ**
5. ECS FargateとALBのデプロイ

### ステップ4: アプリケーションへのアクセス

デプロイ後、CloudFormationの出力からALB DNS名を確認：

```bash
# ALB DNS名を取得
aws cloudformation describe-stacks \
  --stack-name YourProject-Dev-EcsFargateAlb \
  --query 'Stacks[0].Outputs[?OutputKey==`AlbDnsName`].OutputValue' \
  --output text
```

アプリケーションにアクセス：
```bash
# HTTP（証明書なし）
curl http://<ALB-DNS-NAME>/health

# HTTPS（証明書あり）
curl https://your-project.dev.example.com/health
```

### ステップ5: 以降のデプロイ（CI/CDモード）

初回デプロイ後は、CI/CDを使用してイメージをビルド＆プッシュ：

```bash
# CI/CDパイプラインで新しいイメージをECRにプッシュ
docker buildx build --platform linux/amd64 -t <ECR-URL>:<COMMIT-HASH> .
docker push <ECR-URL>:<COMMIT-HASH>

# CDKデプロイで既存イメージを使用
COMMIT_HASH=<COMMIT-HASH> npm run deploy:all -- --project=your-project --env=dev
```

---

## テスト

### 全テストの実行

```bash
npm test -w workspaces/ecs-fargate-alb
```

### スナップショットテストの実行

```bash
npm run test:snapshot -w workspaces/ecs-fargate-alb
```

### ユニットテストの実行

```bash
npm test -w workspaces/ecs-fargate-alb -- test/unit
```

---

## カスタマイズ

### 新しいコンテナの追加

新しいコンテナ定義を追加：

```typescript
containerDefinitions: {
  "backend": { /* 既存 */ },
  "frontend": {
    cpu: 256,
    memoryLimitMiB: 512,
    port: 3000,
    enabledOtelSidecar: true,
    healthCheck: {
      path: '/',
      interval: cdk.Duration.seconds(30),
    }
  }
}
```

対応するECR設定を追加：

```typescript
ecrConfig: {
  "backend": { /* 既存 */ },
  "frontend": {
    createConfig: {
      repositoryNameSuffix: 'react-frontend-repo',
      imageSourcePath: '../../../../frontend/example-react-app',
    }
  }
}
```

### オートスケーリングの有効化

オートスケーリング設定を追加：

```typescript
autoScalingConfig: {
  minCapacity: 2,
  maxCapacity: 20,
  cpuUtilizationTargetPercent: 70,
  memoryUtilizationTargetPercent: 80,
}
```

### パスベースルーティング

異なるパスに対するALBリスナールールを設定：

```typescript
albConditions: {
  pathPatterns: ['/api/*', '/v1/*'],
  hostHeaders: ['api.example.com']
}
```

---

## コスト見積もり

<details>
<summary>💰 月額見積もり（東京リージョン）</summary>

### 開発環境（スケジューラーあり）

| サービス | 使用量 | 月額コスト |
| -------- | ------ | -------- |
| ECS Fargate (Spot) | 0.25 vCPU, 0.5GB, 60時間/月 | 約$0.90 |
| NAT Instance (t3.nano) | 60時間/月 | 約$1.20 |
| ALB | 基本使用 | 約$16.00 |
| ECR | 5GBストレージ | 約$0.50 |
| CloudWatch Logs | 5GB | 約$0.27 |

**開発環境合計: 約$19/月**

### 本番環境（24時間稼働）

| サービス | 使用量 | 月額コスト |
| -------- | ------ | -------- |
| ECS Fargate (Standard) | 0.25 vCPU, 0.5GB, 2タスク | 約$26.40 |
| NAT Gateway (x2 AZ) | 10GB転送 | 約$65.00 |
| ALB | 100GB処理 | 約$23.00 |
| ECR | 10GBストレージ | 約$1.00 |
| CloudWatch Logs | 20GB | 約$1.08 |

**本番環境合計: 約$116/月**

</details>

<details>
<summary>💡 コスト最適化のヒント</summary>

1. **Fargate Spot**: 重要でないワークロードに使用（最大70%削減）
2. **スケジューラー**: 開発/テスト環境を未使用時に停止
3. **NAT Instance**: 低トラフィック環境ではNAT Gatewayの代わりに使用
4. **オートスケーリング**: 適切なmin/maxを設定してオーバープロビジョニングを回避
5. **ログ保持期間**: CloudWatch Logsの保持期間を短く設定
6. **予約キャパシティ**: 本番ワークロードにSavings Plansの検討

</details>

---

## セキュリティに関する考慮事項

### ネットワークセキュリティ

- ✅ パブリックサブネットとプライベートサブネットを備えたVPC
- ✅ ALBはパブリックサブネット、ECSタスクはプライベートサブネット
- ✅ 最小権限のセキュリティグループ
- ✅ ALBのIPベースアクセス制限
- ✅ ACM証明書によるHTTPS

### コンテナセキュリティ

- ✅ コンテナ内で非rootユーザーを使用
- ✅ 読み取り専用ルートファイルシステム（推奨）
- ✅ AWS Secrets Managerからのシークレット
- ✅ 定期的なイメージスキャン（ECR）
- ✅ 最小限のベースイメージ

### IAMセキュリティ

- ✅ タスク実行ロール（イメージプル用）
- ✅ タスクロール（アプリケーション権限用）
- ✅ タスク定義ごとに個別のロール
- ✅ 最小権限の原則

---

## トラブルシューティング

### コンテナが起動しない

**症状**: ECSタスクが起動に失敗するか、すぐに停止する

**考えられる原因**:
1. 無効なコンテナイメージ
2. メモリ/CPU不足
3. ヘルスチェック失敗
4. 環境変数の欠落

**解決方法**:
```bash
# ECSタスクの停止理由を確認
aws ecs describe-tasks \
  --cluster <CLUSTER-NAME> \
  --tasks <TASK-ARN> \
  --query 'tasks[0].stoppedReason'

# CloudWatch Logsを確認
aws logs tail /aws/ecs/<PROJECT>-<ENV>-ecs-fargate --follow
```

### ALBが503エラーを返す

**症状**: ALBが503 Service Unavailableを返す

**考えられる原因**:
1. ヘルシーなターゲットがない
2. セキュリティグループがトラフィックをブロック
3. ヘルスチェックパスが不正

**解決方法**:
```bash
# ターゲットヘルスを確認
aws elbv2 describe-target-health \
  --target-group-arn <TG-ARN>

# セキュリティグループがALB → ECSトラフィックを許可していることを確認
# ヘルスチェック設定を確認
```

### Bootstrapモードが失敗する

**症状**: CDKデプロイ中にDockerビルドが失敗する

**考えられる原因**:
1. Dockerデーモンが起動していない
2. ディスク容量不足
3. ビルドタイムアウト（デフォルト10分）
4. ビルドコンテキストが大きすぎる

**解決方法**:
```bash
# Dockerが起動しているか確認
docker info

# イメージを手動でビルドしてデバッグ
cd backend/example-nodejs-api
docker build -t test .

# ビルドタイムアウトを延長
cdk deploy --toolkit-stack-name CDKToolkit --context ecrAssetTimeout=1800
```

### スケジュール起動/停止が動作しない

**症状**: ECSタスクがスケジュール通りに起動/停止しない

**考えられる原因**:
1. EventBridge Schedulerルールが無効
2. IAM権限の欠落
3. タイムゾーンが不正

**解決方法**:
```bash
# スケジューラールールを確認
aws scheduler list-schedules

# ルールの状態を確認
aws scheduler get-schedule --name <SCHEDULE-NAME>

# タイムゾーンとcron式を確認
```

---

## クリーンアップ

全てのリソースを削除するには：

```bash
npm run destroy:all -- --project=your-project --env=dev
```

**注意**: 削除保護が有効な場合は、AWS Consoleで先に無効化してください。

以下については手動クリーンアップが必要な場合があります：
- ECRイメージ（保持ポリシー未設定の場合）
- CloudWatch Logグループ
- Route53レコード

---

## まとめ

このパターンから学んだこと：

1. **マルチスタックアーキテクチャ**: VPC、ECR、ECSを分離してモジュール性を向上
2. **Bootstrap vs CI/CDモード**: デプロイアプローチの柔軟性
3. **コスト最適化**: Fargate Spot + NAT Instance + スケジューラー
4. **セキュリティファースト**: ネットワーク分離、セキュリティグループ、HTTPS
5. **可観測性**: 分散トレーシングのためのOpenTelemetry統合
6. **本番対応**: オートスケーリング、ヘルスチェック、マルチAZ

---

## 参考資料

- [AWS ECS Best Practices](https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/intro.html)
- [Amazon ECS on AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html)
- [AWS CDK ECS Patterns](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs_patterns-readme.html)
- [Fargate Spot](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html)
- [OpenTelemetry on AWS](https://aws-otel.github.io/)
