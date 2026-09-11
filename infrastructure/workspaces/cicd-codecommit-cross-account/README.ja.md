# CICD-CodeCommit-Cross-Account — 単一CodeCommitリポジトリからのクロスアカウントCI/CDパイプライン

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## はじめに

AWS CodePipelineとCodeBuildだけで構成された、**クロスアカウントCI/CDパイプライン**のリファレンス実装です。開発(dev)アカウントに1つだけ作成したCodeCommitリポジトリを起点に、**各環境のパイプライン自体をそれぞれのアカウント(dev / stg / prd)にデプロイ**します。

このアーキテクチャで示す内容:

- 開発アカウントに作成する単一のCodeCommitリポジトリと、同じ初回コミットから自動作成される3つのブランチ(`develop` / `staging` / `main`)
- **それぞれのアカウントにデプロイされる**3本の独立したCodePipeline(dev/stg/prd)。パイプラインはdevアカウントに集約せず、デプロイ対象と同じアカウントに配置する
- クロスアカウントの越境は**Sourceステージのみ**で発生する: stg/prdパイプラインの`CodeCommitSourceAction`は、devアカウントにこの目的のためだけに作成された固定名のIAMロールをAssumeする
- CodeCommitはリポジトリを所有するアカウントでしかイベントを発行しないため、devアカウントは各ブランチのpushイベントを対応するアカウントのデフォルトEventBridgeバスへ**転送**し、そのアカウント自身のルールがパイプラインを起動する
- 環境ごとの設定は `dev-params` / `stg-params` / `prd-params`、環境非依存の値は `shared-params` として定義。ただしCodeCommitアカウントIDだけは、公開リポジトリであるため意図的にハードコードせず環境変数から渡す

### この設計を選ぶ理由

| 特徴 | メリット |
| ------- | ------- |
| デプロイ対象と同じアカウントにパイプラインを配置 | Test/Build/Deployは全てそのアカウント内のリソースに対して直接実行される。Source以外にクロスアカウントの`AssumeRole`は一切不要 |
| クロスアカウントの越境をSourceだけに限定 | アカウントを跨ぐのは`CodeCommitSourceAction`のみ。stg/prdが信頼する必要があるのは、devアカウントの固定名ロール(`<project>-pipeline-source-action-<accountId>`)だけ |
| 明示的なイベント転送 | CodeCommitのイベントはdevアカウントの外へ自然に出ていくわけではない。`RepositoryStack`が各ブランチのpushイベントを対応するアカウント自身のデフォルトイベントバスへ転送し、通常のEventBridgeルールでそのアカウントのパイプラインを起動する |
| 固定名のIAMロール | Sourceアクション用ロール(devアカウント)と各アカウントのパイプラインロールは、どちらも決定的な名前になるため、信頼関係を単純なARN文字列として表現できる。アカウントを跨ぐCloudFormationエクスポートは不要 |

## アーキテクチャ概要

![Architecture Overview](overview.drawio.svg)

### 主要コンポーネント

| コンポーネント | 設計のポイント |
| --------- | ------------- |
| CodeCommitリポジトリ(devアカウント、`RepositoryStack`) | 本スタックが作成し、`sample-app/`を`main`に初期投入。`develop`/`staging`は同じコミットから`AwsCustomResource`で作成 |
| Sourceアクション用ロール(devアカウント、stg/prd用に1つずつ) | `<project>-pipeline-source-action-<accountId>`。そのアカウント自身のパイプラインロールのみを信頼し、このリポジトリ1つに限定した`codecommit:GitPull`等の権限を付与 |
| イベント転送ルール(devアカウント、stg/prd用に1つずつ) | そのブランチの`referenceCreated`/`referenceUpdated`イベントを、対象アカウントのデフォルトイベントバスへ転送 |
| CodePipeline(dev/stg/prd、`PipelineStack`、アカウントごとに1つ) | `<project>-<env>-pipeline`: Source→Test→Build→[Approve]→Deployを、そのアカウント内で完結して実行 |
| EventBusPolicy + トリガールール(stg/prd) | devアカウントからのイベント発行(`PutEvents`)をこのアカウントのデフォルトバスに対して許可し、転送されたイベントに反応してこのアカウントのパイプラインを起動するルール |
| アーティファクトバケットのKMSキー(stg/prdのみ) | クロスアカウントの`CodeCommitSourceAction`では、CodePipelineがdevアカウントのSourceアクション用ロールに復号権限を付与できるよう、アーティファクトバケットがカスタマー管理キーである必要がある |

