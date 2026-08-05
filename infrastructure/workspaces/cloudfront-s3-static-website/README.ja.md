# CloudFront S3 Static Website — OAC・クロスリージョンWAF・セキュリティヘッダーを備えた非公開S3オリジン

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-200-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-CloudFront%20%7C%20S3%20%7C%20WAF-orange?style=flat-square)

## はじめに

これは、**Amazon CloudFront**経由でHTTPS配信される静的サイトのリファレンス実装です。背後には**Origin Access Control (OAC)**経由でのみ到達可能な、完全に非公開のS3バケットを配置しています。このリポジトリのよりシンプルな[`s3-static-web-site`](../s3-static-web-site/)パターンを、HTTPS/CDN対応へと発展させたものです。

このアーキテクチャは以下を示します:

- 非公開のS3バケット(ウェブサイトホスティングなし、パブリックアクセスなし)をOrigin Access Control経由でCloudFrontから配信
- Content-Security-Policyなどのセキュリティヘッダーを追加し、`Server`レスポンスヘッダーを隠す`ResponseHeadersPolicy`
- SPAに配慮したルーティング: S3からの`403`/`404`レスポンスは`index.html`+`200`へ書き換え、実際の`5xx`(オリジン/エッジの本物の障害)は元のステータスコードを維持したまま専用のエラーページを表示
- 任意のWAFv2 Web ACL — CLOUDFRONTスコープのWeb ACLはus-east-1でしか作成できないため、独自の**クロスリージョン(us-east-1)**スタックとしてデプロイ。管理ルールグループの評価前/評価後いずれかを選べるIP許可リスト付き
- `redactedFields`で`authorization`/`cookie`ヘッダーをマスクした、WAFからS3への直接ログ配信
- 2文字国コードによる許可リスト形式のジオ制限、およびビューアーに対する最小プロトコルとしてのTLS 1.3(2025)

### なぜこのパターンなのか?

| 特徴 | メリット |
| ---- | -------- |
| 非公開バケット + OAC | S3ウェブサイトホスティングとは異なり、バケット自体が一切パブリックに到達不能。読み取れるのはCloudFrontディストリビューションのOAC ID経由のみで、S3 Block Public Accessも常に完全に有効なまま |
| クロスリージョンWAFスタック | Web ACLと、それが必要とするIPセット/ロギングリソースは、us-east-1に固定されたスタックへ分離し、そのARNを`crossRegionReferences: true`経由でメインスタックへ渡す — 別リージョンにデプロイされたディストリビューションと組み合わせてCLOUDFRONTスコープのWAFv2リソースが必要な場合に再利用できるパターン |
| 本物の障害を隠さないSPA向けエラーマッピング | `403`/`404`(オブジェクト未存在・非公開アクセス拒否)はSPAの`index.html`へ書き換える一方、`500`〜`504`(オリジン/エッジの本物のエラー)は元のステータスコードを維持し、生のエラー本文の代わりに専用のわかりやすいページを表示する |
| `approvalTopicArn`的な単一フラグでの切り替え | `enableWaf`と`geoRestrictionCountries`はそれぞれ単一の任意パラメータ — 省略すれば対応するリソース/制限自体が作成されない |

## アーキテクチャ概要

![overview](overview.drawio.svg)

### 主要コンポーネント

| コンポーネント | 設計のポイント |
| -------------- | -------------- |
| `WebsiteBucket` | `createAccountRegionalBucket`(ウェブサイトホスティング版ではない) — 完全に非公開、`blockPublicAccess: BLOCK_ALL`、`enforceSSL: true`。読み取れるのはOAC経由のディストリビューションのみ |
| `AccessLogBucket` | S3サーバーアクセスログとCloudFrontアクセスログの両方を受け取る。`accessControl: LOG_DELIVERY_WRITE` + `objectOwnership: BUCKET_OWNER_PREFERRED`はいずれも、CloudFrontのログ配信サービス(`awslogsdelivery`)が書き込むために必須 |
| `ResponseHeadersPolicy` | CSP(`default-src 'self'`、インラインスクリプト/スタイル禁止)、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、HSTS(1年、includeSubDomains、preload)、`X-Content-Type-Options`、および空値での`Server`ヘッダー上書き |
| `WebsiteDistribution` | `PriceClass.PRICE_CLASS_100`、最小プロトコル`TLS_V1_3_2025`、`S3BucketOrigin.withOriginAccessControl`、`CACHING_OPTIMIZED`キャッシュポリシー、任意の`webAclId`/`geoRestriction` |
| `CloudfrontWafStack`(us-east-1) | 任意(`enableWaf`)。AWSマネージドルールグループ5つ + 評価前/評価後のIP許可リストを持つWAFv2 Web ACL。S3への直接ログ配信付き |
| `WafLogBucket`(`CloudfrontWafStack`内) | 必須の`aws-waf-logs-`プレフィックスで始まるバケット名。`authorization`/`cookie`ヘッダーをマスクした上でWAFログを受け取る |

