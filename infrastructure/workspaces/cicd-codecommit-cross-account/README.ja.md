# CICD-CodeCommit-Cross-Account — 単一CodeCommitリポジトリからのクロスアカウントCI/CDパイプライン

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## はじめに

AWS CodePipelineとCodeBuildだけで構成された、**クロスアカウントCI/CDパイプライン**のリファレンス実装です。開発(dev)アカウントに1つだけ作成したCodeCommitリポジトリを起点に、3つの独立したAWSアカウント(dev / stg / prd)へデプロイします。

このアーキテクチャで示す内容:

- 開発アカウントに作成する単一のCodeCommitリポジトリと、同じ初回コミットから自動作成される3つのブランチ(`develop` / `staging` / `main`)
- ブランチごとに独立した3本のCodePipeline。それぞれ `Source → Test → Build → (任意でApprove) → Deploy` を実行し、リポジトリ内の `buildspec-test.yml` / `buildspec-build.yml` / `buildspec-deploy.yml` で駆動する
- クロスアカウントの橋渡しは、DeployステージのCodeBuildプロジェクト内で行う素の `sts:AssumeRole` のみで実現。CDK Pipelinesは使わず、クロスアカウントのbootstrap trust設定も不要
- 環境ごとに固定名のIAMロールを、**対象アカウントへ個別にデプロイする別スタック**として用意し、そのアカウント用のDeploy CodeBuildロールのARNのみを信頼する
- 環境ごとの設定は `dev-params` / `stg-params` / `prd-params`、環境非依存の値は `shared-params` として定義。ただしCodeCommitアカウントIDだけは、公開リポジトリであるため意図的にハードコードせず環境変数から渡す

### この設計を選ぶ理由

| 特徴 | メリット |
| ------- | ------- |
| パイプラインはdevアカウントに集約 | クロスアカウントを跨ぐのはDeploy CodeBuildプロジェクトの`AssumeRole`のみ。CodeCommit・CodePipeline・Test/Buildは全て同一アカウント内で完結し、IAMやネットワークがシンプルになる |
| 固定名のIAMロール | devアカウント側のDeploy CodeBuildロールと、対象アカウント側のCrossAccountDeployRoleを決定的な名前にすることで、信頼関係を単純なARN文字列として表現できる。アカウントをまたぐクロススタック参照は不要 |
| ターゲットアカウントごとに1スタック | `CrossAccountRoleStack`は各アカウント(dev/stg/prd)へ、それぞれのアカウント自身のCLIプロファイルに対して個別にデプロイする。dev(自己信頼)とstg/prd(真のクロスアカウント)を同じコードパスで扱える |
| ブランチの自動作成 | `develop`/`staging`はCustom Resourceによって`main`の初回コミットから作成されるため、`cdk deploy`一回で3ブランチとも即座にpush可能な状態になる |

## アーキテクチャ概要

![Architecture Overview](overview.drawio.svg)

### 主要コンポーネント

| コンポーネント | 設計のポイント |
| --------- | ------------- |
| CodeCommitリポジトリ(devアカウント) | 本スタックが作成し、`sample-app/`を`main`ブランチへ初期投入。`develop`/`staging`は同じコミットから`AwsCustomResource`で作成 |
| CodePipeline x3(devアカウント) | `<project>-dev-pipeline`、`<project>-stg-pipeline`、`<project>-prd-pipeline`。それぞれ対応するブランチをソースとする |
| Test / Build CodeBuildプロジェクト | リポジトリ内の`buildspec-test.yml` / `buildspec-build.yml`を実行。同一アカウント内で完結し特別なIAMは不要 |
| Deploy CodeBuildプロジェクト | `buildspec-deploy.yml`を実行。IAMロール名は固定(`<project>-<env>-deploy-build-role`)で、対象環境のクロスアカウントロールへの`sts:AssumeRole`権限のみを付与 |
| CrossAccountRoleStack(dev/stg/prdアカウント) | 各ターゲットアカウントへ個別にデプロイ。`<project>-<env>-cross-account-deploy-role`を作成し、対応するDeploy CodeBuildロールのARNのみを信頼する |

### データフロー

