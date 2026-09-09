# FIS カオスエンジニアリング — アーキテクチャ G: マルチAZネットワーク分断（NLB + EC2 Auto Scaling Group + Aurora PostgreSQL）

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20NLB%20%7C%20EC2%20ASG%20%7C%20Aurora%20PostgreSQL%20%7C%20VPC-orange?style=flat-square)

## はじめに

本プロジェクトは、コンポーネント障害ではなく **アベイラビリティーゾーン（AZ）のネットワーク障害そのものをシミュレートする** ことに主眼を置いた AWS Fault Injection Simulator (FIS) カオスエンジニアリングのリファレンス実装です。インターネット向け Network Load Balancer (NLB) が 2 AZ に分散した EC2 Auto Scaling Group へ TCP トラフィックを振り分け、その先には ライターとリーダーを異なる AZ に配置した Aurora PostgreSQL Serverless v2 クラスターが控えます。

中心となるのは `aws:network:disrupt-connectivity` です。これは **AZ がネットワーク接続性を失う状況をシミュレートできる唯一の FIS ネイティブアクション** であり、本リポジトリの他のどのワークスペースでも使用されていません（`fis-arch-a` は ECS タスク/ネットワークアクション、`fis-arch-b` は DynamoDB に対する `aws:fis:inject-api-*`、`fis-arch-c` は SSM ベースのインスタンスアクションと RDS フェイルオーバーを使用）。他のアーキテクチャが「この *コンポーネント* が落ちたらどうなるか？」を問うのに対し、アーキテクチャ G は「この *アベイラビリティーゾーン* が VPC の他の部分と通信できなくなったらどうなるか？」を問います。これは見落とされがちな独立した障害範囲のカテゴリーです。なぜなら AZ 内の個々のインスタンスやサービスは完全に健全なまま、ネットワーク層だけが分断されるケースがあり得るからです。

| シナリオ | 注入する障害 | 実行時間 | 検証内容 |
| -------- | ------------ | -------- | -------- |
| **G-1** AZ-1 クロスAZトラフィック分断 | `aws:network:disrupt-connectivity`、`scope=availability-zone`、AZ-1 のプライベートサブネット対象 | 5 分 | 暗黙のクロスAZ依存が存在しないこと、他AZに到達できない際の NLB クロスゾーンルーティングの挙動 |
| **G-2** AZ-1 完全分断 | `aws:network:disrupt-connectivity`、`scope=all`、AZ-1 のプライベートサブネット対象 | 5 分 | NLB の異常ターゲット検知速度、AZ-2 へのトラフィック 100% 自動フェイルオーバー |
| **G-3** Aurora マルチAZフェイルオーバー | `aws:rds:failover-db-cluster` — ライター→リーダー昇格 | 約 30 秒 | 上記のネットワーク層障害とは独立した、DB 層自体のフェイルオーバー動作 |
| **G-4** AZ スコープの EC2 終了 | `aws:ec2:terminate-instances`、タグ付きインスタンスの `PERCENT(50)` | 即時 | ASG の自己修復、NLB のターゲット登録解除・再登録速度 |

全実験テンプレートは NLB ターゲットグループの `UnHealthyHostCount` に基づく CloudWatch Alarm の停止条件を共有します。NLB は ALB のような HTTP ステータスコード単位のメトリクスを持たないため、この層で利用できる安全信号は異常ホスト数になります。

## アーキテクチャ概要