## データフロー

```text
ビューアー
  │  HTTPS(最小TLS 1.3)、任意でジオ制限
  ▼
CloudFrontディストリビューション
  ├─ WAFv2 Web ACL(任意、us-east-1): 管理ルールグループ + IP許可リスト → デフォルトアクション: block
  ├─ ResponseHeadersPolicy: すべてのレスポンスにCSP + セキュリティヘッダーを適用
  ├─ デフォルトビヘイビア "/*"
  │     └─ S3オリジン(OAC) ───────────────────► WebsiteBucket(非公開)
  │
  └─ エラーハンドリング
        ├─ 403 / 404  → /index.html、HTTP 200(SPAのクライアントサイドルーティング)、TTL 5分
        └─ 500-504    → /error.html、元のステータスコードを維持、TTL 1分
```

## 実装のポイント

### 1. OAC経由でのみ到達可能な、完全に非公開のオリジン

`WebsiteBucket`は、このリポジトリの他のウェブサイト以外のバケットと同じ`createAccountRegionalBucket`ヘルパーを使用しています——`enforceSSL: true`、`blockPublicAccess: BLOCK_ALL`で、ウェブサイトホスティング設定は一切ありません。唯一の読み取り主体はCloudFrontディストリビューション自身で、`S3BucketOrigin.withOriginAccessControl`がOACとディストリビューションのARNにスコープされたバケットポリシーステートメントを自動的に用意します。

```typescript
const distribution = new cloudfront.Distribution(this, 'WebsiteDistribution', {
  defaultBehavior: {
    origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    // ...
  },
});
```

[`s3-static-web-site`](../s3-static-web-site/)ではバケットがウェブサイトホスティング用に設定され(条件付きで)パブリックであるのと対照的です——この2つのワークスペースは、「このバケットを誰が読み取れるか」というスペクトラムの両端を意図的に示しています。

### 2. レスポンスヘッダーポリシー: CSP、HSTS、`Server`ヘッダーの隠蔽

すべてのレスポンスに、厳格な`Content-Security-Policy`(`default-src 'self'`、`'unsafe-inline'`なし)、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`preload`付きの1年間HSTSヘッダーが付与され、`Server`レスポンスヘッダーは明示的に空値で上書きされます:

```typescript
customHeadersBehavior: {
  customHeaders: [
    { header: 'server', value: '', override: true }, // セキュリティ上の理由からサーバー情報を隠す
  ],
},
```

### 3. 本物の障害は隠さない、SPA向けエラーマッピング

S3からの`403`/`404`(オブジェクト未存在、またはCloudFront以外からのリクエストをOACが拒否した場合)は`index.html`+`200`に書き換えられます——これにより、S3オブジェクトとして存在しないパスへユーザーが直接リンクした場合でも、クライアントサイドルーティング(React Routerなど)が機能します。一方、本物の`5xx`エラーは異なる扱いです——元のステータスコードを維持したまま、生のCloudFrontエラーページの代わりに`error.html`を表示するため、運用担当者/モニタリング側は実際の障害を引き続き把握できます:

```typescript
errorResponses: [
  { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
  { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
  // 5xxはSPAルーティングではなく本物のオリジン/エッジ障害なので、元のステータスコードを維持し、
  // オリジンのエラー詳細を漏らさないよう、わかりやすいページに本文だけ差し替える。
  ...[500, 502, 503, 504].map((httpStatus) => ({
    httpStatus, responseHttpStatus: httpStatus, responsePagePath: '/error.html', ttl: cdk.Duration.minutes(1),
  })),
],
```

### 4. us-east-1に固定されたWAFv2を`crossRegionReferences`で配線する

`scope: 'CLOUDFRONT'`のWeb ACL(およびそれが参照するIPセット)は、ディストリビューションやアプリの他の部分がどのリージョンにデプロイされているかに関わらず、us-east-1でしか作成できません。そのため`CloudfrontWafStack`は独立したスタックとして常に`env: { region: 'us-east-1' }`でデプロイされ、その`webAclArn`出力は両方のスタックに設定した`crossRegionReferences: true`を使ってリージョンをまたいでメインスタックへ渡されます:

```typescript
const wafStack = new CloudfrontWafStack(this, pascalCase(`${props.project}Waf`), {
  env: { account: props.params.accountId, region: 'us-east-1' },
  crossRegionReferences: true,
  enableWaf: props.params.enableWaf,
  allowedIpsAfterRules: props.allowedIps,
});

const mainStack = new CloudfrontS3StaticWebsiteStack(this, pascalCase(`${props.project}Main`), {
  webAclArn: wafStack.webAclArn,
  crossRegionReferences: true,
});
mainStack.addDependency(wafStack);
```

`enableWaf`が`false`(または未指定)の場合でも`CloudfrontWafStack`自体はデプロイされます(出力を解決可能な状態に保つため)が、Web ACLは一切作成されず、`webAclArn`は空文字列に解決され、ディストリビューションは`webAclId`なしになります。

### 5. 管理ルールグループの評価前・評価後、どちらでも選べるIP許可リスト

Web ACLの`defaultAction`は`block`のため、何らかのトラフィックを通過させるには明示的な`Allow`ルールが必須です。2つの独立した許可リストルールをサポートしています:

- **`AllowSpecificIPsBeforeRules`**(優先度1、設定時のみ作成): 管理ルールグループを完全にバイパスします——Core/KnownBadInputs/AdminProtection/IpReputation/AnonymousIpの各管理ルールセットによる評価を受けるべきでない、信頼済みの内部IPなどに有用です。
- **`AllowSpecificIPsAfterRules`**(優先度100、常に作成): 管理ルールグループの**後**に評価されます。`allowedIpsAfterRules`と`allowedIpv6sAfterRules`のどちらも未指定の場合、このルールはデフォルトでIPv4・IPv6アドレス空間全体を許可します(WAFが`/0`のCIDRを拒否するため、それぞれ2つの`/1`CIDRブロックに分割)——つまり「制限はしないが、管理ルールは引き続き実行する」状態になります。

```typescript
addresses: props.allowedIpsAfterRules
  ? props.allowedIpsAfterRules.map(ip => `${ip}/32`)
  : ['0.0.0.0/1', '128.0.0.0/1'], // IPv4全範囲。WAFが/0を拒否するため分割
```

### 6. WAFログをS3へ直接配信し、機微なヘッダーをマスク

WAFのS3への直接ログ配信には、配信先バケット名が`aws-waf-logs-`で始まること、そして`delivery.logs.amazonaws.com`に対してスコープされた`PutObject`/`GetBucketAcl`権限を付与する特定のバケットポリシー形式が必要です。`authorization`・`cookie`ヘッダーは、ログに到達する前にマスクされます:

```typescript
redactedFields: [
  { singleHeader: { Name: 'authorization' } },
  { singleHeader: { Name: 'cookie' } },
],
```

## デプロイガイド

### 1. クローンとセットアップ

```bash
git clone <this-repository>
cd infrastructure
npm install
```

### 2. 環境パラメータの設定

[`parameters/dev-params.ts`](./parameters/dev-params.ts)を編集:

```typescript
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  enableWaf: true,                        // 省略/falseでWeb ACL自体を作成しない
  geoRestrictionCountries: ['JP'],        // 省略/空配列で全国を許可
};
```

### 3. デプロイ

```bash
export PROJECT=your-project
export ENV=dev

npm run bootstrap   # 初回のみ
npm run diff
npm run stage:deploy:all
```

### WAFの許可IP(v4/v6)

このワークスペースのCloudFrontディストリビューションにはWAFv2 Web ACLが付与されており、デフォルトでは`cdk deploy`を実行したマシン自身のグローバルIPだけが管理ルール適用後の許可リストに載ります(`bin/cloudfront-s3-static-website.ts`が`curl`でIPを自動検出)。IPv6は`curl -6`で取得を試み、取得できない環境(IPv6接続のないdevcontainer/CI等)では自動的にスキップされ、IPv4のみが許可リストに入ります。

自動検出ではなく、任意のIP(例: 実際にブラウザを開いている端末のIP)を明示的に許可したい場合は、環境変数`ALLOWED_IPS`/`ALLOWED_IPV6S`で上書きできます(カンマ区切りで複数指定可)。指定した場合は自動検出の`curl`呼び出し自体がスキップされます。

```bash
ALLOWED_IPS=203.0.113.10,203.0.113.20 \
ALLOWED_IPV6S=2001:db8::1 \
npm run stage:deploy:all
```

いずれのIPアドレスも指定・検出されなかった場合(両方とも未指定)は、WAFのIP制限自体が「全許可」になります(管理ルールグループによる評価は引き続き適用されます)。

### 4. デプロイの確認

```bash
aws cloudformation describe-stacks \
  --stack-name <ProjectName>Main \
  --query 'Stacks[0].Outputs'
```

