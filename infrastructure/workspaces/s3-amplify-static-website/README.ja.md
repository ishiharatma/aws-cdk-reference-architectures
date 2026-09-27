# S3 + Amplify 静的ウェブサイトホスティング

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-200-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-S3%20%7C%20Amplify-orange?style=flat-square)

## はじめに

このアーキテクチャでは、**AWS Amplify Hosting** を使って静的ウェブサイトをホスティングする方法を示します。

CloudFront + S3 パターンとの主な違いは次のとおりです。

| 比較項目 | CloudFront + S3 | **S3 + Amplify Hosting** |
|----------|----------------|--------------------------|
| CDN | 自前で設定 | Amplify が管理 |
| デプロイ | `BucketDeployment` | zip を S3 経由でアップロード |
| カスタムドメイン | Route 53 + ACM が必要 | Amplify コンソールで設定可能 |
| ブランチプレビュー | なし | プルリクエストプレビュー対応 |

Amplify Hosting の **マニュアルデプロイモード**（Git リポジトリ接続なし）を使います。ウェブサイトのソースファイルは CDK アセットとして S3 にアップロードされ、`StartDeployment` API 経由で Amplify に取り込まれます。

## アーキテクチャ概要

```
┌───────────────────────────────────────────────────────────────┐
│  CDK デプロイ時                                                 │
│                                                                 │
│  1. CDK Asset → zip 作成 → CDK Bootstrap S3 バケット            │
│  2. AWS::Amplify::App + Branch 作成                             │
│  3. カスタムリソース (Lambda) → zipの署名付きGET URLを生成し、  │
│     それを sourceUrl として StartDeployment を呼出し            │
│                                                                 │
│  アクセス時                                                      │
│                                                                 │
│  ユーザー → Amplify Hosting CDN → 静的コンテンツ配信             │
└───────────────────────────────────────────────────────────────┘
```

**デプロイフロー:**

1. `cdk deploy` 実行
2. CDK がウェブサイトディレクトリを zip 圧縮し、CDK Bootstrap S3 バケットにアップロード（コンテンツハッシュ形式のキー）
3. CloudFormation が `AWS::Amplify::App` と `AWS::Amplify::Branch` を作成
4. カスタムリソース（小さなLambda関数 `AmplifyDeployHandler`）が zip の署名付きS3 GET URLを生成し、それを`sourceUrl`として`amplify:StartDeployment`を呼び出し
5. Amplify がその署名付きURLへの通常のHTTPS GETでzipを取得・展開し、管理CDN経由でコンテンツを配信

**コンテンツ更新時:**

ウェブサイトのファイルが変更されると CDK アセットのハッシュキーが変わり、カスタムリソースが署名するオブジェクトも変わります。次の `cdk deploy` で自動的に再デプロイが行われます。

## プロジェクトのディレクトリ構成

```text
s3-amplify-static-website/
├── bin/
│   └── s3-amplify-static-website.ts   # エントリーポイント
├── lib/
│   ├── stacks/
│   │   └── s3-amplify-static-website-stack.ts  # スタック定義
│   └── stages/
│       └── s3-amplify-static-website-stage.ts  # ステージ定義
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts
│   ├── snapshot/
│   │   └── snapshot.test.ts
│   └── unit/
│       └── s3-amplify-static-website.test.ts
├── cdk.json
├── package.json
└── tsconfig.json
```

## 主要リソースの説明

### CDK Asset (`s3_assets.Asset`)

```typescript
const websiteAsset = new s3_assets.Asset(this, 'WebsiteAsset', {
  path: path.join(__dirname, '../../../../../frontend/static-web'),
});
```

CDK がウェブサイトディレクトリを zip 圧縮し、CDK Bootstrap バケットにアップロードします。キーはコンテンツの SHA-256 ハッシュであるため、ファイルが変わると自動的に新しいキーが生成されます。

### Amplify App

```typescript
this.amplifyApp = new amplify.CfnApp(this, 'AmplifyApp', {
  name: `${props.project}-${props.environment}-website`,
  platform: 'WEB',
});
```

