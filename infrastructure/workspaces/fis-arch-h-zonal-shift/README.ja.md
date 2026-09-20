# FIS カオスエンジニアリング — アーキテクチャ H: Auto ScalingにおけるARC Zonal Shift

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20ARC%20%7C%20NLB%20%7C%20EC2%20ASG%20%7C%20Aurora-orange?style=flat-square)

## はじめに

本プロジェクトは[アーキテクチャG](../fis-arch-g-multiaz-network)の直接の続編です。GのG-2シナリオ（`aws:network:disrupt-connectivity`、`scope: all`で1つのアベイラビリティーゾーンのネットワークを遮断）は、Amazon EC2 Auto Scalingのデフォルトのセルフヒーリングが持つ実際の限界を実機検証で明らかにしました。ネットワーク分断によってインスタンスがターゲットグループのヘルスチェックに失敗すると、Auto Scalingはそれをインスタンスが実際に壊れている状態と区別できず、そのAZ回避ロジックは**起動失敗**の場合にのみ発動し、起動後のヘルスチェック失敗では発動しません。G-2で観測した結果は、代替インスタンスがまだ分断されたままのAZにそのまま配置されるというものでした。

本ワークスペースはアーキテクチャGと同じNLB → EC2 Auto Scaling Group（2AZ）→ Aurora PostgreSQL Multi-AZの基盤をデプロイしますが、今回はASGをAmazon Application Recovery Controller（ARC）の機能である**[Auto Scaling group zonal shift](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-zonal-shift.html)**に登録し、運用者が発動するZonal ShiftがG-2で明らかになった結果を実際に変えるかどうかを実機検証します。