```text
devアカウント
├── CodeCommitリポジトリ (develop / staging / main ブランチ)
│
├── <project>-dev-pipeline   (Source: develop) ─┐
├── <project>-stg-pipeline   (Source: staging)  ├─ Source → Test → Build → [Approve] → Deploy
└── <project>-prd-pipeline   (Source: main)     ┘
                                                    │
                                    Deploy CodeBuildロール (固定名, devアカウント)
                                                    │  sts:AssumeRole
                     ┌──────────────────────────────┼──────────────────────────────┐
                     ▼                              ▼                              ▼
         devアカウント (自己信頼)             stgアカウント                    prdアカウント
   <project>-dev-cross-account-      <project>-stg-cross-account-  <project>-prd-cross-account-
        deploy-role                       deploy-role                    deploy-role
```

### アーキテクチャ特性

| 特性 | 値 | 理由 |
|---------------|-------|-----------|
| 可用性 | 単一リージョン、HA不要 | CI/CDのコントロールプレーンであり、失敗した実行は再実行すればよく、業務アプリを止めるものではない |
| スケーラビリティ | フルマネージド(CodePipeline/CodeBuild) | サーバー管理不要。ビルド量が増えた場合の律速はCodeBuildの同時実行数のみ |
| セキュリティ | クロスアカウントアクセスは`AssumeRole`による一時クレデンシャルのみ | 長期的なクロスアカウント認証情報は一切保存しない |
| コスト | 従量課金 | アイドル時のコンピュート料金はなく、パイプライン実行量に比例する |

## 設計判断とベストプラクティス

### 1. パイプラインはdevアカウントに集約し、Deployだけがアカウントを跨ぐ

**判断**: CodeCommitと3本のCodePipelineは、単一の`PipelineStack`として、devアカウント(`ENV=dev`)にのみデプロイする。真にクロスアカウントとなるのはDeployステージのCodeBuildプロジェクトのみ。

**理由**:
- ✅ CDK Pipelinesが必要とするクロスアカウントbootstrap trust設定(`cdk bootstrap --trust <pipeline-account>`)が一切不要。素の`sts:AssumeRole`は対象アカウント側のIAMロールさえあれば動く
- ✅ CodeCommitのリポジトリイベント、CodePipelineの実行状況、CodeBuildのログを単一アカウントから一元的に確認できる
- ✅ Deploy用buildspec(`sample-app/buildspec-deploy.yml`)は3環境とも同一内容。常に`CROSS_ACCOUNT_ROLE_ARN`をAssumeする(devの場合はたまたま同一アカウント内のロールになるだけ)

**トレードオフ**:
- ❌ devアカウントがCI/CD基盤そのものの単一管理ポイントになる。devアカウントへのアクセスを失うと、どの環境へもデプロイできなくなる

### 2. クロススタック参照ではなく固定名のIAMロール

**判断**: Deploy CodeBuildロール(`<project>-<env>-deploy-build-role`)と、対象アカウントの`CrossAccountDeployRole`(`<project>-<env>-cross-account-deploy-role`)は、両スタックで同じ規則により決定的な名前になる。

**理由**:
- ✅ CDKのクロススタック参照(`Fn::ImportValue`、SSMパラメータ参照)は、追加の仕組みなしにはアカウントを跨げない。固定名の`iam.ArnPrincipal`ならこれを完全に回避できる
- ✅ `CrossAccountRoleStack`は`PipelineStack`と独立してデプロイできる。対象アカウント側はdevアカウントのID(`CODECOMMIT_ACCOUNT_ID`)と命名規則さえ知っていればよく、CloudFormationの出力値を受け渡す必要がない

**トレードオフ**:
- ❌ `<project>`や命名規則自体を変更する場合、両側を同時に再デプロイする必要がある

### 3. `shared-params`に共通値をまとめる、ただし機微な値は例外

**判断**: `parameters/shared-params.ts`には全環境共通の値を置く。CodeCommitアカウントIDも本来はここに属する(どの環境のパイプラインを実行してもdevアカウントで固定のため)が、**このリポジトリが公開されている**ため、ハードコードせず`CODECOMMIT_ACCOUNT_ID`環境変数から読み込む。

```typescript
// parameters/shared-params.ts
export const sharedParams: SharedParams = {
  repositoryName: 'sample-app',
  codecommitAccountId: process.env.CODECOMMIT_ACCOUNT_ID,
};
```

### 4. `develop`/`staging`ブランチの自動作成

**判断**: `codecommit.Code.fromDirectory()`はリポジトリ作成時に単一ブランチ(`main`)にしかコンテンツを投入できない。`AwsCustomResource`を2段階(`GetBranch`→`CreateBranch`を2回)で呼び出し、同じ初回コミットから`develop`と`staging`を作成する。

