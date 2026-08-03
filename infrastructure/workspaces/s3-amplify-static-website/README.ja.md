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
┌─────────────────────────────────────────────────────────┐
│  CDK デプロイ時                                          │
│                                                         │
│  1. CDK Asset → zip 作成 → CDK Bootstrap S3 バケット   │
│  2. Amplify サービスロール → S3 読み取り権限付与        │
│  3. AWS::Amplify::App + Branch 作成                     │
│  4. カスタムリソース (Lambda) → StartDeployment 呼出し  │
│     sourceUrl = s3://<bootstrap-bucket>/<hash>.zip      │
│                                                         │
│  アクセス時                                              │
│                                                         │
│  ユーザー → Amplify Hosting CDN → 静的コンテンツ配信    │
└─────────────────────────────────────────────────────────┘
```

**デプロイフロー:**

1. `cdk deploy` 実行
2. CDK がウェブサイトディレクトリを zip 圧縮し、CDK Bootstrap S3 バケットにアップロード（コンテンツハッシュ形式のキー）
3. Amplify サービスロールが zip を読み取れるよう IAM 権限を付与
4. CloudFormation が `AWS::Amplify::App` と `AWS::Amplify::Branch` を作成
5. カスタムリソース（Lambda）が `amplify:StartDeployment` を呼び出し
6. Amplify が zip を取得・展開し、管理 CDN 経由でコンテンツを配信

**コンテンツ更新時:**

ウェブサイトのファイルが変更されると CDK アセットのハッシュキーが変わり、`sourceUrl` が更新されます。次の `cdk deploy` で自動的に再デプロイが行われます。

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

### Amplify サービスロール

```typescript
const amplifyServiceRole = new iam.Role(this, 'AmplifyServiceRole', {
  assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
});
websiteAsset.grantRead(amplifyServiceRole);
```

Amplify が `StartDeployment` 実行時に S3 から zip を取得するために使用するロールです。

### Amplify App

```typescript
this.amplifyApp = new amplify.CfnApp(this, 'AmplifyApp', {
  name: `${props.project}-${props.environment}-website`,
  platform: 'WEB',
  iamServiceRole: amplifyServiceRole.roleArn,
});
```

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
const deployAction = {
  service: 'Amplify',
  action: 'startDeployment',
  parameters: {
    appId: this.amplifyApp.attrAppId,
    branchName,
    sourceUrl: `s3://${websiteAsset.s3BucketName}/${websiteAsset.s3ObjectKey}`,
    sourceUrlType: 'ZIP',
  },
  physicalResourceId: cr.PhysicalResourceId.of(
    `${props.project}-${props.environment}-amplify-deploy`,
  ),
};

new cr.AwsCustomResource(this, 'AmplifyDeployment', {
  onCreate: deployAction,
  onUpdate: deployAction,  // sourceUrl が変わったとき自動的に再デプロイ
  policy: cr.AwsCustomResourcePolicy.fromStatements([
    new iam.PolicyStatement({
      actions: ['amplify:StartDeployment'],
      resources: ['*'],
    }),
  ]),
});
```

`AwsCustomResource` は CloudFormation カスタムリソースとして動作し、スタック作成時（`onCreate`）とプロパティ変更時（`onUpdate`）に `amplify:StartDeployment` を呼び出します。

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
