# CloudFront VPC Origin — CloudFrontでS3静的ホスティングとALBを配信(インシデント対応の退避経路つき)

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-200-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-CloudFront%20%7C%20S3%20%7C%20ALB%20%7C%20Lambda%20%7C%20VPC-orange?style=flat-square)

## はじめに

このプロジェクトは、1つのAmazon CloudFrontディストリビューションで2種類の異なるオリジン、すなわち静的Webサイトを配信する非公開のS3バケットと、CloudFrontが**VPC Origin**経由でアクセスする**内部（非公開）**のApplication Load Balancerを配信するリファレンス実装です。

このアーキテクチャでは、以下の実装を確認することができます。

- Origin Access Control (OAC) を使用して、非公開のS3バケットからCloudFront経由で静的Webサイトを配信
- パブリックIPやNATゲートウェイを使わず、VPC Origin経由でCloudFrontから内部（非インターネット向け）ALBへ直接接続
- CloudFrontのOrigin Groupを使用した、ALBから静的なフォールバックページへの自動フェイルオーバー
- ALB自体でのパスベースルーティング（固定レスポンス、カスタムHTMLレスポンス、Lambdaによるレスポンス）
- CloudFrontのジオ制限による、明示的な許可国リストへの配信制限
- CloudFront Functionによるエッジでのビューアーアクセス元IP許可リスト（任意）と、拒否されたリクエストをCloudFront標準ログ（v2）経由でCloudWatch Logsに記録
- ビューアーに対する最小プロトコルバージョンとしてのTLS 1.3（2025）

## アーキテクチャ概要

![overview](overview.drawio.svg)

### 設計上の主な利点

| 機能 | メリット |
| ---- | -------- |
| VPC Origin | CloudFrontが非公開のALBに直接到達できる。インバウンド通信のためのパブリックIPやNATゲートウェイが不要 |
| Origin Groupによるフェイルオーバー | ALBが異常時・到達不能時でも、生の502/503ではなく、わかりやすい静的ページを表示できる |
| エッジでのIP許可リスト | 許可されていないIPからのリクエストは、ALBやS3に到達する前にエッジで拒否される |
| ジオ制限 | 明示的に許可した国からのアクセスのみにコンテンツ配信を制限できる |
| OACで保護されたS3オリジン | WebsiteBucketとErrorBucketはいずれも完全に非公開のまま。読み取れるのはCloudFrontのみ |

## 前提条件