📁 **コードリポジトリ**: [fis-arch-h-zonal-shift](https://github.com/ishiharatma/aws-cdk-reference-architectures/tree/main/infrastructure/workspaces/fis-arch-h-zonal-shift)

### このワークスペースで学べること

- CDKでAuto ScalingグループをARC Zonal Shiftに登録する方法（`AvailabilityZoneImpairmentPolicy`——まだL2の`AutoScalingGroup`コンストラクトには存在しないため、L1エスケープハッチを使用）
- `ReplaceUnhealthy`と`IgnoreUnhealthy`の正確な挙動の違い、そしてなぜ通常は起動時の失敗（ヘルスチェックの失敗ではなく）だけがAuto Scalingに悪いAZを自律的に回避させるのか
- AWS CLIでASGに対するZonal Shiftを開始・確認・終了する方法、そしてアーキテクチャGのG-2で既に実機検証済みの障害に対してそれがどう影響するかの観測

## アーキテクチャ概要

```
Internet ──► NLB（インターネット向け、2AZ）──► EC2 ASG（nginx、2AZ、zonal-shift対応）──► Aurora PostgreSQL Multi-AZ
```

| コンポーネント | 役割 |
| -------------- | ---- |
| NLB | インターネット向け、クロスゾーン負荷分散有効——アーキテクチャGと同一 |
| EC2 Auto Scaling Group | `minCapacity=2`、`maxCapacity=4`；`AvailabilityZoneImpairmentPolicy.ZonalShiftEnabled: true`；`InstanceMaintenancePolicy`（100/150%）により旧インスタンス終了前に代替インスタンスを準備完了させる |
| Aurora PostgreSQL Serverless v2 | writer 1台 + reader 1台、Multi-AZ——アーキテクチャGの基盤との整合性のために保持。ここではFISの対象ではない |
| AWS FIS | 実験テンプレート1つ（H-1）——アーキテクチャGのG-2と全く同じ障害 |
| ARC Zonal Shift | CDKではプロビジョニング**しない**——既にデプロイ済みのASGに対する、実行時の運用者主導のアクション（[デプロイ手順](#デプロイ手順)を参照） |

| シナリオ | 注入する障害 | 継続時間 | 検証内容 |
| -------- | ------------ | -------- | -------- |
| **H-1**（Zonal Shiftなし） | `aws:network:disrupt-connectivity`、`scope: all`、AZ-1のサブネット | 5分 | 対照実験：アーキテクチャGのG-2の結果を正確に再現 |
| **H-1**（AZ-1へのZonal Shift発動中） | 同一の障害、同一のテンプレート | 5分 | Auto Scalingが代替インスタンスを実際にAZ-2に起動するかどうか |

## なぜ「Gの繰り返し」ではないのか

アーキテクチャGは既に*問題*を実機検証済みです。本ワークスペースはその障害の2回目の複製ではなく、文書化されたAWSの*対応*メカニズムが結果を変えるかどうかのテストです。ここでのFIS実験テンプレートは意図的にG-2と同一であり、テスト対象となる唯一の変数は、`AvailabilityZoneImpairmentPolicy`と発動中のZonal Shiftが、同じ障害が発生したときのAuto Scalingの挙動を変えるかどうかです。

### なぜ`ReplaceUnhealthy`なのか、そしてなぜ自動発動ではないのか

[Auto Scaling group Availability Zone distribution](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-availability-zone-balanced.html)というAWS公式ドキュメントは、なぜG-2があのような挙動をしたのかを明確に説明しています。

> Amazon EC2 Auto Scaling automatically tries to maintain equivalent numbers of instances in each enabled Availability Zone. Amazon EC2 Auto Scaling does this by attempting to launch new instances in the Availability Zone with the fewest instances. **If the attempt fails, however, Amazon EC2 Auto Scaling attempts to launch the instances in another Availability Zone until it succeeds.**

AZ回避は**起動の失敗**（容量不足、サブネットのIPアドレス枯渇、Spot価格が上限超過）によってのみ発動します。ネットワーク分断はこれを引き起こしません——インスタンスはAZ-1で問題なくブートし、その後到達不能になるだけです。これはターゲットグループのヘルスチェック失敗として表面化しますが、AZ回避ロジックが監視しているシグナルとは別物です。

[Auto Scaling group zonal shift](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-zonal-shift.html)はこのギャップを埋めますが、自動ではなく意図的な操作です——運用者（または自動化されたpractice run）が先にそのAZを異常と宣言する必要があります。

> **Scaling out** – Auto Scaling will launch all new capacity requests in the healthy Availability Zones.
>
> | Impaired AZ health check behavior | Health check behavior |
> |---|---|
> | Replace unhealthy | Instances that appear unhealthy will be replaced in all Availability Zones. |
> | Ignore unhealthy | Instances will not be replaced in the Availability Zone with the active zonal shift. |

これらを合わせて読むと、**`ReplaceUnhealthy`**を選択した場合、異常なインスタンスは引き続き置き換えられますが、*Zonal Shiftが有効な間*は、「スケールアウト」（代替インスタンスの起動もこれに含まれる）が健全なAZで行われます。本ワークスペースが`ReplaceUnhealthy`をデフォルトにしているのは、まさにG-2が提起した実用的な疑問——「新しい容量を実際に健全なAZに着地させられるか」——に答える設定だからです。`IgnoreUnhealthy`（プリスケール済み容量計画に対するAWS自身の推奨設定）はもう一つのサポートされたモードで、影響を受けたAZでの置き換えを一切行わず、チャーンも発生しません——切り替え方法は[`parameters/dev-params.ts`](parameters/dev-params.ts)を参照してください。

## 前提条件

- AWS CLI v2のインストールと設定
- Node.js 20以降
- AWS CDK CLI (`npm install -g aws-cdk`)
- TypeScriptとAWSネットワーキングの基礎知識
- FISサービスリンクロールが作成済みのAWSアカウント（初回FIS利用時に自動作成）
- `arc-zonal-shift:StartZonalShift` / `CancelZonalShift` / `ListManagedResources`のIAM権限（運用者操作であり、FISやCDKが行うものではない）

## プロジェクトのディレクトリ構成

```text
fis-arch-h-zonal-shift/
├── bin/
│   └── fis-arch-h-zonal-shift.ts          # アプリエントリポイント（Stageのインスタンス化）
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts              # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                   # 2AZ VPC + Aurora PostgreSQL Multi-AZ（アーキテクチャGと同一）
│       ├── app-stack.ts                    # EC2 ASG（zonal-shift対応）+ Network Load Balancer
│       └── fis-stack.ts                    # FIS実験テンプレート1つ（H-1）+ IAM + アラーム
├── parameters/
│   ├── environments.ts                     # 環境パラメータの型定義（+ impairedZoneHealthCheckBehavior）
│   ├── dev-params.ts                       # 開発環境パラメータ
│   └── index.ts                            # パラメータエクスポート
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts                # cdk-nag AwsSolutionsコンプライアンスチェック
│   └── snapshot/
│       └── snapshot.test.ts               # CDKスナップショットテスト
├── overview.drawio.svg                    # アーキテクチャ図（FISの障害 + ARCの対応）
├── cdk.json
├── package.json
└── tsconfig.json
```

## データフロー

```text
Viewer ── HTTPS ──► NLB ── TCP/80 ──► ASGインスタンス（AZ-1またはAZ-2）── nginxステータスページ

FIS（障害）:
  H-1  aws:network:disrupt-connectivity (scope=all) ──► AZ-1のサブネット

ARC Zonal Shift（対応——運用者/API主導、FISではない）:
  aws arc-zonal-shift start-zonal-shift --resource-identifier <ASG ARN> --away-from <AZ-1のAZ ID>
    └─► ASGがAZ-1をShiftの継続時間中「異常」として扱う
        └─► ReplaceUnhealthy: 新規/代替インスタンスがAZ-2に起動されるようになる
```

## コンポーネントと設計ポイント

| コンポーネント | 設計ポイント |
| -------------- | ------------ |
| EC2 Auto Scaling Group | `AvailabilityZoneImpairmentPolicy: { zonalShiftEnabled: true, impairedZoneHealthCheckBehavior: 'ReplaceUnhealthy' }`——aws-cdk-lib 2.270.0のL2コンストラクトがまだこのプロパティを公開していないため、L1の`CfnAutoScalingGroup`エスケープハッチで設定 |
| インスタンスメンテナンスポリシー | `minHealthyPercentage: 100`、`maxHealthyPercentage: 150`——Zonal Shift対応ASGに対するAWS公式の推奨事項：旧インスタンスを終了する前に代替インスタンスを起動し、ローリング置き換え中も容量を落とさない |
| NLB | `crossZoneEnabled: true`——クロスゾーン*無効*のロードバランサーに対してAWSが文書化している追加の`skip-zonal-shift-validation`要件を回避 |
| FIS IAM ロール | `aws:network:disrupt-connectivity`のNACL入れ替えメカニズム用の`ec2:DescribeSubnets`/`DescribeNetworkAcls`/`CreateNetworkAcl`/...、停止条件アラームへの`cloudwatch:DescribeAlarms`。`arc-zonal-shift:*`は含まない——FISはZonal Shiftに一切触れず、運用者が操作する |
| CloudWatch 停止アラーム | NLBターゲットグループの`UnHealthyHostCount >= 2`——アーキテクチャGと同一の停止条件 |

## 実装ハイライト

### 1. L1エスケープハッチ経由の`AvailabilityZoneImpairmentPolicy`

```typescript
// lib/stacks/app-stack.ts（抜粋）
const cfnAsg = this.asg.node.defaultChild as autoscaling.CfnAutoScalingGroup;
cfnAsg.availabilityZoneImpairmentPolicy = {
    zonalShiftEnabled: true,
    impairedZoneHealthCheckBehavior: props.impairedZoneHealthCheckBehavior ?? 'ReplaceUnhealthy',
};
```

`aws-cdk-lib` 2.270.0のL2 `AutoScalingGroup`コンストラクトはまだ`AvailabilityZoneImpairmentPolicy`を型付きプロパティとして公開していません——その背後にある`CfnAutoScalingGroup`（`.node.defaultChild`経由でアクセス可能）は公開しています。これによりデプロイ時点でASGがARC Zonal Shiftに登録されますが、運用者がShiftを開始する（下記手順6）までは*有効な*Zonal Shiftは存在しません。

### 2. Zonal Shiftと合わせてAWSが推奨するインスタンスメンテナンスポリシー

```typescript
minHealthyPercentage: 100,
maxHealthyPercentage: 150,
```

これがないと、Auto Scalingのデフォルトの挙動では、新しいインスタンスが準備完了する前に古い（異常な）インスタンスを終了してしまい、置き換え中に一時的に希望容量を下回る可能性があります。`100/150`により、代替インスタンスが健全になるまで旧インスタンスが稼働し続けることが保証されます——[Zonal Shiftのベストプラクティス](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-zonal-shift.html#asg-zonal-shift-best-practices)で明示的に推奨されている内容です。

### 3. FISテンプレートはアーキテクチャGのG-2から意図的に変更していない

```typescript
// lib/stacks/fis-stack.ts（抜粋）
actions: {
    DisruptAllTraffic: {
        actionId: 'aws:network:disrupt-connectivity',
        parameters: { scope: 'all', duration: 'PT5M' },
        targets: { Subnets: 'Az1Subnet' },
    },
},
```

G-2と同じアクション、同じscope、同じターゲット、同じ継続時間です。もしH-1がG-2と異なる観測結果を生んだとすれば、それはZonal Shiftによるものであるはずで、障害そのものが変わったからではありません。

## デプロイ手順

### 1. 依存関係のインストール

```bash
cd infrastructure
npm ci
```

### 2. 環境パラメータの設定

```typescript
// parameters/dev-params.ts
export const devParams: EnvParams = {
    region: 'ap-northeast-1',
    impairedZoneHealthCheckBehavior: 'ReplaceUnhealthy', // または 'IgnoreUnhealthy'
    // alarmEmail: 'ops@example.com',
};
```

### 3. CDKのブートストラップ（初回のみ）

```bash
PROJECT=<project> ENV=dev npm run bootstrap -w workspaces/fis-arch-h-zonal-shift
```

### 4. 全スタックのデプロイ

```bash
PROJECT=<project> ENV=dev npm run stage:deploy:all -w workspaces/fis-arch-h-zonal-shift -- --require-approval never
```

3つのスタックが順番にデプロイされます: `<project>-dev-h-base`（VPC + Aurora）、`<project>-dev-h-app`（ASG + NLB）、`<project>-dev-h-fis`（FISテンプレートH-1）。

### 5. ASGがARC Zonal Shiftに登録されていることを確認

```bash
ASG_ARN=$(aws cloudformation describe-stacks --stack-name <project>-dev-h-app \
  --query "Stacks[0].Outputs[?OutputKey=='AsgArn'].OutputValue" --output text)

aws arc-zonal-shift list-managed-resources \
  --query "items[?arn=='$ASG_ARN']"
```

### 6. Zonal Shiftを開始してからFIS実験を実行

AZ-1のAZ**ID**を解決します（AZ名ではなく——`start-zonal-shift`はID形式、例：`apne1-az1`を要求します）:

```bash
AZ1_NAME=$(aws cloudformation describe-stacks --stack-name <project>-dev-h-base \
  --query "Stacks[0].Outputs[?OutputKey=='Az1SubnetArn'].OutputValue" --output text | \
  xargs -I{} aws ec2 describe-subnets --subnet-ids $(basename {}) --query "Subnets[0].AvailabilityZone" --output text)
AZ1_ID=$(aws ec2 describe-availability-zones --filters "Name=zone-name,Values=$AZ1_NAME" \
  --query "AvailabilityZones[0].ZoneId" --output text)

# AZ-1からのZonal Shiftを開始（1時間有効）
aws arc-zonal-shift start-zonal-shift \
  --resource-identifier "$ASG_ARN" \
  --away-from "$AZ1_ID" \
  --expires-in 1h \
  --comment "H-1 verification — compare replacement placement with G-2"
```

その後、H-1実験テンプレートを開始し（コンソールまたは`aws fis start-experiment`）、Auto Scalingが代替インスタンスをどこに起動するか観測します:

```bash
watch -n 10 "aws autoscaling describe-auto-scaling-instances \
  --query \"AutoScalingInstances[].{id:InstanceId,az:AvailabilityZone,health:HealthStatus}\" --output table"
```

### 7. Zonal Shiftを終了

```bash
aws arc-zonal-shift list-zonal-shifts --resource-identifier "$ASG_ARN"
aws arc-zonal-shift cancel-zonal-shift --zonal-shift-id <上記から得たID>
```

### 観測結果（ap-northeast-1）

同一の実機インフラで、比較の両方のケースを含めてエンドツーエンドで実機検証済みです。

| 条件 | 代替インスタンスの配置先 |
| ---- | ------------------------ |
| **Zonal Shiftなし**（対照実験） | AZ-1——同じ分断されたAZ。アーキテクチャGのG-2の結果を正確に再現 |
| **Zonal Shift有効、`ReplaceUnhealthy`** | **AZ-2**——健全なAZ |

Zonal Shift有効時の実行のタイムライン: H-1開始から数秒以内にAZ-1のターゲットが`unhealthy`/`Target.FailedHealthChecks`に転じ、新しいインスタンスが起動——`describe-instances`で確認したところ`ap-northeast-1c`（AZ-2）に配置されていた。旧AZ-1インスタンスは新インスタンスがターゲットグループのヘルスチェックを通過するまで`InService`のまま維持され（`minHealthyPercentage: 100`のメンテナンスポリシーが設計通り機能）、その後`Terminating`に移行。最終状態: AZ-2に2台の健全なインスタンス、AZ-1のインスタンスは消滅。

対照実験（`cancel-zonal-shift`でShiftをキャンセルし、`list-zonal-shifts`で有効なShiftが存在しないことを確認してから開始）では、同じH-1テンプレートを同じ障害に対して実行したところ、代替インスタンスはAZ-1に戻って配置された——これは2つの異なるデプロイ間の比較ではなく、同一ワークスペース自身のインフラ内で、アーキテクチャGのG-2の発見を正確に再現するものです。

**これは本ワークスペースの出発点となった問いに直接答えるものです**: AZ障害イベント中に容量を健全なAZへ移動させることは*可能*ですが、それはAuto Scaling自身のデフォルト動作としてではなく、明示的な運用者主導のメカニズム（`AvailabilityZoneImpairmentPolicy` + `start-zonal-shift`）を通じてのみ実現されます。

## テスト

```bash
cd infrastructure
npm ci

npm run test           -w workspaces/fis-arch-h-zonal-shift
npm run test:snapshot  -w workspaces/fis-arch-h-zonal-shift
npm run test:compliance -w workspaces/fis-arch-h-zonal-shift
npm run test:snapshot:update -w workspaces/fis-arch-h-zonal-shift   # 意図的な変更後
```

| テストスイート | ファイル | 検証内容 |
| -------------- | -------- | -------- |
| スナップショット | `test/snapshot/snapshot.test.ts` | 全3スタックの完全なCFnスナップショット；ASGが`ZonalShiftEnabled:true`の`AvailabilityZoneImpairmentPolicy`を持つこと；ASGが100/150のインスタンスメンテナンスポリシーを持つこと；NLBがインターネット向けであること；FISテンプレートが1つのみで停止条件を持ち、`aws:ec2:subnet`を対象に`aws:network:disrupt-connectivity`を使用すること |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutionsパック — 非抑制の指摘なし |

## コスト見積もり

アーキテクチャGと同じアイドルコストプロファイルです（NAT GatewayとAurora Serverless v2の2つのACUが大半を占め、稼働し続けると月額$200以上——実験後は速やかに削除してください）。H-1のテストサイクル1回は数ドル程度：5分間の実験1回分のFISのアクション分単価$0.10と、短時間のEC2置き換え。ARC Zonal Shift自体には別途課金はありません。

## セキュリティ上の考慮事項

- **ASGのZonal Shift登録はオプトインであり、このASGにスコープされている** — `AvailabilityZoneImpairmentPolicy`はこのワークスペース自身のAuto Scalingグループにのみ影響します。
- **Zonal Shiftの開始/終了には`arc-zonal-shift:StartZonalShift`/`CancelZonalShift`が必要** — 非管理者向けのIAMポリシーでは特定のASG ARNにスコープしてください。これは運用者操作であり、FISロールに付与するものではありません。
- **FISロールはアーキテクチャGのG-1/G-2のスコープから変更なし**: `aws:network:disrupt-connectivity`のNACL入れ替え権限、1つの停止条件アラームへの`cloudwatch:DescribeAlarms`。EC2終了やAuroraフェイルオーバーの権限なし（Hはこれらのアクションを使用しない）。
- **VPCの露出なし** — インターネット向けNLBのみ、アーキテクチャGと同一。
- **停止条件は必須** — H-1は本シリーズの全FISテンプレートと同じNLB異常ホストアラームの停止条件を持ちます。

## トラブルシューティング

| 症状 | 考えられる原因 | 対処法 |
| ---- | -------------- | ------ |
| `start-zonal-shift`が`ResourceNotFoundException`で失敗 | ASGがまだARCに登録されていない、またはリソース識別子が間違っている | ASGの`AvailabilityZoneImpairmentPolicy.ZonalShiftEnabled`が`true`であること（デプロイ手順4）とASGの**ARN**（`AsgArn`スタック出力から）を使用していること（名前ではなく）を確認 |
| `start-zonal-shift`が`AccessDeniedException`で失敗 | 呼び出し元に`arc-zonal-shift:StartZonalShift`がない | これは運用者/IAMユーザーの権限であり、FISロールやCDKが付与するものではありません——自分の実行主体に追加してください |
| `--away-from`が拒否される | AZ*名*（`ap-northeast-1a`）を渡しているが、AZ*ID*（`apne1-az1`）が必要 | 先にIDを解決: `aws ec2 describe-availability-zones --filters "Name=zone-name,Values=<az名>"` |
| Shiftが有効なのに代替インスタンスがまだAZ-1に配置される | `ImpairedZoneHealthCheckBehavior`が`ReplaceUnhealthy`ではなく`IgnoreUnhealthy` | `IgnoreUnhealthy`では、AWSは意図的に異常インスタンスを一切置き換えません（上記の挙動表を参照）——これはバグではなく想定通りです。`ReplaceUnhealthy`で再デプロイしてAZ-2への置き換え挙動を確認してください |
| FIS実験が即座に停止する | 停止条件アラームがすでに`ALARM`状態 | `aws cloudwatch set-alarm-state --alarm-name <name> --state-value OK --state-reason reset` |

## クリーンアップ

```bash
# まず有効なZonal Shiftをキャンセル——CDKスタックとは独立している
aws arc-zonal-shift list-zonal-shifts --resource-identifier "$ASG_ARN"
aws arc-zonal-shift cancel-zonal-shift --zonal-shift-id <id>

PROJECT=<project> ENV=dev npm run stage:destroy:all -w workspaces/fis-arch-h-zonal-shift -- --force
```

Zonal Shiftの登録自体はASGのプロパティであり、ASGが削除されると自動的に削除されます——*有効な*Shiftを終了する以外に別途クリーンアップは不要です。

## まとめ

アーキテクチャGのG-2シナリオは実機検証で実際のギャップを明らかにしました。Auto Scalingのデフォルトのセルフヒーリングはネットワーク分断と死んだインスタンスを区別できず、AZ回避ロジックが起動失敗にのみ反応するため、代替インスタンスを同じ壊れたAZに再起動してしまいます。本ワークスペースは、文書化されたAWSのメカニズム——ARC Zonal Shift——でこのギャップを埋め、*全く同じ障害*に対してそれを実機検証します。

- **Shiftなしのバージョン**はG-2の結果を対照実験として再現します。
- **Shiftが有効な状態**（`ReplaceUnhealthy`）では、代替容量がAZ-1ではなくAZ-2に配置されることが期待されます。

これは新しいカオスシナリオというより、既に見つかった問題に対する解決策です。本ワークスペースが答える問いは「AWSはこれを修正する方法を提供しているか」であり、実機検証で得られた答えは「はい、`AvailabilityZoneImpairmentPolicy`と運用者主導のZonal Shiftによって」です。

## 参考資料

- [Auto Scaling group zonal shift](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-zonal-shift.html)
- [Auto Scaling group Availability Zone distribution](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-availability-zone-balanced.html)
- [Auto Scaling benefits for application architecture](https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-benefits.html)
- [`AWS::AutoScaling::AutoScalingGroup AvailabilityZoneImpairmentPolicy`](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-autoscaling-autoscalinggroup-availabilityzoneimpairmentpolicy.html)
- [Using zonal shift with Amazon EC2 Auto Scaling（AWS Compute Blog）](https://aws.amazon.com/blogs/compute/using-zonal-shift-with-amazon-ec2-auto-scaling/)
- [`start-zonal-shift` CLIリファレンス](https://docs.aws.amazon.com/cli/latest/reference/arc-zonal-shift/start-zonal-shift.html)
- アーキテクチャG — [fis-arch-g-multiaz-network](../fis-arch-g-multiaz-network) — 本ワークスペースが直接の続編となっているG-2の発見元