### データフロー

```text
devアカウント                              stgアカウント          prdアカウント
┌─────────────────────────────┐          ┌──────────────────┐   ┌──────────────────┐
│ CodeCommitリポジトリ          │          │                  │   │                  │
│  (develop/staging/main)      │          │                  │   │                  │
│                               │          │                  │   │                  │
│ push → イベント転送 ──────────┼─────────►│ デフォルトイベントバス│   │ デフォルトイベントバス│
│         (stagingブランチ)     │          │  → トリガールール │   │  → トリガールール │
│ push → イベント転送 ───────────────────────────────────────────►│                  │
│         (mainブランチ)        │          │        │         │   │        │         │
│                               │          │        ▼         │   │        ▼         │
│ push (develop) → ローカルルール│          │  <project>-stg-   │   │  <project>-prd-   │
│        │                     │          │  pipeline         │   │  pipeline         │
│        ▼                     │          │  Source ◄─assume─┼───┼── devアカウントの │
│ <project>-dev-pipeline       │          │  (クロスアカウント) │   │  ロール           │
│  Source (同一アカウント)      │          │  Test→Build→Deploy│   │  Test→Build→Deploy│
│  Test→Build→Deploy           │          │  (同一アカウント)   │   │  (同一アカウント)   │
└─────────────────────────────┘          └──────────────────┘   └──────────────────┘
```

### アーキテクチャ特性

| 特性 | 値 | 理由 |
|---------------|-------|-----------|
| 可用性 | 単一リージョン、HA不要 | CI/CDのコントロールプレーンであり、失敗した実行は再実行すればよく、業務アプリを止めるものではない |
| スケーラビリティ | フルマネージド(CodePipeline/CodeBuild) | サーバー管理不要。ビルド量が増えた場合の律速はCodeBuildの同時実行数のみ |
| セキュリティ | クロスアカウントアクセスはソース読み取りのみに限定。Test/Build/Deployにクロスアカウントロールは存在しない | パイプラインロールが侵害された場合の影響範囲が、そのアカウント内に閉じる |
| コスト | 従量課金 | アイドル時のコンピュート料金はなく、パイプライン実行量に比例する |

## 設計判断とベストプラクティス

### 1. パイプラインはデプロイ対象と同じアカウントに配置する

**判断**: `PipelineStack`は環境ごとに1つ、その環境自身のアカウントへデプロイする。stg/prdでアカウントを跨ぐのはSourceステージ(`CodeCommitSourceAction`)のみで、Test/Build/Deployは全てローカルで実行される。

**理由**:
- ✅ DeployのCodeBuildプロジェクトはそのアカウントのリソースに対して直接操作できる。`sts:AssumeRole`の往復や、同期を取る必要のある固定名デプロイロールが不要
- ✅ 影響範囲: stgのパイプラインロールが侵害されてもprdには到達できない(逆も同様)。各パイプラインは自分のアカウント内にしか権限を持たない
- ✅ ソースリポジトリとデプロイ先が異なるアカウントにある場合の、CodeCommit起点パイプラインの典型的な構築方法と一致する(このリポジトリ自身の`common/constructs/pipeline/infra-pipeline-construct.ts`が、CI専用パイプラインに同じパターンを適用している)

**トレードオフ**:
- ❌ パイプラインの状況確認先が単一のコンソールではなく3つに分散する。環境横断でパイプライン状況を一望できる単一の画面がない

### 2. CDK標準のクロスアカウントサポートスタックではなく、固定名ロールでSourceを越境させる

**判断**: `CodeCommitSourceAction.role`には、`RepositoryStack`がdevアカウントに作成した固定名ロール(`<project>-pipeline-source-action-<accountId>`)を明示的に指定する。`role`を未指定のままCDKに自動で`CrossAccountSupportStack`を生成させる方式は採らない。

**理由**:
- ✅ CDK標準のクロスアカウントサポートは、事前にCodeCommitアカウント側で`cdk bootstrap --trust <pipeline-account>`が必要。固定名ロールならこのbootstrap trust設定を完全に回避できる
- ✅ 信頼関係は単純なARN文字列であり、両側(`lib/stacks/naming.ts`)で同じ規則から計算される。そのため`RepositoryStack`と`PipelineStack`は、devへの初回デプロイ後であればどちらの順序でも独立してデプロイできる

**トレードオフ**:
- ❌ `<project>`を変更する場合、`RepositoryStack`(dev)と各ターゲットアカウントの`PipelineStack`を同時に再デプロイする必要がある

