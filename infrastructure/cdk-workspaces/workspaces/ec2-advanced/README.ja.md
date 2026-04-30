# EC2 Advanced Patterns<!-- omit in toc -->

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-orange?style=flat-square)
![Services](https://img.shields.io/badge/Services-EC2%20%7C%20ALB%20%7C%20ASG-purple?style=flat-square)

## 目次<!-- omit in toc -->

- [はじめに](#はじめに)
- [アーキテクチャ概要](#アーキテクチャ概要)
  - [共通インフラ](#共通インフラ)
  - [パターン比較](#パターン比較)
- [前提条件](#前提条件)
- [プロジェクト構成](#プロジェクト構成)
- [パターン1: EC2 単一インスタンス](#パターン1-ec2-単一インスタンス)
  - [主な特徴](#主な特徴)
  - [実装例](#実装例)
  - [適した用途](#適した用途)
- [パターン2: EC2 オートリカバリー](#パターン2-ec2-オートリカバリー)
  - [主な特徴](#主な特徴-1)
  - [実装例](#実装例-1)
  - [オートリカバリーの仕組み](#オートリカバリーの仕組み)
  - [適した用途](#適した用途-1)
- [パターン3: Auto Scaling Group — 常時1台構成](#パターン3-auto-scaling-group--常時1台構成)
  - [サブモード A: ALB あり](#サブモード-a-alb-あり)
  - [サブモード B: ALB なし（SSM のみ）](#サブモード-b-alb-なしssm-のみ)
  - [パターン2 vs パターン3（ALB なし）の比較](#パターン2-vs-パターン3alb-なしの比較)
- [パターン4: Auto Scaling Group — 常時2台 マルチAZ構成](#パターン4-auto-scaling-group--常時2台-マルチaz構成)
  - [主な特徴](#主な特徴-2)
  - [実装例](#実装例-2)
  - [適した用途](#適した用途-2)
- [セキュリティ設計](#セキュリティ設計)
- [運用監視](#運用監視)
- [nginx サンプルページ](#nginx-サンプルページ)
- [デプロイ](#デプロイ)
- [インスタンスへの接続](#インスタンスへの接続)
- [クリーンアップ](#クリーンアップ)

## はじめに

このワークスペースでは、AWS CDK を使って4つの EC2 デプロイパターンを実装します。各パターンは単純な単一インスタンスから ALB 配下のマルチAZ Auto Scaling Group まで、可用性と運用の複雑さが異なります。

このアーキテクチャでは、以下の実装を確認することができます。

- EC2 インスタンスのセキュアな配置（IMDSv2 必須化、EBS 暗号化、パブリック IP なし）
- SSM Session Manager によるアクセス（SSH キーや踏み台サーバー不要）
- CloudWatch アラームを使った単一インスタンスのオートリカバリー
- ALB 配下の Auto Scaling Group による耐障害性の高いデプロイ
- マルチAZ 高可用性構成とローリングアップデートデプロイ
- インスタンス識別情報（ホスト名 / インスタンスID / AZ）を表示する nginx サンプルページ
- 共有 SNS Topic による障害通知（全パターン共通 — StatusCheckFailed / オートリカバリー / ASGイベント / CPUアラーム）

## アーキテクチャ概要

![アーキテクチャ概要](overview.drawio.svg)

4つのパターンはすべて共通の VPC スタックを共有します。各パターンスタックは独立してデプロイされます。

### 共通インフラ

- **VPC**: 2つの AZ にまたがる Public/Private サブネットを持つカスタム VPC
- **NAT**: コスト削減のためのスケジュール起動/停止付き NAT インスタンス（t4g.nano）
- **アクセス**: SSM Session Manager（パターン1・2・3b）または ALB HTTP（パターン3a・4）
- **SNS Topic**: 全パターンで共有する通知トピック（CloudWatch アラームのアクションとして設定）

### パターン比較

| # | パターン | アクセス | 可用性 | 通知 | 用途 |
|---|---------|--------|------|------|------|
| 1 | EC2 単一 | SSM | 単一インスタンス | StatusCheckFailed アラーム | 開発 / テスト |
| 2 | EC2 オートリカバリー | SSM | HW 障害時に自動復旧 | 復旧トリガー / 完了通知 | 単純ワークロードの HA |
| 3a | ASG 常時1台 + ALB | ALB HTTP | ヘルスチェック失敗時に自動置換 | ASGイベント / CPU / UnhealthyHost | ローリングデプロイ付き単一インスタンス |
| 3b | ASG 常時1台（SSMのみ）| SSM | ヘルスチェック失敗時に自動置換 | ASGイベント / CPU | ALBなし低コスト構成 |
| 4 | ASG 常時2台 マルチAZ + ALB | ALB HTTP | AZ レベルの冗長性 | ASGイベント / CPU / UnhealthyHost | 本番ワークロード |

## 前提条件

- AWS CLI v2 のインストールと設定
- Node.js 20+
- AWS CDK CLI（`npm install -g aws-cdk`）
- TypeScript の基礎知識
- 適切な IAM 権限を持つ AWS アカウント

## プロジェクト構成

```text
ec2-advanced/
├── bin/
│   └── ec2-advanced.ts              # アプリケーションエントリーポイント
├── lib/
│   ├── constructs/
│   │   ├── ec2-single.ts            # パターン1: 単一EC2 Construct
│   │   ├── ec2-auto-recovery.ts     # パターン2: オートリカバリー Construct
│   │   ├── ec2-asg-single.ts        # パターン3: ASG min=1/max=1 Construct
│   │   ├── ec2-asg-multi.ts         # パターン4: ASG min=2/max=2 Construct
│   │   └── index.ts                 # 再エクスポートハブ
│   ├── stacks/
│   │   ├── base-stack.ts            # 共有 VPC スタック
│   │   ├── ec2-single-stack.ts      # パターン1スタック
│   │   ├── ec2-auto-recovery-stack.ts # パターン2スタック
│   │   ├── ec2-asg-single-stack.ts  # パターン3スタック
│   │   └── ec2-asg-multi-stack.ts   # パターン4スタック
│   └── stages/
│       └── ec2-advanced-stage.ts    # ステージオーケストレーション（全5スタック）
├── parameters/
│   ├── environments.ts              # EnvParams 型定義
│   └── dev-params.ts                # 開発環境パラメータ
├── src/
│   └── nginx-userdata.ts            # nginx サンプルページ用 User Data スクリプト
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts          # CDK Nag コンプライアンステスト
│   ├── parameters/
│   │   └── test-params.ts           # テスト環境パラメータ
│   ├── snapshot/
│   │   └── snapshot.test.ts         # スナップショットテスト
│   └── unit/
│       └── ec2-advanced.test.ts     # ユニットテスト（39件）
├── cdk.json
├── package.json
└── tsconfig.json
```

## パターン1: EC2 単一インスタンス

最もシンプルなデプロイ: プライベートサブネット内の EC2 インスタンス1台に SSM Session Manager でアクセスします。

### 主な特徴

- ロードバランサーなし、パブリック IP なし
- LaunchTemplate 経由で IMDSv2 を必須化
- EBS ルートボリューム: GP3、暗号化済み
- SSM Session Manager アクセス（SSH キー不要）
- Amazon Linux 2023（ARM64 / Graviton）
- `StatusCheckFailed` CloudWatch アラーム（システム障害 + インスタンス障害）→ SNS 通知

### 実装例

```typescript
export class Ec2Single extends Construct {
  public readonly instance: ec2.IInstance;

  constructor(scope: Construct, id: string, props: Ec2SingleProps) {
    super(scope, id);

    const instance = new ec2.Instance(this, 'Resource', {
      vpc: props.vpc,
      instanceType: props.instanceType,
      machineImage: props.machineImage,
      securityGroup: props.securityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(8, {
          encrypted: true,
          volumeType: ec2.EbsDeviceVolumeType.GP3,
        }),
      }],
      ssmSessionPermissions: true,
      requireImdsv2: true,
      userData,
    });

    // StatusCheckFailed アラーム（システム障害 + インスタンス障害）
    if (props.notificationTopic) {
      const alarm = new cloudwatch.Alarm(this, 'StatusCheckAlarm', {
        metric: new cloudwatch.Metric({
          namespace: 'AWS/EC2',
          metricName: 'StatusCheckFailed',
          dimensionsMap: { InstanceId: instance.instanceId },
          statistic: 'Maximum',
          period: cdk.Duration.minutes(1),
        }),
        threshold: 1,
        evaluationPeriods: 2,
      });
      alarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
      alarm.addOkAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
    }
  }
}
```

### 適した用途

- 開発 / テスト環境
- 高可用性が不要なバッチジョブやスケジュールタスク
- 障害時の再起動時間が許容できるワークロード

## パターン2: EC2 オートリカバリー

単一インスタンスパターンに CloudWatch アラームを追加します。ハードウェア障害が検出されると、AWS が自動的にインスタンスを復旧します（インスタンスID・プライベートIP・EBS ボリュームは引き継がれます）。

### 主な特徴

- パターン1に加え、`StatusCheckFailed_System` メトリクスの CloudWatch アラームを追加
- システム障害検出後、数分以内に自動復旧
- インスタンスIDとプライベート IP は復旧後も維持される
- OS レベルの障害では復旧しない（ハードウェア / ハイパーバイザー障害のみ対応）
- オートリカバリー発火時と復旧完了時に SNS 通知

### 実装例

```typescript
// システムステータスチェック失敗の CloudWatch アラーム
const alarm = new cloudwatch.Alarm(this, 'SystemStatusAlarm', {
  metric: new cloudwatch.Metric({
    namespace: 'AWS/EC2',
    metricName: 'StatusCheckFailed_System',
    dimensionsMap: { InstanceId: instance.instanceId },
    period: cdk.Duration.minutes(1),
    statistic: 'Maximum',
  }),
  evaluationPeriods: props.recoveryEvaluationPeriods ?? 2,
  threshold: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});

// EC2 オートリカバリーアクションを設定
alarm.addAlarmAction(
  new cloudwatch_actions.Ec2Action(cloudwatch_actions.Ec2InstanceAction.RECOVER)
);
// SNS 通知: 復旧トリガー時と復旧完了時
if (props.notificationTopic) {
  alarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
  alarm.addOkAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
}
```

### オートリカバリーの仕組み

```text
システムステータスチェック失敗を検知
  └─ CloudWatch アラームが ALARM 状態に遷移（2分連続で失敗）
       └─ EC2 オートリカバリーアクションが発火
            └─ インスタンスが正常なホストに移行
                 └─ インスタンスID / プライベートIP / EBS ボリュームは引き継がれる
```

> ⚠️ インスタンスストアボリュームを持つインスタンスではオートリカバリーはサポートされません。

### 適した用途

- ハードウェア障害への耐性が必要な単一インスタンスワークロード
- プライベート IP アドレスを変更できない要件がある場合
- 非クリティカルなサービスのコスト効率の良い HA 構成

## パターン3: Auto Scaling Group — 常時1台構成

`min=1 / desired=1 / max=1` の ASG で、インスタンスが異常になると自動的に置換します。`Ec2AsgSingle` construct は `listener` の有無によって2つのサブモードをサポートします。

### サブモード A: ALB あり

インスタンスを Application Load Balancer のターゲットとして登録します。

**主な特徴:**
- ALB による HTTP アクセス（デフォルト80番ポート）
- LaunchTemplate 経由で IMDSv2 を必須化
- ローリングアップデート: CDK 再デプロイ時にダウンタイムなしでインスタンスを置換
- EC2 と ALB 両レベルのヘルスチェック
- ASG スケーリングイベント通知（起動 / 終了 / エラー）→ SNS
- ALB UnhealthyHost アラーム → SNS
- CPU 使用率アラーム（80% 超過 / 回復）→ SNS

```typescript
const asg = new autoscaling.AutoScalingGroup(this, 'Resource', {
  vpc: props.vpc,
  launchTemplate,
  minCapacity: 1,
  maxCapacity: 1,
  desiredCapacity: 1,
  healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
    additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
    gracePeriod: Duration.seconds(60),
  }),
  updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
  notifications: props.notificationTopic
    ? [{ topic: props.notificationTopic, scalingEvents: autoscaling.ScalingEvents.ALL }]
    : undefined,
});

// listener が指定された場合のみ ALB ターゲットとして登録
props.listener.addTargets('AsgTargets', {
  port: props.instancePort ?? 80,
  targets: [asg],
  healthCheck: { path: props.healthCheckPath ?? '/' },
});
```

**適した用途:**
- HTTP アクセスをロードバランサー経由で提供するアプリケーション
- SSH キー管理なしにローリングデプロイを行いたい場合
- ステージング / 本番前環境

### サブモード B: ALB なし（SSM のみ）

ロードバランサーを作成せず、SSM Session Manager 経由のアクセスのみになります。ASG は EC2 インスタンスヘルスチェックを使用し、障害時にインスタンスを置換します。

**主な特徴:**
- ALB なし、パブリック IP なし — SSM Session Manager アクセスのみ
- LaunchTemplate 経由で IMDSv2 を必須化
- EC2 ヘルスチェック（インスタンスレベルの障害でも置換）
- ALB コストなし（サブモード A より低コスト）
- オートリカバリー（パターン2）と異なり、置換後のインスタンスは **新しい** インスタンスID・プライベートIPになる
- ASG スケーリングイベント通知 → SNS
- CPU 使用率アラーム（80% 超過 / 回復）→ SNS

```typescript
const asg = new autoscaling.AutoScalingGroup(this, 'Resource', {
  vpc: props.vpc,
  launchTemplate,
  minCapacity: 1,
  maxCapacity: 1,
  desiredCapacity: 1,
  healthChecks: autoscaling.HealthChecks.ec2({ gracePeriod: Duration.seconds(60) }),
  updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
  notifications: props.notificationTopic
    ? [{ topic: props.notificationTopic, scalingEvents: autoscaling.ScalingEvents.ALL }]
    : undefined,
});
// listener.addTargets() は呼ばない — SSM のみアクセス
```

**適した用途:**
- OS レベルの障害でも自動置換が必要なワークロード（ハードウェア障害だけでなく）
- 置換後にプライベート IP が変わっても問題ないサービス
- ALB が不要でコストを抑えたい環境

### パターン2 vs パターン3（ALB なし）の比較

| 項目 | パターン2: オートリカバリー | パターン3（ALB なし）: ASG |
|------|--------------------------|---------------------------|
| 復旧の仕組み | 同じインスタンスをインプレースで復旧 | 旧インスタンスを削除 → 新インスタンスを起動 |
| 復旧後のインスタンスID | **同じ** | **変わる** |
| 復旧後のプライベートIP | **同じ** | **変わる** |
| 対応する障害 | ハードウェア / ハイパーバイザー障害のみ | ハードウェア障害 + OS レベルの障害 |
| ALB | 不要 | 不要 |
| 復旧速度 | 数分（インプレース復旧） | やや遅い（新規インスタンス起動） |

## パターン4: Auto Scaling Group — 常時2台 マルチAZ構成

パターン3を拡張し、`min=2 / desired=2 / max=2` のインスタンスを複数のアベイラビリティゾーンに分散配置します。一方の AZ に障害が発生しても、残りのインスタンスがトラフィックを継続して処理します。

### 主な特徴

- 2つの AZ にまたがる2台のインスタンス（AZ レベルの冗長性）
- ALB ヘルスチェックによる自動インスタンス置換
- `minInstancesInService: 1` でのローリングアップデート（デプロイ中もゼロダウンタイム）
- `minCapacity` / `maxCapacity` プロパティで台数を調整可能
- ASG スケーリングイベント通知（起動 / 終了 / エラー）→ SNS
- ALB UnhealthyHost アラーム → SNS
- CPU 使用率アラーム（80% 超過 / 回復）→ SNS

### 実装例

```typescript
const asg = new autoscaling.AutoScalingGroup(this, 'Resource', {
  vpc: props.vpc,
  launchTemplate,
  minCapacity: props.minCapacity ?? 2,
  maxCapacity: props.maxCapacity ?? 2,
  desiredCapacity: props.minCapacity ?? 2,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
    additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
    gracePeriod: cdk.Duration.seconds(60),
  }),
  updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
    minInstancesInService: 1,  // ローリングアップデート中も最低1台を稼働させる
  }),
  notifications: props.notificationTopic
    ? [{ topic: props.notificationTopic, scalingEvents: autoscaling.ScalingEvents.ALL }]
    : undefined,
});
```

### 適した用途

- AZ レベルの冗長性が必要な本番ワークロード
- ゼロダウンタイムデプロイが必要なアプリケーション
- 1つの AZ 障害でサービス断が許容されないサービス

## セキュリティ設計

すべてのパターンで以下のセキュリティベストプラクティスを適用しています。

| セキュリティ制御 | 実装方法 |
|--------------|--------|
| IMDSv2 必須化 | LaunchTemplate 経由で `requireImdsv2: true` |
| SSH キー不要 | SSM Session Manager（`ssmSessionPermissions: true`）|
| パブリック IP なし | インスタンスはプライベートサブネットのみに配置 |
| EBS 暗号化 | `encrypted: true` の GP3 ルートボリューム |
| 最小権限のセキュリティグループ | EC2 SG: アウトバウンドのみ; ALB SG: 許可 IP からの HTTP のみ |
| ALB IP 制限 | `allowedIpsforAlb` プロパティでソース CIDR を制限 |

## 運用監視

すべてのパターンで共有 SNS Topic（BaseStack に作成）を通じた CloudWatch アラーム通知を実装しています。

| パターン | アラーム / イベント | 通知タイミング |
|---------|-----------------|-------------|
| 1: EC2 単一 | `StatusCheckFailed`（システム + インスタンス） | 障害検知 / 回復 |
| 2: オートリカバリー | `StatusCheckFailed_System` + EC2 Recover | 復旧トリガー / 復旧完了 |
| 3a/3b/4: ASG | ASG スケーリングイベント（ALL） | インスタンス起動 / 終了 / エラー |
| 3a/4: ASG + ALB | ALB `UnhealthyHostCount` ≥ 1 | 異常インスタンス検知 / 回復 |
| 3a/3b/4: ASG | `CPUUtilization` ≥ 80%（5分平均 × 3期間） | CPU 高負荷 / 回復 |

SNS サブスクリプション（Email / Slack など）は `BaseStack` の `notificationTopic` に対して追加してください。

## nginx サンプルページ

すべてのインスタンスは、インスタンス識別情報を表示する nginx サンプルページを提供します。EC2 起動時の User Data で以下を実行します。

1. nginx のインストール（Amazon Linux 2023 上で `dnf install -y nginx`）
2. IMDSv2 トークンの取得
3. インスタンスメタデータから `instance-id`、`placement/availability-zone`、`hostname` を取得
4. インスタンス情報を含む HTML ページを生成
5. nginx を起動・有効化

結果として、各インスタンスは自身の **ホスト名**、**インスタンスID**、**アベイラビリティゾーン** を表示するページを提供します。ALB パターン（3・4）ではページをリロードすると、異なるインスタンスが表示される場合があります。

## デプロイ

```bash
# 依存関係のインストール（ワークスペースルートから）
cd infrastructure/cdk-workspaces
npm install

# このワークスペースに移動
cd workspaces/ec2-advanced

# ブートストラップ（初回のみ）
npx cdk bootstrap --context project=myproject --context env=dev

# 合成（テンプレート生成）
npx cdk synth --context project=myproject --context env=dev

# 全スタックをデプロイ
npx cdk deploy --all --context project=myproject --context env=dev
```

> `allowedIpsforAlb` パラメータは `bin/ec2-advanced.ts` 内の `getMyGlobalIpCidr()` によって現在のグローバル IP に自動的に設定されます。

## インスタンスへの接続

**パターン1・2（SSM Session Manager）:**

```bash
# CloudFormation の出力からインスタンスIDを取得
aws cloudformation describe-stacks \
  --stack-name DevMyprojectSingle \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text

# SSM セッションを開始
aws ssm start-session --target <instance-id>
```

**パターン3・4（ALB）:**

```bash
# CloudFormation の出力から ALB の DNS 名を取得
aws cloudformation describe-stacks \
  --stack-name DevMyprojectAsgSingle \
  --query 'Stacks[0].Outputs[?OutputKey==`AlbDnsName`].OutputValue' \
  --output text

# ブラウザまたは curl で確認
curl http://<alb-dns-name>/
```

## クリーンアップ

```bash
# 全スタックを削除
npx cdk destroy --all --context project=myproject --context env=dev
```

> ⚠️ スタックを削除すると、すべての EC2 インスタンスと VPC が削除されます。このアーキテクチャにはデータストアが含まれていないため、データの消失はありません。