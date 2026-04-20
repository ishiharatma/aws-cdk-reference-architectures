# ECS Fargate Backend API 仕様書テンプレート

> このテンプレートをコピーして `.github/specs/<feature>.md` に配置し、プロジェクト固有の値を埋めてください。

---

# Backend API 仕様

## 概要

ECS Fargate 上で動作する Backend API アプリケーションのインフラ基盤を定義する。ALB でリクエストを受け付け、WAF でセキュリティフィルタリングを行い、ECS Fargate でアプリケーションを実行する。タスク定義・サービスの管理は ecspresso に委任し、CDK はインフラ基盤のみを管理する。

---

## インフラとアプリの責務分離

### CDK 管理

| リソース | 責務 |
|----------|------|
| ALB | 外部リクエストの受け口 |
| WAF WebACL | セキュリティフィルタリング |
| ECS Cluster | コンテナ実行基盤 |
| ECR Repository | コンテナイメージ保管 |
| Security Group (ALB / ECS) | ネットワークアクセス制御 |
| IAM Role (TaskExecutionRole) | ECR Pull + CloudWatch Logs |
| IAM Role (TaskRole) | アプリが必要とする AWS サービスへのアクセス |
| CloudWatch Logs Group | コンテナログ保管 |
| Auto Scaling (ScalableTarget + Policy) | CPU/メモリベースのスケーリング |
| Parameter Store | ecspresso が参照する値の出力 |

### ecspresso 管理（CDK 管理外）

| リソース | 責務 |
|----------|------|
| ECS TaskDefinition | コンテナ定義（イメージ URI・環境変数・ポート等） |
| ECS Service | サービス定義（desiredCount・LB 設定・デプロイ設定） |
| ALB TargetGroup アタッチ | サービス定義内で TargetGroup ARN を指定 |

### 分離の理由

- CDK でタスク定義を管理すると、コード更新のたびに `cdk deploy` が必要になる
- ecspresso はタスク定義の登録とサービスの upsert を 1 コマンドで実行できる
- イメージ URI の更新は ecspresso の外部変数で制御し、CDK に依存しない

---

## 対象 AWS リソース

| リソース | 命名規則 | 備考 |
|----------|---------|------|
| ALB | `<project>-<env>-alb` | HTTPS (443) or HTTP (80) |
| WAF WebACL | `<project>-<env>-waf` | ALB にアタッチ |
| ECS Cluster | `<project>-<env>-api-cluster` | Container Insights 有効 |
| ECR Repository | `<project>-<env>-api` | 小文字のみ |
| SG (ALB) | `<project>-<env>-alb-sg` | インバウンド: 443 or 80 |
| SG (ECS) | `<project>-<env>-ecs-sg` | インバウンド: ALB SG からのみ |
| TaskExecutionRole | `<project>-<env>-ecs-task-execution-role` | |
| TaskRole | `<project>-<env>-ecs-task-role` | |
| CW Logs | `/ecs/<project>-<env>-api` | ecspresso の awslogs-group と一致 |

---

## ユースケース / フロー

```text
外部クライアント
    │
    ▼
[ ALB ] ← WAF がアタッチ
    │
    ▼
[ ECS Fargate (Backend API) ]
    │
    ▼
[ 後続システム / データストア ]
```

---

## パラメータ設計

### 型定義

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `ecsTaskCpu` | `number` | ✅ | Fargate CPU ユニット |
| `ecsTaskMemory` | `number` | ✅ | Fargate メモリ (MB) |
| `ecsMinTaskCount` | `number` | ✅ | 最小タスク数 |
| `ecsMaxTaskCount` | `number` | ✅ | 最大タスク数 |
| `ecsLogRetentionDays` | `number` | ✅ | ログ保持日数 |
| `healthCheckPath` | `string` | ✅ | ALB ヘルスチェックパス |
| `ecrMaxImageCount` | `number` | ✅ | ECR イメージ保持数 |
| `albAccessLogEnabled` | `boolean` | ✅ | ALB アクセスログ有効化 |
| `wafLogEnabled` | `boolean` | ✅ | WAF ログ有効化 |
| `albDeletionProtection` | `boolean` | ✅ | ALB 削除保護 |
| `domainName` | `string` | — | ACM 証明書ドメイン名（未指定時 HTTP） |
| `route53HostedZoneId` | `string` | — | Route53 ホストゾーン ID |
| `enableAutoScaling` | `boolean` | — | Auto Scaling 有効化 |
| `ecsNightlySchedule` | `object` | — | 夜間停止スケジュール |
| `enableEcsExec` | `boolean` | — | ECS Exec 有効化 |
| `enableAdot` | `boolean` | — | ADOT サイドカー有効化 |
| `wafIpWhitelist` | `string[]` | — | WAF IP ホワイトリスト |

