# FIS カオスエンジニアリング — アーキテクチャ C: CloudFront + Internal ALB + EC2 Auto Scaling Group + Aurora PostgreSQL

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20CloudFront%20%7C%20ALB%20%7C%20EC2%20ASG%20%7C%20Aurora%20PostgreSQL-orange?style=flat-square)

## はじめに

本プロジェクトは、**クラシックな 3 層 EC2 Web アーキテクチャ**に対する AWS Fault Injection Simulator (FIS) を用いたカオスエンジニアリングのリファレンス実装です。CloudFront → VPC Origin → Internal ALB → EC2 Auto Scaling Group (nginx / Amazon Linux 2023) → Aurora PostgreSQL Serverless v2 という構成に対して、4 つの FIS 実験テンプレートがインフラ層の異なる障害を注入します。

| シナリオ | 注入する障害 | 実行時間 | 検証内容 |
| -------- | ------------ | -------- | -------- |
| **C-1** EC2 インスタンス終了 | ASG インスタンスの 50% を終了 | 即時 | ASG 自己修復、ALB ターゲット登録解除、CloudFront フォールバック |
| **C-2** EC2 CPU ストレス | SSM 経由で全インスタンスに 100% CPU 負荷 | 5 分 | ASG スケールアウトポリシー、新規インスタンスのヘルスチェック通過速度 |
| **C-3** Aurora DB フェイルオーバー | ライター→リーダーへの昇格（約 30 秒中断） | 約 30 秒 | コネクションプールの再接続、クエリリトライ動作 |
| **C-4** EC2→DB ネットワークブラックホール | 全インスタンスから TCP ポート 5432 の送信をブロック | 5 分 | クエリタイムアウト設定、サーキットブレーカー動作、DB 喪失時の ALB ヘルスチェック |

全実験テンプレートは CloudWatch Alarm の停止条件を共有します。ALB 5xx エラー数が 1 分間に 50 件以上になると実験が自動停止し、障害の影響範囲を制限します。

## アーキテクチャ概要

```
ユーザー (HTTPS)
    │
    ▼
CloudFront Distribution  (VPC Origin、キャッシュ無効、502/503/504 時は S3 フォールバック)
    │  CloudFront VPC Origin（Internal ALB への HTTP）
    ▼
Internal Application Load Balancer  (プライベートサブネット、CloudFront プレフィックスリスト受信)
    │  HTTP/80 リスナー → ターゲットグループ
    ▼
EC2 Auto Scaling Group  (t3.small、AL2023、min=2/max=4、プライベートサブネット、SSM エージェント)
    │  nginx + IMDSv2 ステータスページ
    ▼
Aurora PostgreSQL Serverless v2  (ライター 1 台 + リーダー 1 台、Isolated サブネット、暗号化)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS 実験テンプレート (FisStack)

C-1  aws:ec2:terminate-instances ──────────────► EC2 インスタンス（タグ: fis-target=app-instance）
     selectionMode=PERCENT(50)

C-2  aws:ssm:send-command (AWSFIS-Run-CPU-Stress) ► EC2 インスタンス（タグ: fis-target=app-instance）
     CPU=0 (全 vCPU)、DurationSeconds=300、PT5M

C-3  aws:rds:failover-db-cluster ─────────────► Aurora クラスター ARN
     ライター→リーダー昇格

C-4  aws:ssm:send-command (AWSFIS-Run-Network-Blackhole-Port) ► EC2 インスタンス
     Protocol=tcp、TrafficType=egress、Port=5432、DurationSeconds=300、PT5M
```

### 設計上のポイント

| 特徴 | 効果 |
| ---- | ---- |
| SSM エージェント (AL2023 プリインストール) | C-2・C-4 は AWS 管理 FIS SSM ドキュメントを利用。追加設定不要でインスタンス起動直後から使用可能 |
| CloudFront VPC Origin + S3 フォールバック | 502/503/504 発生時にブラウザエラーではなくブランドページを表示。C-1・C-4 の実験中もユーザー体験を維持 |
| ライター + リーダー Aurora 構成 | `aws:rds:failover-db-cluster` はリーダーが 1 台以上必要。最小構成で C-3 フェイルオーバーを実現 |
| タグベースの EC2 ターゲティング | `fis-target: app-instance` タグにより、スケールイン・アウトでインスタンスが入れ替わっても FIS テンプレートの変更不要 |
| 共有停止条件 (ALB 5xx) | 1 つの CloudWatch Alarm が 4 つの実験すべてを自動停止 |