```bash
curl https://<出力されたWebsiteDistributionDomainName>/
```

## 使用方法

スタック出力の`WebsiteDistributionUrl`をブラウザで開きます。`enableWaf: true`かつ自分のIPが許可リストにない場合、または自分の国が`geoRestrictionCountries`に含まれない場合、CloudFront/WAFはリクエストがオリジンへ到達する前に拒否します。

## テスト

```bash
npm test -w workspaces/cloudfront-s3-static-website              # すべてのテスト
npm run test:unit -w workspaces/cloudfront-s3-static-website      # ユニットテスト
npm run test:snapshot -w workspaces/cloudfront-s3-static-website  # スナップショットテスト
npm run test:compliance -w workspaces/cloudfront-s3-static-website # cdk-nagチェック
```

- [`test/unit/cloudfront-waf-stack.test.ts`](./test/unit/cloudfront-waf-stack.test.ts)には、Web ACLとそのルール優先度/アクション、評価前/評価後の許可リストの挙動、WAFログ配信(バケット命名、マスク、ポリシーの順序)に対するきめ細かいアサーションがあります。
- [`test/compliance/cdk-nag.test.ts`](./test/compliance/cdk-nag.test.ts)は、`CloudfrontWafStack`と`CloudfrontS3StaticWebsiteStack`の両方に対して`AwsSolutionsChecks`を実行し、リソース単位で抑制を適用しています(例: `AwsSolutions-CFR4` — カスタムドメイン/ACM証明書を設定していないため、デフォルトのCloudFront証明書は`minimumProtocolVersion`の設定に関わらずTLSv1に固定される)。
- `test/unit/cloudfront-s3-static-website.test.ts`は、プロジェクトテンプレートが未実装のまま残っており、現状`CloudfrontS3StaticWebsiteStack`に対するアサーションは行いません。実質的にこのスタックを検証しているのは、上記のスナップショットテストとコンプライアンステストです。

## カスタマイズ

### 許可する国を増減する

```typescript
// parameters/dev-params.ts
geoRestrictionCountries: ['JP', 'US'],
```

### WAFを完全に無効化する

```typescript
// parameters/dev-params.ts
enableWaf: false,
```

### 管理ルール適用前にトラフィックを許可する

```typescript
// lib/stages/cloudfront-s3-static-website-stage.ts
allowedIpsBeforeRules: props.allowedIps, // 現状はステージ内でコメントアウトされている
```

### カスタムドメインの追加

このスタックは現状、CloudFrontのデフォルトドメイン(`*.cloudfront.net`)からトラフィックを配信しています——これが`AwsSolutions-CFR4`を修正ではなく抑制している理由でもあります。カスタムドメインを追加するには、(us-east-1の)ACM証明書を用意し、`Distribution`コンストラクトに`domainNames`/`certificate`のペアを指定した上で、Route 53のエイリアスレコードを追加してください。

## コスト最適化

### 推定月額コスト(ap-northeast-1、低トラフィック)

```
CloudFront(低リクエスト量、最小限のデータ転送)              ≈ $1〜2
AWS WAF(Web ACL + ルール6つ、低リクエスト量)                 ≈ $8.00
S3(2バケット、数MBのコンテンツ + アクセス/WAFログ)           < $0.10
-------------------------------------------------------------------
合計(WAF有効時)                                             ≈ $9〜10/月
合計(enableWaf: false)                                      ≈ $1〜2/月
```

> WAFはWeb ACL単位・ルール単位・評価したリクエスト単位で課金されるため、低トラフィック時の主要なコスト要因になります。IP/ジオ制限が不要な純粋なデモデプロイでは`enableWaf: false`を設定してください。

## セキュリティの考慮事項

- ✅ `WebsiteBucket`は一切パブリックに到達不能——`blockPublicAccess: BLOCK_ALL`とOACの組み合わせにより、特定のCloudFrontディストリビューションのみが読み取り可能
- ✅ ビューアーから受け付ける最小プロトコルバージョンはTLS 1.3(2025)
- ✅ オリジンの挙動に関わらず、すべてのレスポンスに`ResponseHeadersPolicy`経由で厳格なCSPとセキュリティヘッダー(HSTS、`X-Frame-Options: DENY`、`X-Content-Type-Options`)を適用
- ✅ AWSマネージドルールグループ(Common、KnownBadInputs、AdminProtection、IP Reputation、Anonymous IP)がIP許可リストより先に評価される、任意のWAFv2 Web ACL
- ✅ WAFログは、ログバケットに到達する前に`authorization`/`cookie`ヘッダーをマスク
- ⚠️ カスタムドメイン/ACM証明書が設定されていないため、`AwsSolutions-CFR4`は修正ではなく抑制されている——SNIなしクライアント向けのディストリビューションのデフォルト証明書は、`minimumProtocolVersion`の設定に関わらずTLSv1に固定される。本番環境ではACM証明書付きのカスタムドメインを付与してこのギャップを解消すること
- ⚠️ ジオ制限はデフォルトで無効(`AwsSolutions-CFR1`を抑制)——サイトを特定の国からのみアクセス可能にしたい場合は`geoRestrictionCountries`を設定すること