- AWS CLI v2がインストール・設定済み
- Node.js 20以上
- AWS CDK CLI (`npm install -g aws-cdk`)
- TypeScriptの基礎知識
- AWSアカウント（このスタックはALBとVPCを作成し、時間課金が発生します。[料金の目安](#料金の目安)を参照してください）

## プロジェクトのディレクトリ構成

```text
cloudfront-vpc-origin/
├── bin/
│   └── cloudfront-vpc-origin.ts             # アプリケーションのエントリーポイント
├── lib/
│   └── stacks/
│          ├── cloudfront-vpc-origin-stack.ts    # VPC、ALB、S3バケット、CloudFront
│          ├── cloudfront-log-delivery-stack.ts  # us-east-1: CloudFront Functionのログ配信
│          └── cloudfront-monitoring-stack.ts    # us-east-1: 5xxエラー率アラーム + SNSトピック
├── parameters/
│   ├── environments.ts                 # 環境パラメータの型定義
│   ├── dev-params.ts                   # 開発環境パラメータ
│   └── index.ts                        # パラメータのエクスポート
├── test/
│   ├── compliance/
│   │      └── cdk-nag.test.ts          # cdk-nagによるコンプライアンスチェック
│   ├── snapshot/
│   │      └── snapshot.test.ts         # スナップショットテスト
│   └── unit/
│          ├── cloudfront-vpc-origin.test.ts # 詳細なアサーションテスト
│          └── cloudfront-monitoring.test.ts # アラーム/SNSのアサーションテスト
├── cdk.json
├── package.json
└── tsconfig.json
```

> このスタックが配信する静的サイトのコンテンツは、このワークスペースの外側、`frontend/static-web`（デフォルトページ）と`frontend/error-website`（ALBオリジンに到達できない場合に表示されるフォールバックページ）にあります。

## データフロー

```text
ビューアー
  │  HTTPS（最小TLS 1.3、JP/US/GB/CA/AU/NZ/IEにジオ制限）
  ▼
CloudFrontディストリビューション
  ├─ CloudFront Function（任意）: 許可リストにないIPのビューアーを拒否
  │
  ├─ デフォルトビヘイビア（"/*"）
  │     └─ S3オリジン（OAC）──────────────► WebsiteBucket（非公開）
  │
  └─ ビヘイビア（"/alb/*"）
        └─ Origin Group
              ├─ プライマリ: VPC Origin ────► 内部ALB（プライベートサブネット）
              │                                 ├─ "/"（デフォルト）    → 固定テキストレスポンス
              │                                 ├─ "/alb/custom*"        → 固定HTMLレスポンス
              │                                 └─ "/alb/lambda*"        → Lambda関数ターゲット
              └─ フォールバック（403/404/500/502/503/504）: S3オリジン（OAC）─► ErrorBucket（非公開）
```

ALBのセキュリティグループは、AWS管理のCloudFrontプレフィックスリストからのポート80のインバウンド通信のみを許可しています。そのため、CloudFront自体はインターネットから到達可能であるにもかかわらず、ALBへ直接アクセスすることはできません。これはALBの2つのモード（後述の[インシデント対応の退避経路](#6-インシデント対応の退避経路publicalbfailover)を参照）のいずれでも変わりません。通常ALBは内部向けでVPC Origin経由でのみ到達可能ですが、`publicAlbFailover.enabled: true`にするとインターネット向けになります。それでもセキュリティグループはCloudFrontプレフィックスリストのみを許可し続けるため、クライアントから直接到達されることはありません。

## 主要コンポーネントと設計ポイント

| コンポーネント | 設計ポイント |
| -------------- | ------------ |
| VPC | マルチAZ、パブリック + プライベート（分離）サブネット（共通の`VpcConstruct`を利用） |
| ALB | デフォルトは内部向け（`internetFacing: false`）でプライベート（分離）サブネットに配置。`publicAlbFailover.enabled: true`の場合はパブリックサブネットのインターネット向けに切り替わる |
| ALBセキュリティグループ | どちらのALBモードでも、インバウンドポート80をCloudFront管理プレフィックスリストのみに制限 |
| ALBリスナー | デフォルトは固定レスポンス、`/alb/custom*`は固定HTMLレスポンス、`/alb/lambda*`はLambdaターゲットへルーティング |
| WebsiteBucket / ErrorBucket | 非公開のS3バケット、`enforceSSL: true`、`BucketDeployment`でコンテンツを配信、CloudFrontからOAC経由でのみ読み取り可能 |
| CloudFrontディストリビューション | 最小TLS 1.3（2025）、IPv6無効、ジオ制限による許可リスト、専用アクセスログバケット |
| CloudFront Origin Group（`/alb/*`） | 通常はVPC Origin（プライマリ）→ S3エラーページ（フォールバック）。`publicAlbFailover.enabled: true`の場合はパブリックHTTPオリジン（プライマリ）→ VPC Origin（フォールバック）に切り替わる。VPC Originの登録自体は削除されない |
| CloudFront Function | ビューアーIPの許可リスト（任意）、`viewer-request`イベントで評価 |
| 標準ログ（v2） | CloudFront Functionが拒否したリクエストのログデータをCloudWatch Logsのロググループへ配信 |
| CloudfrontMonitoringStack（us-east-1） | ディストリビューションの5xxエラー率に対するCloudWatchアラームをSNSトピックへ通知 |

## 実装のポイント

### 1. CloudFrontからのみアクセス可能なALB

ALBは内部向けで、そのセキュリティグループはAWS管理のCloudFrontプレフィックスリストに対してのみポート80を開放しています。VPCのパブリックサブネット内であっても、それ以外からはアクセスできません。

```typescript
const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
  vpc: this.vpc.vpc,
  allowAllOutbound: true,
});

albSecurityGroup.addIngressRule(
  ec2.Peer.prefixList(props.cloudfrontManagedPrefixList),
  ec2.Port.tcp(80),
  'Allow inbound HTTP traffic from CloudFront managed prefix list'
);

const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
  vpc: this.vpc.vpc,
  internetFacing: false,
  securityGroup: albSecurityGroup,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
});
```

> **注意**: 管理プレフィックスリストID（`cloudfrontManagedPrefixList`）はリージョン固有です。デプロイ前に以下のコマンドで確認してください。
>
> ```bash
> aws ec2 describe-managed-prefix-lists \
>   --filters "Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing"
> ```

### 2. ALBリスナーでのパスベースルーティング

同一ALBの背後で、3種類の異なるレスポンスタイプを示すリスナーアクションを用意しています。

```typescript
listener.addAction('DefaultAction', {
  action: elbv2.ListenerAction.fixedResponse(200, {
    contentType: 'text/plain',
    messageBody: 'CloudFront with VPC Origin and ALB!',
  }),
});

listener.addAction('CustomPageAction', {
  action: elbv2.ListenerAction.fixedResponse(200, {
    contentType: 'text/html',
    messageBody: '<html><body><h1>Custom Page</h1></body></html>',
  }),
  conditions: [elbv2.ListenerCondition.pathPatterns(['/alb/custom*'])],
  priority: 10,
});

listener.addTargets('LambdaTarget', {
  targets: [new elbv2_targets.LambdaTarget(albLambdaFunction)],
  conditions: [elbv2.ListenerCondition.pathPatterns(['/alb/lambda*'])],
  priority: 20,
});
```

### 3. VPC OriginとOrigin Groupによる静的エラーページへのフェイルオーバー

CloudFrontは**VPC Origin**経由で内部ALBに到達します。パブリックIPもNATゲートウェイも不要です。ALBが利用できない場合、CloudFrontは自動的に`ErrorBucket`内の静的ページへフェイルオーバーします。

```typescript
const originGroup = new cloudfront_origins.OriginGroup({
  primaryOrigin: cloudfront_origins.VpcOrigin.withApplicationLoadBalancer(alb, {
    httpPort: 80,
  }),
  fallbackOrigin: cloudfront_origins.S3BucketOrigin.withOriginAccessControl(errorBucket),
  fallbackStatusCodes: [403, 404, 500, 502, 503, 504],
});

distribution.addBehavior('/alb/*', originGroup, {
  viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
});
```

### 4. CloudFrontディストリビューションのデフォルト設定

デフォルトビヘイビアは、OAC経由でS3から直接静的サイトを配信し、最新のTLSポリシーと明示的な国別許可リストを適用します。

```typescript
const distribution = new cloudfront.Distribution(this, 'Distribution', {
  minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_3_2025,
  enableIpv6: false,
  enableLogging: true,
  geoRestriction: cloudfront.GeoRestriction.allowlist('JP', 'US', 'GB', 'CA', 'AU', 'NZ', 'IE'),
  defaultBehavior: {
    origin: cloudfront_origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  },
  logBucket: cloudFrontLogBucket,
  logFilePrefix: `${props.project}-${props.environment}/cloudfront-logs/`,
  logIncludesCookies: true,
});
```

> **注意**: CloudFrontのレガシー標準アクセスログ（`logBucket`）は、S3の「log delivery」canned ACL経由で書き込まれます。そのため、ログバケットには`objectOwnership: OBJECT_WRITER`と`accessControl: LOG_DELIVERY_WRITE`を設定する必要があります。デフォルト設定（ACL無効／バケット所有者による強制）のバケットでは、この書き込みは拒否されます。

### 5. CloudFront Functionによるビューアーの任意IP許可リスト

`allowedIps`を指定すると、CloudFront Functionがすべてのビューアーリクエストで実行され、許可リストにないIPを拒否します。`bin/cloudfront-vpc-origin.ts`は、デプロイを実行している操作者の現在のグローバルIPを自動検出するヘルパーを呼び出しているため、`cdk deploy`を実行するたびに、実行者自身のIPが許可リストに追加されます。

```typescript
allowedIps: [getMyGlobalIp()],
```

```typescript
function handler(event) {
  var request = event.request;
  var allowedIps = ['203.0.113.10']; // synth時に埋め込まれる
  if (!allowedIps.includes(request.clientIp)) {
    cf.logCustomData(JSON.stringify({ clientIp: request.clientIp, allowedIps: allowedIps }));
    return { statusCode: 403, statusDescription: 'Forbidden', body: 'Access denied' };
  }
  return request;
}
```

`allowedIps`を設定しない場合、CloudFront Function自体が作成されません。この場合、ディストリビューションは（ジオ制限の範囲内で）すべてのビューアーに公開されます。

拒否されたリクエストのデータ（`cf.logCustomData`）は、CloudFrontの**標準ログv2**を通じて専用のCloudWatch Logsロググループに配信されるため、誰が・なぜブロックされたのかを調査できます。

```typescript
const logDeliverySource = new logs.CfnDeliverySource(this, 'CloudFrontLogDeliverySource', {
  logType: 'ACCESS_LOGS',
  resourceArn: distribution.distributionArn,
});
const logDeliveryDestination = new logs.CfnDeliveryDestination(this, 'CloudFrontLogDeliveryDestination', {
  destinationResourceArn: denyAccessLogGroup.logGroupArn,
});
new logs.CfnDelivery(this, 'CloudFrontLogDelivery', {
  deliverySourceName: logDeliverySource.name,
  deliveryDestinationArn: logDeliveryDestination.attrArn,
  recordFields: ['date', 'time', 'c-ip', 'cs-method', 'cs-uri-stem', 'sc-status', 'cache-behavior-path-pattern', 'viewer-request-log-data'],
});
```

### 6. インシデント対応の退避経路（`publicAlbFailover`）

2026年7月16日、AWS CloudFrontで数時間にわたる障害が発生し、**VPC Origins**を利用している顧客で5xxエラーが急増しました。VPC Originの接続レイヤー自体が劣化しており、顧客側のスタックの設定とは無関係の問題でした。当時のAWSの公式ガイダンスは、可能な顧客に対して一時的にVPC Origin接続を使わない方式へ切り替え、問題解消後に元に戻すというものでした。

このスタックでは、インシデントの最中に手作業でCloudFormationを変更するのではなく、`publicAlbFailover`というパラメータでこの切り替えを組み込んでいます。

```typescript
// publicAlbFailoverの値にかかわらず常に登録される。すぐに元へ戻せるように準備しておくため。
const vpcOriginAlb = cloudfront_origins.VpcOrigin.withApplicationLoadBalancer(alb, { httpPort: 80, /* ... */ });

// 同じALBに、通常のパブリックHTTPオリジンとしてアクセスする
const publicAlbOrigin = new cloudfront_origins.HttpOrigin(alb.loadBalancerDnsName, {
  httpPort: 80,
  protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
});

const originGroup = new cloudfront_origins.OriginGroup({
  primaryOrigin: publicAlbFailoverEnabled ? publicAlbOrigin : vpcOriginAlb,
  fallbackOrigin: publicAlbFailoverEnabled ? vpcOriginAlb : errorPageOrigin,
  fallbackStatusCodes: [403, 404, 500, 502, 503, 504],
});
```

設計上のポイント:

- **トラフィックは常にCloudFront経由のまま。** これを有効にするとALBはインターネット向けになります（VPC Origin接続の代わりにCloudFrontが通常のHTTPオリジンとして到達するために必要）が、そのセキュリティグループはCloudFront管理プレフィックスリストのみを許可し続け、開かれたインターネットへは決して開放されません。クライアントは常に同じCloudFrontのURLを使い続け、クライアント側で変更すべきことは何もありません。
- **VPC Originの登録は決して削除されません。** 退避経路が有効な間も、Origin Groupのフォールバックとしてディストリビューションに紐づいたままなので、元に戻す作業は`enabled`を`false`に戻して再デプロイするだけです。新しくVPC Originが作成されるのを待つ必要はありません。
- **`publicAlbFailover.enabled: true`にすると`cloudfrontManagedPrefixList`が必須になります。** 設定されていない場合、synth時にスタックがエラーを投げます。これがないと、インターネット向けになったALBへのアクセスをCloudFrontのみに制限する方法がなくなるためです。
- **トレードオフ**: 有効化している間、わかりやすい静的ページへのフォールバック（`ErrorBucket`）は一時的にOrigin Groupから外れます（Origin Groupはメンバーを2つまでしかサポートしないため）。短期間のインシデント対応中の間だけであれば、許容できるトレードオフです。

インシデント発生時の使い方:

```typescript
// parameters/dev-params.ts
publicAlbFailover: {
    enabled: true, // falseから変更
},
```

```bash
npm run deploy:all
```

AWS側で根本原因が解消されたら、`enabled: false`に戻して再デプロイしてください。

### 7. 5xxエラー率アラーム（`CloudfrontMonitoringStack`）

常にus-east-1にデプロイされる別スタックが、ディストリビューション全体の`5xxErrorRate`メトリクスを監視します（CloudFrontのリクエスト・エラーメトリクスはus-east-1でのみ公開され、CloudWatch Alarmは自身と同じリージョンのメトリクスしか評価できません。メインスタック自体がどのリージョンにあるかは関係ありません）。5分間隔で3回連続して5%以上になると、SNSトピックへ通知します。

```typescript
const alarm = new cloudwatch.Alarm(this, 'CloudFront5xxErrorRateAlarm', {
  metric: new cloudwatch.Metric({
    namespace: 'AWS/CloudFront',
    metricName: '5xxErrorRate',
    dimensionsMap: { DistributionId: props.distributionId },
    period: cdk.Duration.minutes(5),
    statistic: cloudwatch.Stats.AVERAGE,
  }),
  threshold: 5,
  evaluationPeriods: 3,
  datapointsToAlarm: 3,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
```

`parameters/dev-params.ts`で`alarmEmail`を設定するとメール通知を受け取れます。設定しなくてもSNSトピック自体は作成される（ARNがスタック出力される）ので、ChatBotやPagerDutyなどへ後から接続することもできます。これは、2026年7月16日の障害でAWS自身が言及した「ディストリビューション全体での5xx急増」と同じシグナルであり、実際に運用者が`publicAlbFailover`の有効化を検討するきっかけになるものです。

## デプロイ手順

### ステップ1: 環境パラメータを設定する

`parameters/dev-params.ts`を編集します。

```typescript
const devParams: EnvParams = {
  region: 'ap-northeast-1',
  vpcConfig: { /* VPC設定 */ },
  cloudfrontManagedPrefixList: 'pl-xxxxxxxx', // 対象リージョンのCloudFront origin-facing管理プレフィックスリスト
  publicAlbFailover: { enabled: false },       // インシデント対応の退避経路 — 後述
  alarmEmail: 'ops-team@example.com',          // 任意 — 5xxエラー率アラームの通知先
};
```

### ステップ2: ブートストラップとデプロイ

npmスクリプトは`PROJECT`と`ENV`環境変数からデプロイ対象のプロジェクト・環境を読み取り、AWS CLIプロファイル`${PROJECT}-${ENV}`を使用します。

```bash
export PROJECT=your-project
export ENV=dev

npm run bootstrap   # 初回のみ
npm run diff
npm run deploy:all
```

### ステップ3: ディストリビューションへアクセスする

スタックはディストリビューションのドメイン名とURLを出力します。

```bash
aws cloudformation describe-stacks \
  --stack-name YourProjectDev \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontURL`].OutputValue' \
  --output text
```

```bash
# S3から配信される（static-web/index.html）
curl https://<distribution-domain>/

# Origin Group経由でALBから配信される
curl https://<distribution-domain>/alb/
curl https://<distribution-domain>/alb/custom
curl https://<distribution-domain>/alb/lambda
```

ビューアーのIPが`allowedIps`に含まれていない場合、これらのリクエストはCloudFront Functionにより`403 Forbidden`となります。

## テスト

```bash
npm test -w workspaces/cloudfront-vpc-origin              # すべてのテスト
npm run test:unit -w workspaces/cloudfront-vpc-origin      # ユニットテスト
npm run test:snapshot -w workspaces/cloudfront-vpc-origin   # スナップショットテスト
npm run test:compliance -w workspaces/cloudfront-vpc-origin # cdk-nagチェック
```

## カスタマイズ

### 許可国を絞り込む

```typescript
geoRestriction: cloudfront.GeoRestriction.allowlist('JP'),
```

### 複数のビューアーIPを許可する

```typescript
allowedIps: ['203.0.113.10', '198.51.100.0/24'],
```

### カスタムドメインを追加する

現在このスタックは、CloudFrontのデフォルトドメイン（`*.cloudfront.net`）でトラフィックを配信しています。カスタムドメインを追加するには、（`us-east-1`の）ACM証明書を用意し、`Distribution`コンストラクトに`domainNames`と`certificate`のペアを指定したうえで、ディストリビューションを指すRoute 53のエイリアスレコードを追加してください。

### インシデント対応の退避経路を有効化する

詳細は前述の[インシデント対応の退避経路](#6-インシデント対応の退避経路publicalbfailover)を参照してください。要点だけ言えば、`parameters/dev-params.ts`の`publicAlbFailover.enabled`を`true`にして再デプロイし、解消後に元へ戻すだけです。

```typescript
publicAlbFailover: { enabled: true },
```

## 料金の目安

<details>
<summary>💰 月額料金の目安（東京リージョン、低トラフィック時）</summary>

| サービス | 使用量 | 月額料金の目安 |
| -------- | ------ | -------------- |
| Application Load Balancer | 常時稼働 | 約$16.00 |
| CloudFront | 少ないリクエスト数、少量のデータ転送 | 約$1〜2 |
| S3（3バケット） | 数MBの静的コンテンツ＋アクセスログ | $0.10未満 |
| Lambda | `/alb/lambda*`背後での散発的な呼び出し | 無料利用枠内 |
| CloudWatch Logs | 拒否リクエストのログ記録（`allowedIps`設定時のみ） | $0.10未満 |
| CloudWatch Alarm + SNS | アラーム1つ、通知は発生時のみ | $0.10未満 |

**月額合計の目安: 約$18〜20**

</details>

> ALBはトラフィックの有無にかかわらず時間課金されます。短時間の演習のためだけにこのスタックを使う場合は、終了後に[クリーンアップ](#クリーンアップ)を必ず実行してください。

## セキュリティ上の考慮事項

- ✅ S3オリジンバケット（`WebsiteBucket`、`ErrorBucket`）はいずれも完全に非公開でパブリックアクセスをブロック。読み取れるのはOrigin Access Control経由のCloudFrontのみ
- ✅ すべてのS3バケットで`enforceSSL: true`を設定し、HTTPS以外のアクセスを拒否
- ✅ ALBのセキュリティグループはCloudFront管理プレフィックスリストからの通信のみを許可。`publicAlbFailover.enabled: true`でインターネット向けになった場合でも、クライアントから直接到達されることはない
- ✅ ビューアーから受け付ける最小プロトコルバージョンはTLS 1.3（2025）
- ✅ ジオ制限により、そもそもディストリビューションに到達できる国を制限
- ✅ CloudFront Function（任意）により、エッジでビューアーIPに基づく2段目のアクセス制御を追加

## トラブルシューティング

### リクエストが想定外に403を返す

**考えられる原因**: 現在のIPが`allowedIps`に含まれていない、またはリクエスト元がジオ制限の許可国リストに含まれていない。

```bash
# 拒否されたリクエストを確認する（allowedIps設定時のみ）
aws logs tail /aws/cloudfront/<project>-<env>-deny-access --follow
```

### `/alb/*`がALBのレスポンスではなくフォールバックのエラーページを返す

**考えられる原因**: ALBのセキュリティグループがCloudFront管理プレフィックスリストを許可していない、`dev-params.ts`のプレフィックスリストIDが対象リージョンと一致していない、またはALBのターゲット・リスナーが異常な状態になっている。

```bash
aws elbv2 describe-target-health --target-group-arn <TG-ARN>
```

### デプロイがAWSプロファイル不足のエラーで失敗する

npmスクリプトは`${PROJECT}-${ENV}`（例: `your-project-dev`）という名前のAWS CLIプロファイルを前提としています。デプロイ前に`aws configure --profile your-project-dev`で作成してください。

### CloudFrontで5xxエラーが急増しているが、ALBやOrigin Group側の問題ではなさそう

**考えられる原因**: このスタック側の問題ではなく、VPC Origin接続自体に影響するCloudFront側のインシデント（2026年7月16日のAWS CloudFront VPC Origins障害など）。まず[AWS Health Dashboard](https://health.aws.amazon.com/health/status)を確認してください。

```bash
# alarmEmailを設定していれば、CloudfrontMonitoringStackのSNSトピック経由でも通知が届く
aws cloudwatch describe-alarms --alarm-names <project>-<env>-cloudfront-5xx-error-rate --region us-east-1
```

AWS側でVPC Origin接続の問題が確認された場合は、[インシデント対応の退避経路](#6-インシデント対応の退避経路publicalbfailover)（`publicAlbFailover.enabled: true`）を有効化してください。VPC Originの登録を残したまま`/alb/*`を迂回させ、すぐに元へ戻せる状態を保てます。

## クリーンアップ

```bash
export PROJECT=your-project
export ENV=dev
npm run destroy:all
```

> CloudFrontディストリビューションの削除には時間がかかります（削除前にディストリビューションを無効化し、その変更が完全に伝播する必要があるため）。`cdk destroy`の完了まで15〜30分程度かかる場合があります。

## まとめ

このパターンから学べること:

1. **VPC Origin**: パブリックIPやNATゲートウェイなしで、CloudFrontから完全に非公開のALBへ到達できる
2. **Origin Group**: サーバーエラー発生時に、動的オリジン（ALB）から静的オリジン（S3）へ自動的にフェイルオーバーできる
3. **Origin Access Control**: S3オリジンを非公開に保ちながら、CloudFront経由で配信できる
4. **エッジでの多層防御**: ジオ制限とCloudFront Functionにより、トラフィックがオリジンに到達する前にアクセス制御を追加できる
5. **標準ログv2**: CloudFront Functionのログデータを直接CloudWatch Logsに配信し、調査に活用できる
6. **手作業ではなくパラメータでのインシデント対応**: `publicAlbFailover`フラグにより、VPC Originの登録自体を削除することなく、劣化したVPC Origin接続を迂回できる
7. **CloudFrontのメトリクスはus-east-1にしか存在しない**: `5xxErrorRate`のようなディストリビューションレベルのメトリクスにアラームを張るには、オリジンがどのリージョンにあるかに関わらず、アラーム自体をus-east-1にデプロイする必要がある

## 参考リンク

- [Amazon CloudFront VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/vpc-origins.html)
- [Using origin groups for failover](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html)
- [Restricting access with Origin Access Control (OAC)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [CloudFront Functions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-functions.html)
- [CloudFront standard logging v2](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/standard-logging.html)
- [Restricting the geographic distribution of content](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/georestrictions.html)
- [Monitoring CloudFront distributions with CloudWatch metrics](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/monitoring-using-cloudwatch.html)
- [AWS Health Dashboard](https://health.aws.amazon.com/health/status) — CloudFront側のインシデントはまずここを確認