```
ユーザー
    │
    ▼
Network Load Balancer  (インターネット向け、TCP/80、2 AZ、クロスゾーン負荷分散)
    │  自身のセキュリティグループを持たない — EC2 の受信は VPC CIDR ベースでスコープ
    │  （ターゲットグループ: preserveClientIp=false）
    ▼
EC2 Auto Scaling Group  (t3.small、AL2023、min=2/max=4、2 AZ に分散配置)
    │  nginx + IMDSv2 ステータスページ（インスタンス ID + AZ）
    ▼
Aurora PostgreSQL Serverless v2  (ライター 1 台 + リーダー 1 台、AZ ごとに配置、暗号化)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS 実験テンプレート (FisStack)

G-1  aws:network:disrupt-connectivity ────────────► AZ-1 プライベートサブネット ARN
     scope=availability-zone、PT5M（AZ-1 → 他AZ の VPC 内トラフィックのみブロック）

G-2  aws:network:disrupt-connectivity ────────────► AZ-1 プライベートサブネット ARN
     scope=all、PT5M（AZ-1 サブネットへの全トラフィック — NLB ヘルスチェック含む — をブロック）

G-3  aws:rds:failover-db-cluster ─────────────────► Aurora クラスター ARN
     ライター→リーダー昇格

G-4  aws:ec2:terminate-instances ─────────────────► EC2 インスタンス（タグ: fis-target=app-instance）
     selectionMode=PERCENT(50) — 「1 AZ 分のインスタンスを終了」を近似
```

### VPC 2AZ レイアウト

```
                                        ユーザー
                                           │
                                           ▼
                     Network Load Balancer（インターネット向け、2 AZ、クロスゾーン）
                              │                                  │
              ┌───────────────┘                                  └───────────────┐
              ▼                                                                   ▼
┌───────────────────────────────┐                                 ┌───────────────────────────────┐
│ AZ-1 (ap-northeast-1a)         │                                 │ AZ-2 (ap-northeast-1c)         │
│ ┌───────────────────────────┐ │                                 │ ┌───────────────────────────┐ │
│ │ Public   /24                │ │                                 │ │ Public   /24                │ │
│ │  NAT Gateway                 │ │                                 │ │  (NAT なし — AZ-1 経由)      │ │
│ └───────────────────────────┘ │                                 │ └───────────────────────────┘ │
│ ┌───────────────────────────┐ │       FIS G-1 / G-2 対象          │ ┌───────────────────────────┐ │
│ │ Private  /24  ◄─────────────┼─── aws:network:disrupt-          │ │ Private  /24                │ │
│ │  EC2 ASG (×1-2)              │ │    connectivity                 │ │  EC2 ASG (×1-2)              │ │
│ └───────────────────────────┘ │                                 │ └───────────────────────────┘ │
│ ┌───────────────────────────┐ │       同期レプリケーション          │ ┌───────────────────────────┐ │
│ │ Isolated /24                 │ │─────────────────────────────────►│ Isolated /24                 │ │
│ │  Aurora Writer                │ │                                 │ │  Aurora Reader                │ │
│ └───────────────────────────┘ │                                 │ └───────────────────────────┘ │
└───────────────────────────────┘                                 └───────────────────────────────┘
              VPC 10.70.0.0/16 — natCount=1（NAT Gateway 1 台を両 AZ で共有）
```

### 設計上のポイント

| 特徴 | 効果 |
| ---- | ---- |
| `aws:network:disrupt-connectivity` | NACL やルートテーブルを手動操作せずに AZ ネットワーク障害をシミュレートできる唯一の FIS ネイティブな方法。一時的な NACL の差し替えとロールバックを FIS が自動的に管理 |
| `scope=availability-zone` と `scope=all`（G-1 と G-2） | 同一アクションから 2 種類の障害粒度を実現。「他 AZ に到達できない」と「完全に孤立」で異なる障害モードが表面化する |
| Aurora ライター・リーダーを 2 AZ に配置 | G-3（`aws:rds:failover-db-cluster`）はリーダーが 1 台以上必要。リーダーを AZ-2 に置くことで、G-1/G-2 がライターのレプリケーション経路を偶発的に遮断する副次効果も観測できる |
| NLB ターゲットグループの `preserveClientIp: false` | EC2 ターゲットへ届くトラフィックは NLB ノード自身の VPC CIDR 内 IP に送信元 NAT される。そのため EC2 セキュリティグループは単純な VPC CIDR 受信ルール 1 本で十分 — NLB 側にセキュリティグループは不要 |
| タグベースの EC2 ターゲティング（G-4） | `fis-target: app-instance` タグにより、インスタンス ID や ASG 名をハードコードせずに FIS が対象を選択。スケールイン・アウトを経ても有効 |
| 共有停止条件（NLB UnHealthyHostCount） | 1 つの CloudWatch Alarm が、異常ターゲットが増えすぎた場合に 4 つの実験すべてを停止 |

