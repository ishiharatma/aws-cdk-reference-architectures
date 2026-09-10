# FIS カオスエンジニアリング — アーキテクチャ A: CloudFront + Internal ALB + ECS Fargate + Aurora PostgreSQL

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20CloudFront%20%7C%20ALB%20%7C%20ECS%20Fargate%20%7C%20Aurora%20PostgreSQL-orange?style=flat-square)

## はじめに

本プロジェクトは、**コンテナベースの 3 層 Web アーキテクチャ**に対する AWS Fault Injection Service (FIS) を用いたカオスエンジニアリングのリファレンス実装です。CloudFront が VPC Origin 経由でトラフィックを Internal ALB に転送し、ALB が Private サブネットの ECS Fargate タスク（nginx）にルーティングし、タスクは Isolated サブネットの Aurora PostgreSQL Serverless v2 クラスター（Writer 1 + Reader 1）に接続する構成です。

4 つの FIS 実験テンプレートが、データ・コンピュート・ネットワーク各層で障害を注入します。

| シナリオ | 注入する障害 | 実行時間 | 検証内容 |
| -------- | ------------ | -------- | -------- |
| **A-1** Aurora DB フェイルオーバー | `aws:rds:failover-db-cluster` — Writer→Reader プロモーション | 効果 約30秒 | 接続プールの再接続、リトライロジック、RDS 再接続動作 |
| **A-2** ECS 全タスク停止 | `aws:ecs:stop-task` — 実行中の全タスクを停止 | 単発 | ALB ターゲットのドレイン、CloudFront フォールバック、ECS 自己修復速度 |
| **A-3** ECS→DB ネットワーク遮断 | `aws:ecs:task-network-blackhole-port` — TCP 5432 **送信**をブロック | 5分 | クエリタイムアウト設定、サーキットブレーカー、DB 到達不能時の縮退運転 |
| **A-4** ALB→ECS ネットワーク遮断 | `aws:ecs:task-network-blackhole-port` — TCP 80 **受信**をブロック | 5分 | ALB 異常ホスト検出、CloudFront の S3 フォールバック、ECS タスク置換による回復 |

全 4 テンプレートは、ALB ターゲット 5xx が 1 分間に 50 件を超えると実験を停止する CloudWatch Alarm 停止条件を共有します。