### 3. 共有イベントバスではなく、明示的なEventBridge転送

**判断**: `RepositoryStack`が各ブランチのpushイベントを対応するアカウント自身のデフォルトイベントバスへ転送(`events_targets.EventBus`)する。そのアカウントの`PipelineStack`は`AWS::Events::EventBusPolicy`でdevアカウントを許可し、自身のルールで反応する。

**理由**:
- ✅ CodeCommitは`CodeCommit Repository State Change`イベントを、リポジトリを所有するアカウントでしか発行しない。この転送処理なしにはstg/prdはイベントを見ることができない
- ✅ 同一アカウント(dev)とクロスアカウント(stg/prd)のパイプラインは、どちらも「このアカウント内でCodeCommit形式のイベントに反応するルール」という同じ仕組みで起動する。転送されたイベントは元のリポジトリARNを保持するため、トリガールールの`resources`フィルタはどちらのケースでも同一

### 4. `shared-params`に共通値をまとめる、ただし機微な値は例外

**判断**: `parameters/shared-params.ts`には全環境共通の値を置く。CodeCommitアカウントIDも本来はここに属する(常にdevアカウントで固定のため)が、**このリポジトリが公開されている**ため、ハードコードせず`CODECOMMIT_ACCOUNT_ID`環境変数から読み込む。

```typescript
// parameters/shared-params.ts
export const sharedParams: SharedParams = {
  repositoryName: 'sample-app',
  codecommitAccountId: process.env.CODECOMMIT_ACCOUNT_ID,
};
```

### 5. `develop`/`staging`ブランチの自動作成

**判断**: `codecommit.Code.fromDirectory()`はリポジトリ作成時に単一ブランチ(`main`)にしかコンテンツを投入できない。`AwsCustomResource`を2段階(`GetBranch`→`CreateBranch`を2回)で呼び出し、同じ初回コミットから`develop`と`staging`を作成する。

**理由**:
- ✅ `cdk deploy`(`ENV=dev`)を一度実行するだけでリポジトリが完全に整った状態になる。パイプラインを試す前に手動で`git push origin HEAD:develop`する必要がない

### 6. Well-Architected Frameworkとの整合性

| 柱 | 実装内容 |
|--------|---------------|
| **運用上の優秀性** | 環境・ステージごとに構造化されたCodeBuildログ(1か月保持) |
| **セキュリティ** | クロスアカウントアクセスは環境ごとに1つの、狭く限定されたSourceロールのみに制限。`AwsSolutionsChecks`(CDK Nag)による理由付きの抑制 |
| **信頼性** | マネージドなCodePipeline/CodeBuildのみで、パッチ適用や障害対応が必要なサーバーがない |
| **パフォーマンス効率** | サンプルパイプラインには`BUILD_GENERAL1_SMALL`で十分 |
| **コスト最適化** | 従量課金のパイプライン/ビルドのみ。KMSキーはクロスアカウントアクセスが実際に必要な場合にのみ作成 |

## 前提条件

- 3つのAWSアカウント(dev / stg / prd)。それぞれ個別のCLIプロファイルを用意
- AWS CLI v2.x(アカウントごとにプロファイル設定済み)
- Node.js 20.x以降
- AWS CDK 2.x
- Git

### 必要なIAM権限

デプロイを実行するユーザー/ロールには、**各アカウントで**以下の権限が必要です:
CodeCommit(devのみ)、CodePipeline、CodeBuild、IAM、S3(アーティファクトバケット)、EventBridge、KMS(stg/prdのみ)。

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

CodeCommitリポジトリ、3ブランチ、stg/prd向けのクロスアカウントソースアクセスの仕組み、**そしてdev環境自身のパイプライン**が作成されます。

```bash
export ENV=dev
npm run bootstrap    # 初回のみ、devプロファイルに対して実行
npm run stage:deploy:all -- --project=$PROJECT --env=dev
```

### 3. stg/prdへパイプラインをデプロイ