## 前提条件

- AWS CLI v2 のインストールと設定
- Node.js 20 以降
- AWS CDK CLI (`npm install -g aws-cdk`)
- TypeScript の基礎知識
- FIS サービスリンクロールが作成済みの AWS アカウント（初回 FIS 利用時に自動作成）

## プロジェクトのディレクトリ構成

```text
fis-arch-g-multiaz-network/
├── bin/
│   └── fis-arch-g-multiaz-network.ts          # アプリエントリポイント（Stage のインスタンス化）
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts                  # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                       # 2AZ VPC + Aurora PostgreSQL Serverless v2
│       ├── app-stack.ts                        # EC2 ASG（2 AZ）+ インターネット向け NLB
│       └── fis-stack.ts                        # FIS 実験テンプレート 4 本 + IAM + アラーム
├── parameters/
│   ├── environments.ts                         # 環境パラメータ型定義
│   ├── dev-params.ts                           # 開発環境パラメータ
│   └── index.ts                                # パラメータエクスポート
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts                    # cdk-nag AwsSolutions コンプライアンスチェック
│   └── snapshot/
│       └── snapshot.test.ts                   # CDK スナップショットテスト（15 ケース）
├── overview.drawio.svg
├── cdk.json
├── package.json
└── tsconfig.json
```

## データフロー

```text
クライアント (ブラウザまたは curl)
  │  TCP/80
  ▼
Network Load Balancer  (インターネット向け、2 AZ、クロスゾーン負荷分散)
  │  TCP リスナー → INSTANCE ターゲットグループ (preserveClientIp: false)
  ▼
EC2 Auto Scaling Group  (t3.small、AL2023、min=2/max=4、各 AZ 最低 1 台)
  │  nginx ステータスページ: インスタンス ID + AZ (IMDSv2 経由で取得)
  ▼
Aurora PostgreSQL Serverless v2
  │  ライター 1 台 + リーダー 1 台、異なる AZ に配置（G-3 aws:rds:failover-db-cluster に必要）
  │  Isolated サブネット、ポート 5432、ストレージ暗号化
  ▼
（Aurora シークレットを Secrets Manager 経由で読み取り — オプションの DB ヘルスエンドポイント）
```

## 主要コンポーネントと設計のポイント

| コンポーネント | 設計のポイント |
| -------------- | -------------- |
| VPC | CIDR 10.70.0.0/16; 2 AZ; 各 AZ にパブリック/プライベート/Isolated の 3 サブネット層; NAT Gateway × 1（両 AZ で共有） |
| Aurora PostgreSQL Serverless v2 | エンジン v16.4; ライター 1 台 + リーダー 1 台を 2 AZ に配置; 最小 0.5 ACU、最大 4 ACU; Isolated サブネット; ストレージ暗号化; CloudWatch ログエクスポート |
| EC2 Auto Scaling Group | t3.small; AL2023; requireImdsv2; EBS gp3 20 GB 暗号化; 2 AZ に分散配置; タグ `fis-target: app-instance` |
| Network Load Balancer | インターネット向け、TCP/80、2 AZ、クロスゾーン負荷分散有効、`disableSecurityGroups: true` |
| ターゲットグループ | TCP/80、INSTANCE タイプ、`preserveClientIp: false`、`/` への HTTP ヘルスチェック、登録解除遅延 30 秒 |
| EC2 セキュリティグループ | VPC CIDR からの TCP/80 受信のみ許可（NLB セキュリティグループからの受信はなし — NLB はそもそも持たない） |
| FIS IAM ロール | タグ付きインスタンスへの `ec2:TerminateInstances`; `aws:network:disrupt-connectivity` 用の NACL 管理アクション（`ec2:CreateNetworkAcl`、`ec2:ReplaceNetworkAclAssociation` など）; クラスター ARN 指定の `rds:FailoverDBCluster`; CloudWatch Logs 配信 |
| 停止条件 | NLB ターゲットグループ `UnHealthyHostCount >= 2` / 1 分間 — 4 つの実験テンプレートすべてで共有 |
| FIS ログ グループ | `/fis/{project}-{env}` — 保持期間 1 ヶ月、スタック削除時に自動削除 |