> ### ⚠️ `aws:ecs:task-*` アクションはそのままでは使えない
> A-3 / A-4 は、タスク定義への **`amazon-ssm-agent` サイドカーコンテナ**、`enableFaultInjection: true`、`pidMode: task`、そして **ECS Exec の無効化**が必須です。以前のバージョンは存在しないアクション ID `aws:ecs:network-blackhole-port` を使い、ECS Exec に依存していました — どちらも誤りです。[FIS SSM サイドカー](#fis-ssm-サイドカーa-3--a-4)を参照。

## アーキテクチャ概要

```
ユーザー (HTTPS)
    │
    ▼
CloudFront Distribution  (Origin Group: VPC Origin プライマリ → 502/503/504 で S3 エラーページ)
    │  ビヘイビア: GET/HEAD/OPTIONS のみ（Origin Group では書き込みメソッド不可）
    ▼
Internal ALB  (Private サブネット、CloudFront マネージドプレフィックスリストからのみ受信)
    │  HTTP/80 → ECS Fargate IP ターゲットグループ
    ▼
ECS Fargate サービス  (nginx + amazon-ssm-agent サイドカー、タスク数 2、
    │                  pidMode=task, enableFaultInjection=true, ECS Exec OFF)
    │  TCP 5432（配線済みだが nginx デモは DB 接続を張らない）
    ▼
Aurora PostgreSQL Serverless v2 16.13  (Writer 1 + Reader 1、Isolated サブネット、0.5〜4 ACU)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS 実験テンプレート (FisStack)

A-1  aws:rds:failover-db-cluster ─────────────────────► aws:rds:cluster (Aurora ARN)
A-2  aws:ecs:stop-task ───────────────────────────────► aws:ecs:task  (cluster + service パラメータ)
A-3  aws:ecs:task-network-blackhole-port ─────────────► aws:ecs:task  送信 tcp/5432, PT5M,
                                                         useEcsFaultInjectionEndpoints=true
A-4  aws:ecs:task-network-blackhole-port ─────────────► aws:ecs:task  受信 tcp/80, PT5M,
                                                         useEcsFaultInjectionEndpoints=true
```

### VPC レイアウト

```
VPC 10.10.0.0/16 (2 AZ)
  Public サブネット  /24 ×2   — NAT Gateway ×1、CloudFront VPC Origin ENI
  Private サブネット /24 ×2   — Internal ALB、ECS Fargate タスク
  Isolated サブネット /24 ×2  — Aurora PostgreSQL クラスター
```

### 設計上のポイント

| 特徴 | 理由 |
| ---- | ---- |
| CloudFront VPC Origin → Internal ALB | ALB はインターネットから到達不可。CloudFront が唯一の受信経路 |
| S3 フォールバック付き Origin Group | A-2/A-4 でタスクが停止・遮断された際、502/503/504 で CloudFront が S3 のメンテナンスページを配信可能 |
| `AllowedMethods.ALLOW_GET_HEAD_OPTIONS` | CloudFront は Origin Group にバインドしたビヘイビアで POST/PUT/PATCH/DELETE を**拒否**する。デモは読み取り専用なので問題なし |
| `amazon-ssm-agent` サイドカー + マネージドインスタンスロール | `aws:ecs:task-*` に必須（下記参照） |
| `enableFaultInjection: true`、`pidMode: task` | `aws:ecs:task-network-blackhole-port` に必要。`pidMode: task` は Fargate で `runtimePlatform` の明示も強制する |
| ECS Exec **無効** | AWS FIS ユーザーガイドは `aws:ecs:task-*` アクション使用時に ECS Exec を OFF にすることを要求 |
| ECS タスクターゲットを `parameters: { cluster, service }` で指定 | `aws:ecs:task` をスコープする正式な方法。`cluster.clusterArn` の **filter** は空集合になり実験が失敗する |
| Aurora に Writer + Reader 各 1 台 | `aws:rds:failover-db-cluster` が Reader を昇格させるための最小構成 |
| 停止条件を ALB ターゲット 5xx ≥ 50/分 に一本化 | DB 接続数アラームは削除。nginx デモは DB 接続を張らないため常時 ALARM 状態となり、FIS が A-1 を起動できなかった |

### FIS SSM サイドカー（A-3 / A-4）

`aws:ecs:task-network-blackhole-port` / `-latency` / `-packet-loss` / `-cpu-stress` / `-io-stress` /
`-kill-process` の各アクションは、**SSM ドキュメント経由で障害を注入**します（A-3/A-4 は
`AWSFIS-Run-Network-Blackhole-Port-ECS`）。SSM が Fargate タスクに到達するには、タスクを
**SSM マネージドインスタンスとして登録**する必要があり、そのための唯一のサポート方法が、
AWS-FIS 登録スクリプトを実行する専用サイドカーコンテナです。AWS FIS ユーザーガイドより:

> *"To use `aws:ecs:task` actions, you will need to add a container with an SSM Agent to your
> Amazon ECS task definition … If you enabled Amazon ECS Exec, you must disable it before you
> can use these actions."*

`app-stack.ts` がこのために構成するもの:

| 要素 | 目的 |
| ---- | ---- |
| `amazon-ssm-agent` サイドカーコンテナ（`public.ecr.aws/amazon-ssm-agent/amazon-ssm-agent:latest`、`essential: false`） | AWS-FIS スクリプトをそのまま実行: `ssm create-activation` → `amazon-ssm-agent -register` → `SIGTERM` で `delete-activation` + `deregister-managed-instance`。マネージドインスタンスに `ECS_TASK_ARN` タグを付け、FIS が「タスク → マネージドインスタンス」を対応付けられるようにする |
| `ssmManagedInstanceRole`（`ssm.amazonaws.com` が引き受け） | `AmazonSSMManagedInstanceCore` + `ssm:DeleteActivation` + `ssm:DeregisterManagedInstance`。登録されたマネージドインスタンスが引き受けるロール |
| タスクロールへの追加 | `ssm:CreateActivation`、`ssm:AddTagsToResource`、および `ssmManagedInstanceRole` に**スコープした** `iam:PassRole` |
| タスク定義 env `MANAGED_INSTANCE_ROLE_NAME` | `ssmManagedInstanceRole` の名前。サイドカースクリプトが読む |
| タスク定義の `enableFaultInjection: true` + `pidMode: task` | ECS フォールトインジェクションエンドポイントを有効化。ネットワークアクションはアクションパラメータで `useEcsFaultInjectionEndpoints: 'true'` も必要 |
| サービスの `enableExecuteCommand: false` | ECS Exec は OFF 必須。その SSM エージェントプロセスがサイドカーと競合する |
| FIS 実験ロール | `ecs:DescribeTasks`、`ssm:SendCommand`、`ssm:ListCommands`、`ssm:CancelCommand` |

稼働すると `aws ssm describe-instance-information` にタスクごとに 1 つ、計 2 つの `mi-…`
マネージドインスタンス（`Online`）が現れ、FIS は `ECS_TASK_ARN` タグ経由で `SendCommand` します。

## 前提条件

- AWS CLI v2 のインストールと設定
- Node.js 20 以降
- AWS CDK CLI (`npm install -g aws-cdk`)
- TypeScript と VPC ネットワーキングの基礎知識
- FIS サービスリンクロールが作成済みの AWS アカウント（初回 FIS 使用時に自動作成）

> **コスト注意**: 本構成は NAT Gateway と常時稼働の Aurora Serverless v2 ×2 ACU を含み、
> 起動しっぱなしだと概ね **月 $180〜270** かかります。実験後はスタックを削除してください。
> [コスト見積り](#コスト見積り)を参照。

## プロジェクトディレクトリ構成

```text
fis-arch-a-ecs-aurora/
├── bin/
│   └── fis-arch-a-ecs-aurora.ts              # アプリのエントリポイント（Stage をインスタンス化）
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts                # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                     # VPC + Aurora PostgreSQL Serverless v2 16.13
│       ├── app-stack.ts                      # ECS Fargate（+ SSM サイドカー）+ Internal ALB + CloudFront (VPC Origin)
│       └── fis-stack.ts                      # 4 つの FIS 実験テンプレート + IAM + アラーム
├── parameters/
│   ├── environments.ts                       # 環境パラメータ型
│   ├── dev-params.ts                         # 開発環境パラメータ
│   └── index.ts                              # パラメータのエクスポート
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts                   # cdk-nag AwsSolutions コンプライアンスチェック
│   └── snapshot/
│       └── snapshot.test.ts                  # CDK スナップショットテスト
├── cdk.json
├── package.json
└── tsconfig.json
```

## デプロイ手順

### 1. 依存関係のインストール

```bash
cd infrastructure
npm ci
```

### 2. 環境パラメータの設定

```typescript
// parameters/dev-params.ts
const devParams: EnvParams = {
    region: 'ap-northeast-1',
    // alarmEmail: 'ops@example.com',
    // cloudfrontManagedPrefixList: 'pl-58a04531',  // ap-northeast-1 の CloudFront プレフィックスリスト
};
```

### 3. CDK ブートストラップ（初回のみ）

```bash
PROJECT=<project> ENV=dev npm run bootstrap -w workspaces/fis-arch-a-ecs-aurora
```

### 4. 全スタックのデプロイ

```bash
PROJECT=<project> ENV=dev npm run stage:deploy:all -w workspaces/fis-arch-a-ecs-aurora -- --require-approval never
```

依存順:
1. `<project>-dev-base` — VPC + Aurora クラスター（約10分。Aurora が最も時間がかかる）
2. `<project>-dev-app` — ECS Fargate + SSM サイドカー + Internal ALB + CloudFront（約8分。CloudFront ディストリビューション + VPC オリジン）
3. `<project>-dev-fis` — FIS テンプレート + IAM + アラーム（約1分）

> このワークスペースは一部の固定リソース名（Aurora シークレット `…-aurora-secret`、
> `…-fis-role` ロール）を**アーキテクチャ C** と共有します。同一アカウント + リージョンに
> A / C を同時にデプロイせず、一方ずつにするか、名前を分けてください。

### 5. ワークロードのスモークテスト

```bash
CF=$(aws cloudformation describe-stacks --stack-name <project>-dev-app \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text)
curl -s -o /dev/null -w '%{http_code}\n' "https://$CF/"     # → 200（nginx ウェルカムページ）
```

### 6. FIS 実験の実行

**コンソール**: FIS → 実験テンプレート → `A-1`〜`A-4`（`Scenario` タグ）を選択 → **実験を開始**。

**CLI**:

```bash
aws fis list-experiment-templates \
  --query "experimentTemplates[?tags.Architecture=='CloudFront-ALB-ECS-Aurora'].{id:id,scenario:tags.Scenario}" \
  --output table

EXP=$(aws fis start-experiment --experiment-template-id <EXT...> --query "experiment.id" --output text)
watch -n5 "aws fis get-experiment --id $EXP --query 'experiment.{s:state.status,a:actions}'"
```

実験中に確認すると有用なサイドチャネル:

```bash
# ECS 自己修復（A-2 / A-4）
aws ecs describe-services --cluster <cluster> --services <svc> --query 'services[0].events[:8]'
# SSM ドキュメント実行（A-3 / A-4）
aws ssm list-commands --query 'Commands[:3].{doc:DocumentName,status:Status,ok:CompletedCount,err:ErrorCount}'
# 実際の Aurora フェイルオーバー（A-1）
aws rds describe-events --duration 20 --query "Events[?contains(Message,'failover')]"
```

### 実測結果（ap-northeast-1）

| シナリオ | 起きたこと | 備考 |
| -------- | ---------- | ---- |
| **A-1** | `describe-events` に約20秒以内で *"Started / Completed cross AZ failover to … reader1"*。CloudFront は全期間 200 | nginx デモは DB 接続を持たないため再接続対象がない。実際の DB クライアントに差し替えるとプール回復挙動が観測できる |
| **A-2** | FIS が両タスクを停止 → 数秒後に ECS *"has started 2 tasks"*、約45秒で steady state。CloudFront は 200 維持（Origin Group フォールバック + 高速置換） | |
| **A-3** | SSM ドキュメント `AWSFIS-Run-Network-Blackhole-Port-ECS` が両タスクで実行（2/2 成功）。port 5432 送信のみ、かつ nginx は未使用のためワークロード影響なし | サイドカー + `useEcsFaultInjectionEndpoints` 経路がエンドツーエンドで機能することを確認 |
| **A-4** | 約75秒間 CloudFront が `000`（接続失敗）、一時的に S3 フォールバックオリジンから `404`、その後**実験実行中のまま** 200 に回復（ECS が異常タスクを未遮断の新タスクに置換） | 置換による回復挙動自体が有用なレジリエンス知見 |

ALB-5xx 停止条件（≥ 50/分）はどの実行でも発火しませんでした。

## テスト

```bash
cd infrastructure
npm run test           -w workspaces/fis-arch-a-ecs-aurora
npm run test:snapshot  -w workspaces/fis-arch-a-ecs-aurora
npm run test:compliance -w workspaces/fis-arch-a-ecs-aurora
npm run test:snapshot:update -w workspaces/fis-arch-a-ecs-aurora   # 意図的な変更の後
```

| テストスイート | ファイル | アサーション |
| -------------- | -------- | ------------ |
| スナップショット | `test/snapshot/snapshot.test.ts` | 3 スタックの完全な CFn スナップショット、Aurora Writer+Reader、タスク定義に SSM サイドカー + `EnableFaultInjection` + `PidMode: task`、ALB が internal、ちょうど 4 つの FIS テンプレート、全テンプレートに停止条件 |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions パック — 未抑制の指摘なし |

## コスト見積り

価格は **オンデマンドのリスト価格（2026 年 9 月、AWS Price List API で取得）**で、AWS 無料利用枠は除外。
リージョンは **バージニア北部 `us-east-1`** と **東京 `ap-northeast-1`**。

### アイドル / 定常状態（月あたり、約730時間、トラフィックなし）

| サービス | 基準 | us-east-1 | ap-northeast-1 |
| -------- | ---- | --------- | -------------- |
| Aurora Serverless v2 | 2 インスタンス × 0.5 ACU 下限 × 730h × ($0.12 / $0.15 per ACU-h) | ~$87.60 | ~$109.50 |
| NAT Gateway (×1) | 730h × ($0.045 / $0.062 per h) + わずかなデータ | ~$33 | ~$46 |
| ECS Fargate | 2 タスク × (0.5 vCPU + 1 GB) × 730h。vCPU $0.04048 / $0.05056、GB $0.004445 / $0.005530 | ~$36 | ~$45 |
| ALB | 730h × ($0.0225 / $0.0243 per h) + 約1 LCU × $0.008 | ~$22 | ~$24 |
| Secrets Manager | シークレット 1 個 × $0.40 | $0.40 | $0.40 |
| Aurora ストレージ / CloudWatch アラーム / ログ | 数 GB + アラーム 1 個 ($0.10) | ~$1 | ~$1 |
| **合計（24×7 稼働）** | | **≈ $180 / 月** | **≈ $270 / 月** |

### 1 テストサイクル（デプロイ → 4 実験すべて実行 → 削除、約 1.5〜2 時間の稼働）

| サービス | 使用量の前提 | us-east-1 | ap-northeast-1 |
| -------- | ------------ | --------- | -------------- |
| **FIS** | A-1 + A-2 は短時間、A-3 + A-4 = 各 PT5M → **約 12〜16 アクション分** @ $0.10 | **~$1.20〜1.60** | **~$1.20〜1.60** |
| Aurora Serverless v2 | 約2h × 2 × 0.5 ACU（フェイルオーバー中は一時スパイク） | ~$0.30 | ~$0.35 |
| NAT + Fargate + ALB | 上記アイドルレートで約2h | ~$0.40 | ~$0.50 |
| Secrets Manager / CloudWatch | 按分 | <$0.05 | <$0.05 |
| **1 サイクル合計** | | **≈ $2** | **≈ $2.5** |

**このドキュメントの以前のバージョンからの訂正:** FIS は**無料ではありません**。**アクション分あたり
$0.10**（両リージョン同一）で課金されます。定常コストも過小評価でした — 常時稼働の Aurora ACU ×2 と
NAT Gateway が支配的で、月 ~$180 (us-east-1) / ~$270 (東京) です。

## セキュリティに関する考慮事項

- **ALB は internal** — インターネット非公開。CloudFront VPC Origin が唯一の入口。
- **FIS 実験ロール — 最小権限**: Aurora ARN への `rds:FailoverDBCluster`、クラスターにスコープした `ecs:StopTask`/`DescribeTasks`/`ListTasks`、ECS タスクアクション用の `ssm:SendCommand`/`ListCommands`/`CancelCommand`、停止条件アラーム 1 個への `cloudwatch:DescribeAlarms`、CloudWatch Logs 配信アクション。
- **SSM マネージドインスタンスロール — 最小権限**: `AmazonSSMManagedInstanceCore` + `ssm:DeleteActivation` / `ssm:DeregisterManagedInstance` のみ（シャットダウン時の自己登録解除）。タスクロールの `iam:PassRole` はこのロールの ARN にスコープ。
- **ECS Exec 無効** — `ssmmessages:*` の面を完全に排除。SSM 経路はサイドカーのみで、`SIGTERM` で自己登録解除する。
- **停止条件は必須** — 全テンプレートが ALB-5xx アラーム停止条件を持つ。

## クリーンアップ

```bash
PROJECT=<project> ENV=dev npm run stage:destroy:all -w workspaces/fis-arch-a-ecs-aurora -- --force
```

全リソースが `removalPolicy: DESTROY`。ロールバックで `ErrorPageBucket` が空でなくなった場合は
空にして（`aws s3 rm s3://<bucket> --recursive`）から destroy を再実行してください。Aurora
シークレットは強制削除しない限り復旧ウィンドウ付きで保持されます
（`aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery`）。

## まとめ

コンテナ 3 層 Web スタックに対する FIS カオスエンジニアリング:

- **A-1** — Aurora Writer→Reader フェイルオーバー: アプリは再接続するか？
- **A-2** — ECS 全タスク停止: ALB はドレインし ECS は十分速く自己修復するか？
- **A-3** — DB 送信経路を遮断: クエリタイムアウトとサーキットブレーカーは正しいか？
- **A-4** — タスクへの受信を遮断: ALB は異常ホストを検出し CloudFront はフォールバックするか？

重い作業は A-3/A-4 です。`aws:ecs:task-*` は専用の SSM サイドカー、`enableFaultInjection`、
`pidMode: task`、そして ECS Exec **無効**を必要とします。スタックの稼働コストは月 ~$180〜270、
4 実験のフルテストサイクルは約 **$2**（大半が FIS のアクション分課金）です。

## 参考資料

- [AWS FIS — アクションリファレンス](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [AWS FIS `aws:ecs:task` アクションの使用（SSM サイドカー設定）](https://docs.aws.amazon.com/fis/latest/userguide/ecs-task-actions.html)
- [AWS FIS — ターゲット（リソースパラメータ、フィルタ）](https://docs.aws.amazon.com/fis/latest/userguide/targets.html)
- [AWS FIS の料金](https://aws.amazon.com/fis/pricing/)
- [CDK `aws-fis` モジュール（L1 コンストラクト）](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
- [CloudFront VPC Origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)