## 前提条件

- AWS CLI v2 のインストールと設定
- Node.js 20 以降
- AWS CDK CLI (`npm install -g aws-cdk`)
- TypeScript の基礎知識
- FIS サービスリンクロールが作成済みの AWS アカウント（初回 FIS 利用時に自動作成）

## プロジェクトのディレクトリ構成

```text
fis-arch-c-ec2-asg-rds/
├── bin/
│   └── fis-arch-c-ec2-asg-rds.ts             # アプリエントリポイント（Stage のインスタンス化）
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts                 # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                      # VPC + Aurora PostgreSQL Serverless v2
│       ├── app-stack.ts                       # EC2 ASG + Internal ALB + CloudFront
│       └── fis-stack.ts                       # FIS 実験テンプレート 4 本 + IAM + アラーム
├── parameters/
│   ├── environments.ts                        # 環境パラメータ型定義
│   ├── dev-params.ts                          # 開発環境パラメータ
│   └── index.ts                               # パラメータエクスポート
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts                   # cdk-nag AwsSolutions コンプライアンスチェック
│   └── snapshot/
│       └── snapshot.test.ts                  # CDK スナップショットテスト（13 ケース）
├── cdk.json
├── package.json
└── tsconfig.json
```

## データフロー

```text
ユーザー (ブラウザまたは curl)
  │  HTTPS
  ▼
CloudFront Distribution
  │  VPC Origin（プライマリ: Internal ALB への HTTP）
  │  S3 バケットオリジン（フォールバック: 502/503/504 時）
  ▼
Internal ALB  (CloudFront マネージドプレフィックスリスト受信、プライベートサブネット)
  │  HTTP/80 リスナー → INSTANCE ターゲットグループ
  ▼
EC2 Auto Scaling Group  (t3.small、AL2023、min=2/max=4)
  │  nginx ステータスページ: インスタンス ID + AZ (IMDSv2 経由で取得)
  │  SSM エージェント登録済み（C-2・C-4 に必要）
  ▼
Aurora PostgreSQL Serverless v2
  │  ライター 1 台 + リーダー 1 台（C-3 aws:rds:failover-db-cluster に必要）
  │  Isolated サブネット、ポート 5432、ストレージ暗号化
  ▼
（Aurora シークレットを Secrets Manager 経由で読み取り — オプションの DB ヘルスエンドポイント）
```

## 主要コンポーネントと設計のポイント

| コンポーネント | 設計のポイント |
| -------------- | -------------- |
| VPC | CIDR 10.20.0.0/16; パブリック / プライベート / Isolated の 3 サブネット層、NAT Gateway × 1 |
| Aurora PostgreSQL Serverless v2 | エンジン v16.4; ライター 1 台 + リーダー 1 台; 最小 0.5 ACU、最大 4 ACU; Isolated サブネット; ストレージ暗号化; CloudWatch ログエクスポート |
| EC2 Auto Scaling Group | t3.small; AL2023 (SSM エージェントプリインストール); requireImdsv2; EBS gp3 20 GB 暗号化; タグ `fis-target: app-instance` |
| Internal ALB | CloudFront VPC Origin 受信 (マネージドプレフィックスリスト); HTTP/80; ターゲット登録解除遅延 30 秒 |
| CloudFront Distribution | VPC Origin（プライマリ）→ S3（502/503/504 フォールバック）; CACHING_DISABLED; REDIRECT_TO_HTTPS |
| FIS IAM ロール | タグ条件付き `ec2:TerminateInstances`; タグ付きインスタンス + FIS ドキュメントへの `ssm:SendCommand`; クラスター ARN 指定の `rds:FailoverDBCluster`; CloudWatch Logs 配信 |
| 停止条件 | ALB `TARGET_5XX_COUNT >= 50` / 1 分間 — 4 つの実験テンプレートすべてで共有 |
| FIS ログ グループ | `/fis/{project}-{env}` — 保持期間 1 ヶ月、スタック削除時に自動削除 |