## 実装のポイント

### 1. `aws:network:disrupt-connectivity` — AZ レベルのネットワーク障害注入（G-1、G-2）

このアクションは `resourceType: aws:ec2:subnet` を直接ターゲットとします（多くの FIS アクションのようなタグベースではありません）。そのため FIS テンプレートは AZ-1 の Private サブネットの具体的な ARN を参照します。

```typescript
// BaseStack: プライベートサブネット ARN を AZ 順に公開
this.appSubnets = this.vpc.selectSubnets({
    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
}).subnets;
this.azSubnetArns = this.appSubnets.map((subnet) =>
    cdk.Stack.of(this).formatArn({
        service: 'ec2',
        resource: 'subnet',
        resourceName: subnet.subnetId,
    }),
);

// FisStack: G-1 は scope=availability-zone（クロスAZトラフィックのみ）
targets: {
    Az1Subnet: {
        resourceType: 'aws:ec2:subnet',
        resourceArns: [az1SubnetArn],
        selectionMode: 'ALL',
    },
},
actions: {
    DisruptCrossAzTraffic: {
        actionId: 'aws:network:disrupt-connectivity',
        parameters: { scope: 'availability-zone', duration: 'PT5M' },
        targets: { Subnets: 'Az1Subnet' },
    },
},

// G-2 は scope=all（サブネットの全経路）
actions: {
    DisruptAllTraffic: {
        actionId: 'aws:network:disrupt-connectivity',
        parameters: { scope: 'all', duration: 'PT5M' },
        targets: { Subnets: 'Az1Subnet' },
    },
},
```

内部的には、このアクションは対象サブネットに一時的な Network ACL を差し替えて実行時間だけ適用し、終了時に元の関連付けを自動的に復元します。この一時 NACL はポリシー作成時点では存在しないため、FIS IAM ロールには NACL 管理権限（`ec2:CreateNetworkAcl`、`ec2:CreateNetworkAclEntry`、`ec2:ReplaceNetworkAclAssociation`、`ec2:DeleteNetworkAcl`、`ec2:DeleteNetworkAclEntry`、`ec2:DescribeNetworkAcls`、`ec2:DescribeSubnets`）をワイルドカードリソースで付与する必要があります。

### 2. 自身のセキュリティグループを持たない NLB（`preserveClientIp: false`）

Network Load Balancer は TCP 接続をレイヤー 4 で転送するだけで終端しません。ALB と異なり、クライアントの送信元アドレスを自動的に隠しません。本スタックでは NLB の（CDK が管理するオプションの）セキュリティグループを完全に無効化し、代わりにターゲットグループのクライアント IP 保持を無効化します。

```typescript
this.nlb = new elbv2.NetworkLoadBalancer(this, 'Nlb', {
    // ...
    disableSecurityGroups: true,   // クラシックな NLB の挙動: 自身の SG を持たない
});

this.targetGroup = new elbv2.NetworkTargetGroup(this, 'AsgTg', {
    // ...
    preserveClientIp: false,       // NLB ノード自身の（VPC CIDR 内）IP に送信元 NAT
});

// EC2 SG: VPC CIDR 受信ルール 1 本で十分
ec2Sg.addIngressRule(
    ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
    ec2.Port.tcp(80),
    'NLB health check and HTTP traffic (source-NAT terminated at VPC CIDR)',
);
```