**理由**:
- ✅ `cdk deploy`(`ENV=dev`)を一度実行するだけでリポジトリが完全に整った状態になる。パイプラインを試す前に手動で`git push origin HEAD:develop`する必要がない
- ⚠️ このCustom Resourceは`Repository`コンストラクト自体ではなく、リポジトリのIAM ARNに依存させている。`Repository.onCommit()`(パイプラインの`CodeCommitSourceAction`が内部的に使用)は、生成したEventBridgeルールを`Repository`コンストラクトの**子**として追加するため、`repository`へのコンストラクトレベルの依存を張ると、そのルール(パイプラインを対象とし、パイプラインはブランチ作成リソースに依存する)まで巻き込まれて循環依存になる。詳細は`lib/stacks/pipeline-stack.ts`内のコメントを参照

### 5. Well-Architected Frameworkとの整合性

| 柱 | 実装内容 |
|--------|---------------|
| **運用上の優秀性** | 環境・ステージごとに構造化されたCodeBuildログ(1か月保持) |
| **セキュリティ** | 長期的なクロスアカウント認証情報を持たない。`AssumeRole`セッションは最大1時間。`AwsSolutionsChecks`(CDK Nag)による理由付きの抑制 |
| **信頼性** | マネージドなCodePipeline/CodeBuildのみで、パッチ適用や障害対応が必要なサーバーがない |
| **パフォーマンス効率** | サンプルパイプラインには`BUILD_GENERAL1_SMALL`で十分 |
| **コスト最適化** | 従量課金のパイプライン/ビルドのみ。アイドルコンピュートなし |

## 前提条件

- 3つのAWSアカウント(dev / stg / prd)。それぞれ個別のCLIプロファイルを用意
- AWS CLI v2.x(アカウントごとにプロファイル設定済み)
- Node.js 20.x以降
- AWS CDK 2.x
- Git

### 必要なIAM権限

デプロイを実行するユーザー/ロールには以下の権限が必要です:
- devアカウント: CodeCommit, CodePipeline, CodeBuild, IAM, S3(アーティファクトバケット)
- stg/prdアカウント: IAM(クロスアカウントデプロイロールのみ)

## デプロイ手順

### 1. アカウントIDとCodeCommitアカウントIDを設定

```bash
export CODECOMMIT_ACCOUNT_ID=111111111111   # devアカウント — CodeCommitの配置先
export DEV_ACCOUNT_ID=111111111111
export STG_ACCOUNT_ID=222222222222
export PRD_ACCOUNT_ID=333333333333
export PROJECT=myproject
```

### 2. まずdevアカウントへデプロイ

CodeCommitリポジトリ、3ブランチ、3パイプライン、**そしてdevアカウント自身の(自己信頼)クロスアカウントロール**が作成されます。

```bash
export ENV=dev
npm run bootstrap    # 初回のみ、devプロファイルに対して実行
npm run stage:deploy:all -- --project=$PROJECT --env=dev
```

### 3. stg/prdへクロスアカウントロールをデプロイ

**各アカウント自身のCLIプロファイル**に対して実行します。信頼ポリシーを正しく構築するため、`CODECOMMIT_ACCOUNT_ID`はdevアカウントのIDのまま変更しないでください。

```bash
export ENV=stg
npm run bootstrap
npm run stage:deploy:all -- --project=$PROJECT --env=stg

export ENV=prd
npm run bootstrap
npm run stage:deploy:all -- --project=$PROJECT --env=prd
```

### 4. パイプラインを実際に動かす

```bash
# repositoryName のデフォルト値は "sample-app" (parameters/shared-params.ts)
git clone codecommit::ap-northeast-1://sample-app
cd sample-app
git checkout develop
git commit --allow-empty -m "trigger dev pipeline"
git push origin develop     # <project>-dev-pipeline が起動
```

`staging` / `main`へのpushでそれぞれstg / prdパイプラインが起動します。

### 5. 動作確認

```bash
aws codepipeline get-pipeline-state --name <project>-dev-pipeline --profile <dev-profile>
```

DeployステージのCodeBuildログに、対象アカウントのAssumeRole後の認証情報で実行された`aws sts get-caller-identity`の結果が出力されます。これがクロスアカウント越境の証拠です。

## テスト戦略