## 実装のポイント

### 1. SSM ベースの障害注入（C-2 と C-4）

C-2 と C-4 は AWS マネージド SSM ドキュメントを FIS から呼び出します。Amazon Linux 2023 にプリインストールされた SSM エージェントが各インスタンス上でドキュメントを実行します。

```typescript
// C-2: 全インスタンスへの CPU ストレス
actions: {
    InjectCpuStress: {
        actionId: 'aws:ssm:send-command',
        parameters: {
            documentArn: `arn:aws:ssm:${cdk.Aws.REGION}::document/AWSFIS-Run-CPU-Stress`,
            documentParameters: JSON.stringify({
                CPU: '0',             // 全 vCPU にストレス
                DurationSeconds: '300',
                InstallDependencies: 'True',
            }),
            duration: 'PT5M',
        },
        targets: { Instances: 'AppInstances' },
    },
},

// C-4: 全インスタンスで PostgreSQL 送信をブロック
actions: {
    BlackholeDbPort: {
        actionId: 'aws:ssm:send-command',
        parameters: {
            documentArn: `arn:aws:ssm:${cdk.Aws.REGION}::document/AWSFIS-Run-Network-Blackhole-Port`,
            documentParameters: JSON.stringify({
                Protocol: 'tcp',
                TrafficType: 'egress',
                Port: '5432',
                DurationSeconds: '300',
                InstallDependencies: 'True',
            }),
            duration: 'PT5M',
        },
        targets: { Instances: 'AppInstances' },
    },
},
```

SSM ドキュメント ARN は `arn:aws:ssm:REGION::document/AWSFIS-*`（アカウント ID なし）の形式です。これらは AWS 所有のマネージドドキュメントのため、アカウント ID を含みません。FIS IAM ロールは、インスタンスリソース（タグ条件でスコープ）とドキュメント ARN に対して別々の `ssm:SendCommand` ポリシーを付与します。

### 2. タグベースの EC2 ターゲティング（C-1、C-2、C-4）

3 つの EC2 ターゲティングシナリオはすべて、ハードコードされた ARN の代わりに `fis-target: app-instance` タグを使用します。これにより、ASG のスケールイン・アウトでインスタンスが入れ替わっても FIS テンプレートの更新が不要になります。

```typescript
// ASG に CDK Tags でタグを付与
cdk.Tags.of(this.asg).add('fis-target', 'app-instance');

// FIS ターゲット定義
targets: {
    AppInstances: {
        resourceType: 'aws:ec2:instance',
        resourceTags: { 'fis-target': 'app-instance' },
        selectionMode: 'PERCENT(50)',  // C-1
        // または 'ALL'（C-2、C-4）
    },
},
```

FIS IAM ロールも同一タグを IAM 条件で強制します。