`preserveClientIp: false` により、EC2 インスタンスが受け取るすべてのパケット（ヘルスチェックでも実際のクライアントトラフィックでも）は VPC CIDR 内のアドレス（NLB ノード自身のプライベート IP）を送信元として届きます。そのため EC2 セキュリティグループは、NLB のセキュリティグループを参照する必要がないまま、Internal ALB パターンと同程度に絞り込むことができます。

### 3. クロスゾーン負荷分散と G-1/G-2 の違い

NLB の `crossZoneEnabled: true` により、通常時は AZ-2 側の NLB ノード経由で接続したクライアントも AZ-1 のターゲットにルーティングされ得ます（逆も同様）。G-1 と G-2 はこの挙動に対する 2 つの異なる帰結を検証します。

- **G-1**（`scope=availability-zone`）は AZ-1 → 他 AZ の *VPC 内* トラフィックのみをブロックします。AZ-1 の NLB ノードは AZ-1 のターゲットへ直接到達でき、インターネット経路も影響を受けません。これにより、クロスAZ依存の障害（例: AZ-1 のインスタンスが AZ-2 の Aurora リーダーに到達できなくなる）を、AZ ローカルな障害から切り分けて検証できます。
- **G-2**（`scope=all`）は AZ-1 サブネットへの全経路（NLB 自身のヘルスチェックトラフィックを含む）をブロックします。AZ 全体のネットワーク障害を模擬し、NLB が AZ-1 を異常と検知してトラフィックの 100% を AZ-2 に切り替える速度を検証します。

### 4. Aurora マルチAZフェイルオーバー（G-3）

`fis-arch-c` の C-3 と同じパターンです。`aws:rds:failover-db-cluster` はクラスター ARN を直接ターゲットとし、AZ-2 のリーダーをライターに昇格させます。リーダーはすでにライターと異なる AZ に配置されているため、このシナリオは意図的に G-1/G-2 のネットワーク層障害から独立しており、DB 層自体のフェイルオーバー動作を単独で検証できます。

### 5. 50% 選択による AZ スコープのインスタンス終了（G-4）

FIS の `resourceTags` ターゲティングには AZ 条件がないため、「AZ-1 の全インスタンスを終了」を直接指定する方法はありません。ASG が 2 AZ に均等分散している前提であれば、`fis-target: app-instance` タグに対する `selectionMode: 'PERCENT(50)'` が、インスタンス ID をハードコードすることなくその結果を統計的に近似します。

```typescript
targets: {
    AppInstances: {
        resourceType: 'aws:ec2:instance',
        resourceTags: { 'fis-target': 'app-instance' },
        selectionMode: 'PERCENT(50)',
    },
},
actions: {
    TerminateInstances: {
        actionId: 'aws:ec2:terminate-instances',
        targets: { Instances: 'AppInstances' },
    },
},
```

### 6. 停止条件と安全ネット

4 つすべてのテンプレートが、NLB ターゲットグループの `UnHealthyHostCount` 停止条件を 1 つ共有します。NLB は ALB のようなリクエスト単位の HTTP ステータスコードを公開しないため、この層で利用できる信号は異常ホスト数です。

```typescript
const unhealthyHostAlarm = new cw.Alarm(this, 'NlbUnhealthyHostAlarm', {
    metric: props.targetGroup.metrics.unHealthyHostCount({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
    }),
    threshold: 2,
    evaluationPeriods: 1,
    treatMissingData: cw.TreatMissingData.NOT_BREACHING,
});
```

異常ターゲットが増えすぎた場合、FIS が自動的に実験を停止し、注入した障害を元に戻します（G-1/G-2 の場合は元の NACL 関連付けを復元）。

## デプロイガイド

### 1. 依存関係のインストール

```bash
cd infrastructure
npm ci
```

### 2. 環境パラメータの設定

`parameters/dev-params.ts` を編集してリージョンとオプションのアラームメールを設定します。

```typescript
// parameters/dev-params.ts
export const devParams: EnvParams = {
    region: 'ap-northeast-1',
    vpcConfig: { ... },
    // alarmEmail: 'ops@example.com',  // アラーム通知メールを受け取る場合はコメントアウト解除
};
```