## トラブルシューティング

### 問題: クロスリージョン参照エラーでデプロイが失敗する

**症状**: `crossRegionReferences`に関するエラー、または`CloudfrontWafStack`由来の未解決トークンに関するエラー。

**解決策**:
1. `CloudfrontWafStack`と`CloudfrontS3StaticWebsiteStack`の**両方**に`crossRegionReferences: true`が設定されているか確認する([`lib/stages/cloudfront-s3-static-website-stage.ts`](./lib/stages/cloudfront-s3-static-website-stage.ts)を参照)
2. クロスリージョン参照にはCDKブートストラップスタック側の対応が必要——対象アカウント/リージョンが古いバージョンのCDKでブートストラップされている場合は、`npm run bootstrap`を再実行する

### 問題: `WebACL`の作成が「The scope is not valid」で失敗する

**症状**: `CloudfrontWafStack`のデプロイが、このWAFv2のエラーで失敗する。

**解決策**:
1. スタックの`env.region`が`us-east-1`になっているか確認する——`scope: 'CLOUDFRONT'`のWeb ACLは、CloudFrontディストリビューションやアプリの他の部分がどこにあるかに関わらず、us-east-1でしか作成できない

### 問題: サイトを開くとWAFから`403`が返る

**症状**: CloudFront自体のエラーページに到達する前に、ブラウザが汎用的な`403 Forbidden`を受け取る。

**解決策**:
1. 現在のIPが評価後の許可リストに含まれているか確認する——上記の[WAFの許可IP](#wafの許可ipv4v6)を参照
2. リクエストの送信元国が`geoRestrictionCountries`に含まれていないか確認する

## クリーンアップ

```bash
export PROJECT=your-project
export ENV=dev
npm run stage:destroy:all
```

> CloudFrontディストリビューションの削除には時間がかかります(削除前にディストリビューションを無効化し、その変更が完全に伝播するのを待つ必要があるため)。`cdk destroy`の完了に数分かかることがあります。

## 参考資料

### AWSドキュメント
- [OACでAmazon S3オリジンへのアクセスを制限する](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [レスポンスヘッダーポリシーの追加](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/response-headers-policies.html)
- [AWS WAF デベロッパーガイド](https://docs.aws.amazon.com/waf/latest/developerguide/waf-chapter.html)
- [コンテンツの地理的な配信を制限する](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/georestrictions.html)

### AWS CDK
- [aws-cloudfront-origins モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront_origins-readme.html)
- [CDKにおけるクロスリージョン参照](https://docs.aws.amazon.com/cdk/v2/guide/environments.html)
- [CDK Nag](https://github.com/cdklabs/cdk-nag)

### 関連アーキテクチャ
- [`s3-static-web-site`](../s3-static-web-site/) — CloudFront/WAFを使わない、同じサイトのプレーンなS3ウェブサイトホスティング版
- [`cicd-cloudfront-s3`](../cicd-cloudfront-s3/) — このワークスペースのバケット/ディストリビューションへコンテンツをデプロイするCI/CDパイプライン
- [`cloudfront-vpc-origin`](../cloudfront-vpc-origin/) — S3オリジンに加えて内部ALBへのVPC Originを追加する、より高度なCloudFrontパターン

## 📄 ライセンス

このプロジェクトはMITライセンスの下でライセンスされています - 詳細は [LICENSE](../../../LICENSE) ファイルを参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します! 詳細は [CONTRIBUTING.md](../../../docs/contribution/CONTRIBUTING.md) をご覧ください。

## 🏆 このリファレンスアーキテクチャについて

このリファレンスアーキテクチャは、完全に非公開のS3オリジン、クロスリージョンのWAFリソース、多層防御のセキュリティヘッダーを備えたCloudFront経由の静的サイト配信について、AWS CDKのベストプラクティスを示しています。

**対象レベル**: 200(中級)

---

**注意**: これはリファレンス実装です。本番環境にデプロイする前に、必ず特定の要件および組織のポリシーに従ってレビューおよびカスタマイズしてください。