`iamServiceRole` は指定していません。このデザインでは Amplify が zip 取得のためにロールを引き受けることはなく（詳細は後述の[デプロイ用カスタムリソース](#デプロイ用カスタムリソース)を参照）、このサンプルでは Amplify が他の AWS サービスを代行呼び出しする必要もないためです。

`platform: 'WEB'` は静的ウェブサイト（マネージド CDN）を意味します。`repository` や `accessToken` を指定しないことで **マニュアルデプロイモード** になります。

### Amplify Branch

```typescript
this.amplifyBranch = new amplify.CfnBranch(this, 'AmplifyBranch', {
  appId: this.amplifyApp.attrAppId,
  branchName: 'main',
  enableAutoBuild: false,
  enablePullRequestPreview: false,
});
```

`enableAutoBuild: false` により、Git push による自動ビルドを無効化します。デプロイはカスタムリソース経由のみで行われます。

### デプロイ用カスタムリソース

```typescript
const deployHandler = new lambdaNodejs.NodejsFunction(this, 'AmplifyDeployHandler', {
  runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64,
  handler: 'handler',
  entry: path.join(__dirname, '../../src/lambda/amplify-deploy/index.ts'),
  timeout: cdk.Duration.seconds(60),
  bundling: { minify: true, sourceMap: true, target: 'node22' },
});
websiteAsset.grantRead(deployHandler);
deployHandler.addToRolePolicy(
  new iam.PolicyStatement({ actions: ['amplify:StartDeployment'], resources: ['*'] }),
);

const deployProvider = new cr.Provider(this, 'AmplifyDeployProvider', {
  onEventHandler: deployHandler,
});

new cdk.CustomResource(this, 'AmplifyDeployment', {
  serviceToken: deployProvider.serviceToken,
  properties: {
    AppId: this.amplifyApp.attrAppId,
    BranchName: branchName,
    BucketName: websiteAsset.s3BucketName,
    ObjectKey: websiteAsset.s3ObjectKey,
  },
});
```

`amplify:StartDeployment` に `s3://` URL をそのまま渡す方式は、`amplify.amazonaws.com` への読み取り権限を許可する**バケットポリシー**が必要です（[Amplify公式ドキュメント](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-with-sdks.html)参照)。しかし zip はこのスタックが所有していない共有の CDK Bootstrap バケットに置かれているため、そのポリシーを付与できません。そこで `AmplifyDeployHandler`（自前の Lambda、[`cr.Provider`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.custom_resources.Provider.html)でラップ）が自身の`s3:GetObject`権限を使って zip の短命な署名付きHTTPS GET URLを生成し、それを使って`amplify:StartDeployment`を呼び出します。Amplify 側は単なるHTTP GETを実行するだけなので、バケットポリシーも`iamServiceRole`も一切不要になります。作成時・更新時の両方で実行されます(コンテンツが変わればアセットキーも変わるため、自動的に新しいデプロイがトリガーされます)。よりシンプルな`cr.AwsCustomResource`を使った最初の実装からこの方式に置き換えた経緯は[実機デプロイ検証](#実機デプロイ検証)を参照してください。

## 前提条件

- AWS CLI v2 がインストール・設定済み
- Node.js 20 以上
- AWS CDK CLI (`npm install -g aws-cdk`)
- CDK Bootstrap 済み（`cdk bootstrap`）
- TypeScript の基礎知識

## デプロイ

```bash
# 差分確認
npm run diff -- --project=sample --env=dev

# デプロイ（約 5〜10 分）
npm run deploy:all -- --project=sample --env=dev
```

デプロイ完了後、出力される `AmplifyAppUrl` にアクセスしてウェブサイトを確認してください。

### コンテンツの更新

`frontend/static-web/` 配下のファイルを編集し、再度 `cdk deploy` を実行するだけです。CDK アセットのハッシュが変わり、自動的に Amplify に再デプロイされます。

```bash
# コンテンツ変更後の再デプロイ
npm run deploy:all -- --project=sample --env=dev
```

## クリーンアップ

```bash
npm run destroy:all -- --project=sample --env=dev
```

> **注意**: Amplify Hosting はデプロイしたコンテンツをホスト側で管理します。スタックを削除すると Amplify App ごと削除されます。

## 実機デプロイ検証

2026-09-27に実際のアカウント(`ap-northeast-1`)へデプロイし、確認したうえでスタックを削除しました。このデプロイで、単なる注意点としてではなく実際に修正した不具合が2つ見つかりました:

1. **`s3:GetObjectAcl` / `s3:PutObjectAcl` の `AccessDenied`、それを解消した後にAmplify自身が返す`"The bucket policy is either missing or has insufficient permissions"`。** 元の実装は`sourceUrl: s3://<bootstrap-bucket>/<key>`をそのまま`amplify:StartDeployment`に渡していました。この経路は、`amplify.amazonaws.com`への読み取りを許可する**バケットポリシー**をS3バケット側に用意することを要求します([Amplify公式ガイド](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-with-sdks.html)に明記)。しかし zip は共有の CDK Bootstrap バケット(`cdk-hnb659fds-assets-<account>-<region>`)にあり、このスタックはそれを所有していません。`websiteAsset.bucket`は内部的に`Bucket.fromBucketAttributes`によるインポート済み`IBucket`であるため、`addToResourcePolicy`を呼んでも静かに何も起きず、スタック内からこの要件を満たす方法がありませんでした。**修正**: `s3://` URLを直接渡す代わりに、小さなLambda(`AmplifyDeployHandler`)がデプロイ時に自身の`s3:GetObject`権限を使って署名付きHTTPS GET URLを生成するようにしました。Amplifyは単なるHTTP GETを実行するだけになり、バケットポリシーも`iamServiceRole`も一切不要になります。この不具合は`cdk synth`・unitテスト・cdk-nagのいずれでも検出できず、実際の`StartDeployment`呼び出しでしか見つかりませんでした。
2. `cr.AwsCustomResource`(汎用SDK呼び出し用カスタムリソース)は署名付きURLを生成できません — その`parameters`は synth 時点で固定されるJSONだからです。そのため、実際のLambdaを使う`cr.Provider` + `CustomResource`への切り替えが必要になり、上記の図やコード例が典型的な`AwsCustomResource`の一行呼び出しと異なる形になっています。

実際に確認した内容:

- `cdk deploy '**'`は2回目の試行でクリーンにスタックを作成できました(1回目の試行が残した`ROLLBACK_COMPLETE`状態は、次の`cdk deploy`が自動的に削除して対処しました)。
- `aws amplify list-jobs`でデプロイジョブのステータスが`SUCCEED`であることを確認。
- `curl https://main.<app-id>.amplifyapp.com/`が実際に`HTTP 200`を返し、`frontend/static-web/index.html`の実コンテンツが返ってくることを確認 — 「スタックが`CREATE_COMPLETE`になった」だけでは終わらせていません。
- 検証後にスタックを削除し、`aws cloudformation describe-stacks`で完全に消えたことを確認しました。

今回のパスで確認していない範囲: コンテンツ更新(アセットハッシュの変化によるAmplifyの再デプロイトリガー)、デフォルトの`main`以外の`branchName`。

## CloudFront + S3 パターンとの使い分け

| ユースケース | 推奨パターン |
|-------------|-------------|
| 完全なカスタマイズ（WAF、地理制限など） | CloudFront + S3 |
| 手軽な静的サイト公開 | **S3 + Amplify Hosting** |
| Git 連携による自動デプロイ | Amplify Hosting (Git モード) |
| バックエンド API との統合 | CloudFront + VPC Origin |

## 参考リンク

- [AWS Amplify Hosting ドキュメント](https://docs.aws.amazon.com/amplify/latest/userguide/welcome.html)
- [Amplify StartDeployment API](https://docs.aws.amazon.com/amplify/latest/APIReference/API_StartDeployment.html)
- [CDK aws-amplify モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_amplify-readme.html)
- [CDK s3-assets モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3_assets-readme.html)