### 3. CDK ブートストラップ（初回のみ）

```bash
PROJECT=fis-chaos-g ENV=dev npm run bootstrap
```

### 4. 全スタックのデプロイ

```bash
PROJECT=fis-chaos-g ENV=dev npm run stage:deploy:all
```

依存関係の順番で 3 つのスタックがデプロイされます。
1. `fis-chaos-g-dev-g-base` — 2AZ VPC + Aurora PostgreSQL Serverless v2
2. `fis-chaos-g-dev-g-app` — EC2 ASG（2 AZ）+ インターネット向け NLB
3. `fis-chaos-g-dev-g-fis` — FIS テンプレート + IAM + アラーム

### 5. アプリケーションのテスト

デプロイ後、スタックの出力から NLB の DNS 名を取得します。

```bash
# nginx ステータスページの確認
curl http://<nlb-dns-name>/

# レスポンス例:
# <h1>FIS Chaos Demo — Architecture G</h1>
# <p>Instance: i-0123456789abcdef0</p>
# <p>AZ: ap-northeast-1a</p>
# <p>Status: OK</p>
```

### 6. FIS 実験の実行

AWS FIS コンソールから実験テンプレート（G-1 〜 G-4）を選択し、**実験を開始**をクリックして、次の項目を観察します。
- G-1: NLB ターゲットヘルスとクロスゾーンルーティングの挙動
- G-2: NLB の異常ターゲット検知と AZ-2 フェイルオーバー速度
- G-3: RDS コンソールの Aurora フェイルオーバーイベント
- G-4: ASG のアクティビティと NLB ターゲットの入れ替わり

## テスト

```bash
cd infrastructure
npm ci

# このワークスペースの全テストを実行
npm run test --workspace=fis-arch-g-multiaz-network

# スナップショットテストのみ
npm run test:snapshot --workspace=fis-arch-g-multiaz-network

# CDK Nag コンプライアンスチェック
npm run test:compliance --workspace=fis-arch-g-multiaz-network

# 意図的な変更後にスナップショットを更新
npm run test:snapshot:update --workspace=fis-arch-g-multiaz-network
```

### テストカバレッジ

| テストスイート | ファイル | アサーション |
| -------------- | -------- | ------------ |
| スナップショット | `test/snapshot/snapshot.test.ts` | 3 スタック全体の CloudFormation テンプレートスナップショット; VPC が 2 AZ にまたがること; Aurora ストレージ暗号化; ASG 存在確認; NLB がインターネット向けであること; ターゲットグループが TCP/80; FIS テンプレートがちょうど 4 本; 全テンプレートに停止条件あり; G-1/G-2 が両方とも `aws:ec2:subnet` をターゲットにしていること |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions パック — 未抑制の警告・エラーがないこと（6 テストケース） |

## コスト見積もり

Aurora Serverless v2、EC2 インスタンス、NAT Gateway はアイドル時でも時間課金が発生します。実験終了後は速やかにスタックを削除してください。

| サービス | 課金モデル | 概算コスト（1 時間の実験ウィンドウ） |
| -------- | ---------- | ------------------------------------- |
| EC2 (t3.small × 2) | 時間課金 | 約 $0.04/時間 |
| Aurora Serverless v2 (最小 0.5 ACU × 2 インスタンス) | ACU 時間課金 | 約 $0.06/時間 |
| NAT Gateway | 時間課金 + データ転送 | 約 $0.05/時間 |
| Network Load Balancer | 時間課金 + LCU | 約 $0.02/時間 |
| FIS | 無料 | 課金なし |
| **合計（1 時間）** | | **約 $0.17/時間** |

## セキュリティ上の考慮事項