```
test/
├── compliance/
│   └── cdk-nag.test.ts             # 理由付きで抑制済みのAwsSolutionsChecks
├── snapshot/
│   └── snapshot.test.ts            # 両スタックの完全なテンプレートスナップショット
└── unit/
    ├── pipeline-stack.test.ts      # リポジトリ/パイプライン/ロールのリソース検証
    └── cross-account-role-stack.test.ts  # 信頼ポリシーの検証
```

```bash
npm test -w workspaces/cicd-codecommit-cross-account
```

## セキュリティに関する考慮事項

- ✅ 長期的なクロスアカウントIAMユーザー/キーは存在せず、短命な`sts:AssumeRole`セッション(最大1時間)のみ
- ✅ 各`CrossAccountDeployRole`が信頼するプリンシパルは、同じ環境のDeploy CodeBuildロールのARN1つのみ
- ✅ `test/compliance/`で`AwsSolutionsChecks`(CDK Nag)を実行し、残存するワイルドカード/マネージドポリシーの指摘は理由付きで抑制(`lib/stacks/pipeline-stack.ts`および`lib/stacks/cross-account-role-stack.ts`参照)

## カスタマイズ

### サンプルのデプロイ処理を差し替える

`sample-app/buildspec-deploy.yml`を編集してください。`echo`や`aws sts
get-caller-identity`はプレースホルダーです。AssumeRole後の認証情報の下で、実際のデプロイコマンド(`cdk deploy`、`aws s3 sync`、`aws ecs update-service`など)に置き換えてください。

### 手動承認を有効にする

```typescript
// parameters/prd-params.ts
requireManualApproval: true,
approvalTopicArn: 'arn:aws:sns:ap-northeast-1:333333333333:cicd-x-account-prd-approvals',
```

## トラブルシューティング

### 問題: Deployステージの`sts:AssumeRole`で`AccessDenied`

**症状**: Deploy CodeBuildのログで`sts:AssumeRole`呼び出し時に`AccessDenied`が発生する。

**対処法**:
1. `CrossAccountRoleStack`が対象アカウントへデプロイ済みか確認(`ENV=stg`/`ENV=prd`をそのアカウント自身のプロファイルに対して実行したか)
2. devアカウントへのデプロイ時と対象アカウントへのデプロイ時で、`CODECOMMIT_ACCOUNT_ID`が同じ値になっているか確認(信頼ポリシーはこの値から構築される)

### 問題: pushしてもパイプラインが起動しない

**症状**: `develop`/`staging`/`main`へpushしても対応するパイプラインが起動しない。

**対処法**:
1. CodeCommit上にそのブランチが実際に存在するか確認(`develop`/`staging`はdevアカウントへのデプロイ時にCustom Resourceで作成される。存在しない場合はCloudFormationのイベントログを確認)
2. `CodeCommitSourceAction`はデフォルトのEventBridgeトリガーを使用している。対応する`AWS::Events::Rule`が存在し、パイプラインをターゲットにしているか確認

## 参考資料

### AWS ドキュメント
- [AWS CodePipeline User Guide](https://docs.aws.amazon.com/codepipeline/latest/userguide/welcome.html)
- [AWS CodeCommit User Guide](https://docs.aws.amazon.com/codecommit/latest/userguide/welcome.html)
- [AWS CodeBuild User Guide](https://docs.aws.amazon.com/codebuild/latest/userguide/welcome.html)
- [IAM cross-account roles](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_aws-accounts.html)

### AWS CDK
- [aws-codepipeline-actions module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_codepipeline_actions-readme.html)
- [CDK Nag](https://github.com/cdklabs/cdk-nag)

### 関連アーキテクチャ
- [`cicd-cloudfront-s3`](../cicd-cloudfront-s3/) — 同一アカウント内のCodeCommit → CodePipeline構成との比較用

## 📄 ライセンス

このプロジェクトはMITライセンスの下で公開されています。詳細は[LICENSE](../../../LICENSE)を参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します。詳細は[CONTRIBUTING.md](../../../docs/contribution/CONTRIBUTING.md)を参照してください。

## 🏆 このリファレンスアーキテクチャについて

このリファレンスアーキテクチャは、本番運用に耐えるクロスアカウントCI/CD基盤を構築するためのAWS CDKベストプラクティスを示すものです。

**対象レベル**: 300 (上級)

---

**注記**: これはリファレンス実装です。本番環境へデプロイする前に、必ず自組織の要件とポリシーに沿ってレビュー・カスタマイズしてください。