### 環境別パラメータ例

| 設定項目 | dev | stage | prod |
|---------|-----|-------|------|
| CPU | 256 | 512 | 1024 |
| メモリ | 512 MB | 1024 MB | 2048 MB |
| 最小タスク数 | 1 | 1 | 2 |
| 最大タスク数 | 2 | 2 | 4 |
| ALB アクセスログ | 無効 | 有効 | 有効 |
| WAF ログ | 無効 | 有効 | 有効 |
| ALB 削除保護 | 無効 | 無効 | 有効 |
| Auto Scaling | 無効 | 無効 | 有効 |
| 夜間停止 | 有効 | 有効 | — |

---

## CDK / ecspresso 責務分担

### ecspresso が参照する SSM キー（CDK が出力）

| SSM キー | 出力元 | 参照先 |
|---------|--------|--------|
| `/<project>/<env>/ecs/cluster-arn` | EcsConstruct | ecspresso / buildspec |
| `/<project>/<env>/ecs/cluster-name` | EcsConstruct | buildspec |
| `/<project>/<env>/ecs/service-name` | EcsConstruct | buildspec |
| `/<project>/<env>/ecs/task-execution-role-arn` | EcsConstruct | ecs-task-def.jsonnet |
| `/<project>/<env>/ecs/task-role-arn` | EcsConstruct | ecs-task-def.jsonnet |
| `/<project>/<env>/network/subnet-ids` | VpcConstruct | ecs-service-def.jsonnet |
| `/<project>/<env>/network/security-group-id` | EcsConstruct | ecs-service-def.jsonnet |
| `/<project>/<env>/alb/target-group-arn` | AlbConstruct | ecs-service-def.jsonnet |

---

## 受け入れ基準（テスト観点）

### Fine-grained assertions

- [ ] ECS Cluster が 1 つ作成される（Container Insights 有効）
- [ ] ECS TaskDefinition / Service は CDK で作成されない
- [ ] ECR リポジトリにイメージスキャンが有効化される
- [ ] TaskExecutionRole に `AmazonECSTaskExecutionRolePolicy` が付与される
- [ ] TaskRole に必要最小限の権限のみ付与される
- [ ] ECS SG に ALB SG からのインバウンドのみ許可される
- [ ] ECS SG のアウトバウンドに全ポート解放がない
- [ ] SSM Parameter が全キー出力される
- [ ] `enableAutoScaling: true` 時に ScalableTarget + ScalingPolicy が作成される
- [ ] `enableAutoScaling` 未指定時に ScalableTarget が作成されない

### バリデーションテスト

- [ ] Fargate 有効な CPU/メモリ組み合わせ以外でエラーになる
- [ ] `ecsMinTaskCount > ecsMaxTaskCount` でエラーになる

### Compliance tests (cdk-nag)

- [ ] ALB アクセスログが有効（stage/prod）
- [ ] SG アウトバウンドに全ポート解放がない
- [ ] IAM ポリシーにワイルドカード `*` がない（正当な例外を除く）

---

## 未確定事項・TODO

| 項目 | 暫定値 | 確認先 |
|------|--------|--------|
| ECS CPU/メモリ（prod） | 1024 / 2048 | アプリ担当 |
| ALB ヘルスチェックパス | `/health` | アプリ担当 |
| ドメイン名 | — | ドメイン担当 |
| Route53 ホストゾーン ID | — | ドメイン担当 |