- **IMDSv2 必須** (`requireImdsv2: true`) — メタデータサービス経由の SSRF 攻撃を防止
- **EBS ルートボリューム暗号化** (gp3) — AwsSolutions-EC26 を満たす
- **NLB は自身のセキュリティグループを持たず、EC2 の受信は VPC CIDR にスコープ** — ターゲットグループの `preserveClientIp: false` と組み合わせることで、NLB セキュリティグループを参照する必要がないまま、Internal ALB パターンと同程度に実効的な攻撃対象領域を絞り込める
- **FIS IAM ロールをタグ/ARN 条件でスコープ** — `ec2:TerminateInstances` は `fis-target: app-instance` タグを持つインスタンスのみに制限。`rds:FailoverDBCluster` は Aurora クラスター ARN に制限
- **Aurora を Isolated サブネットに配置** — インターネットへのルートなし。VPC 内からポート 5432 でのみアクセス可能
- **停止条件は必須** — 全 FIS テンプレートに NLB `UnHealthyHostCount` アラーム停止条件を含む

## トラブルシューティング

| 症状 | 考えられる原因 | 対処方法 |
| ---- | -------------- | -------- |
| `cdk deploy` が `No parameters found` で失敗 | `dev-params.ts` のエクスポートが欠落 | `parameters/index.ts` が `dev` キーで `devParams` をエクスポートしているか確認 |
| G-1/G-2 が権限エラーで失敗 | FIS ロールに NACL 管理アクションが不足 | FIS ロールに `ec2:CreateNetworkAcl`、`ec2:ReplaceNetworkAclAssociation` などが含まれているか確認（一時 NACL は事前に存在しないためワイルドカードリソース） |
| G-3 が `cluster does not support failover` で失敗 | リーダーインスタンスがない | BaseStack を `readers` 配列に少なくとも 1 インスタンスを含めてデプロイ |
| NLB への curl がタイムアウトする | ターゲットグループが異常、または EC2 SG が狭すぎる | ターゲットグループに `preserveClientIp: false` が設定されていること、EC2 SG がポート 80 で VPC CIDR を許可していることを確認 |
| FIS 実験がすぐに停止する | 停止条件のアラームがすでに `ALARM` 状態 | アラームをリセット: `aws cloudwatch set-alarm-state --alarm-name ... --state-value OK` |

## クリーンアップ

```bash
PROJECT=fis-chaos-g ENV=dev npm run stage:destroy:all
```

全リソースに `removalPolicy: DESTROY` が設定されているため、destroy コマンドで Aurora クラスター、EC2 ASG、NLB、VPC、FIS テンプレート、CloudWatch ロググループが完全に削除されます。

## まとめ

本ワークスペースは、本リポジトリの他のどのワークスペースもカバーしていない **アベイラビリティーゾーンレベルのネットワーク障害** に焦点を当てた FIS カオスエンジニアリングをデモします。

- **G-1**: アプリケーションに暗黙のクロスAZ依存が存在しないこと、他 AZ に到達できない際に NLB のクロスゾーンルーティングが健全に振る舞うことを検証
- **G-2**: AZ 全体がネットワーク的に孤立した場合の、NLB の異常ターゲット検知速度と AZ-2 への自動フェイルオーバーを検証
- **G-3**: ネットワーク層のシナリオとは独立した、Aurora 自体のライター→リーダー昇格動作を検証
- **G-4**: 概ね 1 AZ 分のインスタンスが一斉に消失した場合の、ASG の自己修復と NLB ターゲットの入れ替わりを検証

本アーキテクチャはアーキテクチャ C（ALB + SSM ベースのインスタンス/ネットワークアクション）を補完します。`aws:ssm:send-command` のネットワークブラックホールも `aws:ec2:terminate-instances` も到達できない、唯一の障害ドメイン — インスタンスはすべて健全なままアベイラビリティーゾーン全体が接続性を失うケース — をカバーします。

## 参考資料

- [AWS FIS — サポートされるアクション](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [aws:network:disrupt-connectivity アクションリファレンス](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-network)
- [aws:rds:failover-db-cluster アクションリファレンス](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-rds)
- [Network Load Balancer — クライアント IP の保持](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/target-group-register-targets.html)
- [Network Load Balancer — クロスゾーン負荷分散](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html#cross-zone-load-balancing)
- [CDK aws-fis モジュール（L1 コンストラクト）](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