**各アカウント自身のCLIプロファイル**に対して実行します。Sourceステージが正しいロールを信頼できるよう、`CODECOMMIT_ACCOUNT_ID`はdevアカウントのIDのまま変更しないでください。

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
git checkout staging
git commit --allow-empty -m "trigger stg pipeline"
git push origin staging     # stgアカウントへ転送され、<project>-stg-pipeline が起動
```

`develop` / `main`へのpushでそれぞれdev / prdパイプラインが起動します。

### 5. 動作確認

```bash
aws codepipeline get-pipeline-state --name myproject-stg-pipeline --profile <stg-profile>
```

DeployステージのCodeBuildログに、そのアカウント自身の認証情報で実行された`aws sts get-caller-identity`の結果が出力されます。デプロイ処理だけでなく、パイプライン自体がそのアカウントで実際に動いていることが分かります。

## テスト戦略

```
test/
├── compliance/
│   └── cdk-nag.test.ts             # 理由付きで抑制済みのAwsSolutionsChecks
├── snapshot/
│   └── snapshot.test.ts            # RepositoryStack + 両方のパイプライン形態の完全なテンプレートスナップショット
└── unit/
    ├── repository-stack.test.ts    # Sourceロール/イベント転送の検証
    └── pipeline-stack.test.ts      # 同一アカウント vs クロスアカウントのSource動作の検証
```

```bash
npm test -w workspaces/cicd-codecommit-cross-account
```

## セキュリティに関する考慮事項

- ✅ クロスアカウントアクセスは環境ごとに1つのSourceアクション用ロールのみに限定され、このリポジトリ1つのARNに対する`codecommit:GitPull`等に限定されている。Test/Build/Deployがクロスアカウントロールをassumeすることはない
- ✅ 各アカウントは、自身のデフォルトイベントバスへの発行(`AWS::Events::EventBusPolicy`)をdevアカウントのみに明示的に許可する
- ✅ アーティファクトバケットのKMSキー(クロスアカウントパイプラインのみ作成)は自動ローテーションを有効化済み
- ✅ `test/compliance/`で`AwsSolutionsChecks`(CDK Nag)を実行し、残存するワイルドカード/マネージドポリシーの指摘は理由付きで抑制(`lib/stacks/repository-stack.ts`および`lib/stacks/pipeline-stack.ts`参照)

## カスタマイズ

### サンプルのデプロイ処理を差し替える

`sample-app/buildspec-deploy.yml`を編集してください。`echo`や`aws sts
get-caller-identity`はプレースホルダーです。Deployは既に対象アカウント内で実行されているため、`AssumeRole`は不要な状態で、実際のデプロイコマンド(`cdk deploy`、`aws s3 sync`、`aws ecs update-service`など)に置き換えてください。

### 手動承認を有効にする

```typescript
// parameters/prd-params.ts
requireManualApproval: true,
approvalTopicArn: 'arn:aws:sns:ap-northeast-1:333333333333:cicd-x-account-prd-approvals',
```

## トラブルシューティング

### 問題: stg/prdパイプラインがpushしても起動しない

**症状**: `staging`/`main`へpushしても対応するパイプラインが起動しない。

**対処法**:
1. `RepositoryStack`がデプロイ済みか確認(`ENV=dev`)。そのブランチ向けのイベント転送ルールを作成するのはこのスタック
2. そのアカウントの`PipelineStack`が、自身のプロファイルに対してデプロイ済みか確認。devアカウントからのイベント発行を許可する`AWS::Events::EventBusPolicy`と、それに反応するトリガールールを作成するのはこのスタック
3. devアカウントへのデプロイ時と対象アカウントへのデプロイ時で、`CODECOMMIT_ACCOUNT_ID`が同じ値になっているか確認(Sourceアクション用ロールのARNとトリガールールの`resources`フィルタの両方がこの値から構築される)

### 問題: stg/prdのSourceステージで`AccessDenied`

**症状**: パイプラインは起動するが、SourceステージがIAM関連のエラーで失敗する。

**対処法**:
1. `RepositoryStack`のSourceアクション用ロール(`<project>-pipeline-source-action-<accountId>`)がdevアカウントに存在し、このアカウントのパイプラインロール(`<project>-<env>-pipeline-role`)をARNで信頼しているか確認
2. アーティファクトバケットのKMSキーが存在するか確認。クロスアカウントのSourceアクションには、アーティファクトバケットのカスタマー管理暗号化が必要

## 参考資料

### AWS ドキュメント
- [AWS CodePipeline User Guide](https://docs.aws.amazon.com/codepipeline/latest/userguide/welcome.html)
- [AWS CodeCommit User Guide](https://docs.aws.amazon.com/codecommit/latest/userguide/welcome.html)
- [AWS CodeBuild User Guide](https://docs.aws.amazon.com/codebuild/latest/userguide/welcome.html)
- [Cross-account and cross-region actions in CodePipeline](https://docs.aws.amazon.com/codepipeline/latest/userguide/pipelines-create-cross-account.html)
- [Sending and receiving Amazon EventBridge events between AWS accounts](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-cross-account.html)

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