```typescript
new iam.PolicyStatement({
    actions: ['ec2:TerminateInstances'],
    resources: [`arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:instance/*`],
    conditions: {
        StringEquals: { 'aws:ResourceTag/fis-target': 'app-instance' },
    },
}),
```

### 3. Aurora ライター→リーダーフェイルオーバー（C-3）

C-3 は `aws:rds:failover-db-cluster` をクラスター ARN 直接指定で実行します。実験の継続時間は Aurora がリーダーをライターに昇格させるまでの時間（通常 20〜30 秒）に依存します。

BaseStack が 1 ライター + 1 リーダーをプロビジョニングするのは、`aws:rds:failover-db-cluster` が少なくとも 1 台のリーダーを必要とするためです。リーダーなしでは「サポートされないクラスタートポロジー」エラーで失敗します。

### 4. CloudFront VPC Origin + S3 フォールバック

CloudFront ディストリビューションは Origin Group を使用し、Internal ALB をプライマリ、S3 バケットを 502/503/504 のフォールバックとして構成します。これにより、C-1（インスタンス終了）や C-4（ネットワークブラックホール）の実験中もユーザーはブランドページを受け取り、ブラウザレベルの接続エラーは表示されません。

### 5. 停止条件と安全ネット

4 つすべてのテンプレートが 1 つの ALB 5xx 停止条件を共有します。閾値を超えると FIS が自動的に実験を停止し、注入した障害を元に戻します。

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
    cloudfrontManagedPrefixList: 'pl-58a04531',  // ap-northeast-1 CloudFront プレフィックスリスト
    // alarmEmail: 'ops@example.com',             // アラーム通知メールを受け取る場合はコメントアウト解除
};
```

### 3. CDK ブートストラップ（初回のみ）

```bash
PROJECT=fis-chaos-c ENV=dev npm run bootstrap
```

### 4. 全スタックのデプロイ

```bash
PROJECT=fis-chaos-c ENV=dev npm run stage:deploy:all
```

依存関係の順番で 3 つのスタックがデプロイされます。
1. `fis-chaos-c-dev-c-base` — VPC + Aurora PostgreSQL Serverless v2
2. `fis-chaos-c-dev-c-app` — EC2 ASG + Internal ALB + CloudFront
3. `fis-chaos-c-dev-c-fis` — FIS テンプレート + IAM + アラーム

### 5. アプリケーションのテスト

デプロイ後、スタックの出力から CloudFront ドメインを取得します。

```bash
# nginx ステータスページの確認
curl https://<cloudfront-domain>/

# レスポンス例:
# <h1>FIS Chaos Demo — Architecture C</h1>
# <p>Instance: i-0123456789abcdef0</p>
# <p>AZ: ap-northeast-1a</p>
# <p>Status: OK</p>
```

### 6. FIS 実験の実行

AWS FIS コンソールから実験テンプレート（C-1 〜 C-4）を選択し、**実験を開始**をクリックして、次の項目を観察します。
- C-1: EC2/ALB コンソールの ALB ターゲットヘルス
- C-2: CloudWatch CPU メトリクスと ASG アクティビティ
- C-3: RDS コンソールの Aurora フェイルオーバーイベント
- C-4: ALB 5xx レートと SSM コマンド履歴

## テスト

```bash
cd infrastructure
npm ci

# このワークスペースの全テストを実行
npm run test --workspace=fis-arch-c-ec2-asg-rds

# スナップショットテストのみ（3 スタックで 13 テストケース）
npm run test:snapshot --workspace=fis-arch-c-ec2-asg-rds

# CDK Nag コンプライアンスチェック
npm run test:compliance --workspace=fis-arch-c-ec2-asg-rds

# 意図的な変更後にスナップショットを更新
npm run test:snapshot:update --workspace=fis-arch-c-ec2-asg-rds
```

### テストカバレッジ

| テストスイート | ファイル | アサーション |
| -------------- | -------- | ------------ |
| スナップショット | `test/snapshot/snapshot.test.ts` | 3 スタック全体の CloudFormation テンプレートスナップショット; Aurora ストレージ暗号化; VPC 存在確認; ASG 存在確認; ALB が internal であること; CloudFront ディストリビューション数; FIS テンプレートがちょうど 4 本; 全テンプレートに停止条件あり |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions パック — 未抑制の警告・エラーがないこと（6 テストケース） |

## コスト見積もり

Aurora Serverless v2 と EC2 インスタンスはアイドル時でも時間課金が発生します。実験終了後は速やかにスタックを削除してください。

| サービス | 課金モデル | 概算コスト（1 時間の実験ウィンドウ） |
| -------- | ---------- | ------------------------------------- |
| EC2 (t3.small × 2) | 時間課金 | 約 $0.04/時間 |
| Aurora Serverless v2 (最小 0.5 ACU × 2 インスタンス) | ACU 時間課金 | 約 $0.06/時間 |
| NAT Gateway | 時間課金 + データ転送 | 約 $0.05/時間 |
| ALB | 時間課金 | 約 $0.02/時間 |
| CloudFront | リクエスト + データ転送 | < $0.01 |
| FIS | 無料 | 課金なし |
| **合計（1 時間）** | | **約 $0.17/時間** |

## セキュリティ上の考慮事項

- **IMDSv2 必須** (`requireImdsv2: true`) — メタデータサービス経由の SSRF 攻撃を防止
- **EBS ルートボリューム暗号化** (gp3) — AwsSolutions-EC26 を満たす
- **ALB 受信を CloudFront マネージドプレフィックスリストに制限** — CloudFront をバイパスした直接 VPC 内アクセスを防止
- **FIS IAM ロールをタグ条件でスコープ** — `ec2:TerminateInstances` と `ssm:SendCommand` を `fis-target: app-instance` タグを持つインスタンスのみに制限
- **Aurora を Isolated サブネットに配置** — インターネットへのルートなし。VPC 内からポート 5432 でのみアクセス可能
- **停止条件は必須** — 全 FIS テンプレートに ALB 5xx アラーム停止条件を含む

## トラブルシューティング

| 症状 | 考えられる原因 | 対処方法 |
| ---- | -------------- | -------- |
| `cdk deploy` が `No parameters found` で失敗 | `dev-params.ts` のエクスポートが欠落 | `parameters/index.ts` が `dev` キーで `devParams` をエクスポートしているか確認 |
| C-2/C-4 が `SSM agent not registered` で失敗 | インスタンスが SSM に接続していない | IAM インスタンスロールに `AmazonSSMManagedInstanceCore` があるか確認。Fleet Manager で SSM エージェントのステータスを確認 |
| C-3 が `cluster does not support failover` で失敗 | リーダーインスタンスがない | BaseStack を `readers` 配列に少なくとも 1 インスタンスを含めてデプロイ |
| FIS 実験がすぐに停止する | 停止条件のアラームがすでに `ALARM` 状態 | アラームをリセット: `aws cloudwatch set-alarm-state --alarm-name ... --state-value OK` |
| CloudFront が 403 を返す | VpcOrigin ENI が関連付けられていない | 初回デプロイ後に VPC Origin ENI がプロビジョニングされるまで待つ（約 5 分） |

## クリーンアップ

```bash
PROJECT=fis-chaos-c ENV=dev npm run stage:destroy:all
```

全リソースに `removalPolicy: DESTROY` が設定されているため、destroy コマンドで Aurora クラスター、EC2 ASG、ALB、CloudFront ディストリビューション、VPC、FIS テンプレート、CloudWatch ロググループが完全に削除されます。

## まとめ

本ワークスペースは、クラシックな 3 層 EC2 アーキテクチャ上でのFIS カオスエンジニアリングをデモします。4 つのシナリオは各層の異なる障害モードを網羅しています。

- **C-1**: インスタンスが突然半数終了された場合に ASG が自己修復することを検証 — ALB の登録解除速度と CloudFront の S3 フォールバックを確認
- **C-2**: 持続的な CPU 負荷下で ASG スケールアウトポリシーが発動し、新規インスタンスが SLO ウィンドウ内に ALB ヘルスチェックをパスすることを検証
- **C-3**: Aurora のライター→リーダー昇格（約 30 秒）の間に EC2 アプリケーションのコネクションプールが正常に再接続することを検証
- **C-4**: データベースがネットワーク層で到達不能になった場合に、クエリタイムアウトとサーキットブレーカーの設定が ALB ヘルスチェックのハングアップを防ぐことを検証

本アーキテクチャはアーキテクチャ B（サーバーレス）を補完し、`aws:fis:inject-api-*` では到達できない EC2 とリレーショナルデータベースの障害ドメインをカバーします。

## 参考資料

- [AWS FIS — サポートされるアクション](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [AWSFIS-Run-CPU-Stress SSM ドキュメント](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-ssm)
- [AWSFIS-Run-Network-Blackhole-Port SSM ドキュメント](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-ssm)
- [aws:rds:failover-db-cluster アクションリファレンス](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-rds)
- [CloudFront VPC Origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)
- [CDK aws-fis モジュール（L1 コンストラクト）](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
