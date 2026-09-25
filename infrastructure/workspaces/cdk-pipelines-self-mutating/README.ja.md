# CDK Pipelines(セルフミューテーション) - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **Level: 300 (Intermediate)**

`aws-cdk-lib/pipelines` で作る**セルフミューテーション(自己更新)型の CDK Pipeline** です。パイプライン自身の定義がビルド元のリポジトリの中にあるため、パイプラインを変更するコミット(ステージやステップの追加)はパイプライン自身が取り込みます。最初の 1 回以降、誰もパイプラインに対して `cdk deploy` を実行しません。

```
Source (CodeCommit) → Build (npm ci · tsc · jest + CDK Nag · cdk synth) → UpdatePipeline (自己更新)
  → Dev  (CloudFormation デプロイ → スモークテスト)
  → Prod (手動承認 → CloudFormation デプロイ → スモークテスト)
```

CodePipeline/CodeBuild を手で組み立てる [`cicd-codecommit-cross-account`](../cicd-codecommit-cross-account/) の対になる構成です。こちらは `CodePipeline` コンストラクトが `Stage` の定義からステージ、IAM ロール、CloudFormation アクションを生成します。トレードオフは[後述](#1-cdk-pipelines-と手組みの-codepipeline)のとおりです。

## 📑 目次

- [アーキテクチャ概要](#-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [Well-Architected との対応](#-well-architected-との対応)
- [コスト最適化](#-コスト最適化)
- [セキュリティ](#-セキュリティ)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [動作確認スクリプト](#-動作確認スクリプト)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![Architecture Diagram](overview.drawio.svg)

### リポジトリ構成

```
cdk-pipelines-self-mutating/
├── bin/ lib/ parameters/ test/     # ワークスペース直下: RepositoryStack のみ(app/ を初期コミットにしたリポジトリ)
├── app/                            # ← 単体で完結した CDK アプリ = リポジトリの初期コミット
│   ├── bin/app.ts                  #   エントリポイント(PipelineStack。-c project -c env が必要)
│   ├── lib/pipeline-stack.ts       #   パイプライン定義(自己更新の対象)
│   ├── lib/app-stage.ts, hello-stack.ts   # ステージごとにデプロイするサンプルアプリ
│   ├── lib/config.ts               #   APP_VERSION / ENABLE_SECURITY_CHECK(確認スクリプトが反転させる)
│   ├── test/                       #   パイプラインの Build ステージも通すテスト
│   └── package.json + package-lock.json   # CodeBuild での `npm ci` 用
└── test-pipeline.sh                # E2E 確認(リリース + 自己更新)
```

### 主要コンポーネント

- **`RepositoryStack`**(ワークスペース直下)— **初期コミットが `app/` の内容**である CodeCommit リポジトリ。CDK Pipelines はパイプラインより先にソースを必要とし、パイプライン定義自体がそのソースにあるため、別スタックにしています。1 回デプロイすれば、以降のリポジトリは開発者のものです。
- **`PipelineStack`**(`app/`)— 手動デプロイ(`app/` で `cdk deploy`)は 1 回だけで、その後は自己更新します。
  - V2 の `codepipeline.Pipeline`(`restartExecutionOnUpdate: true`、`crossAccountKeys: false`)と、プライベート・TLS 限定・SSE-S3 のアーティファクトバケット
  - `selfMutation: true` の `pipelines.CodePipeline` と `ShellStep` の synth(`npm ci` → `npm run build` → `npm test` → `cdk synth -c project=… -c env=…`)
  - **Dev** ステージ: CloudFormation デプロイ → デプロイした関数を呼ぶ `CodeBuildStep` のスモークテスト(`envFromCfnOutputs` で関数名を受け取り、ロールは**その 1 関数への `lambda:InvokeFunction` のみ**)
  - **Prod** ステージ: `ManualApprovalStep` → デプロイ → スモークテスト
  - すべてのビルドプロジェクトで共有する CloudWatch ロググループ(保持 7 日)
- **サンプルアプリ**(`HelloStack`)— `{ stage, version }` を返すインラインコードの Lambda 1 つ。デプロイと昇格を観測できるようにするためのものです。自分のスタックに置き換えてください。

### アーキテクチャの特性

| 特性 | 値 | 根拠 |
|---|---|---|
| パイプラインの所有 | パイプライン自身が更新する | 手動の `cdk deploy` は 1 回だけで、以降はすべてコミット |
| 環境 | Dev → (承認) → Prod | 昇格ゲートは人がコマンドを打つのではなくパイプラインのステップ |
| 品質ゲート | デプロイ前に `tsc` + ユニットテスト + CDK Nag | テストを壊すコミットは `UpdatePipeline` にも Dev にも届かない |
| アカウント | 単一アカウント(Dev と Prod は別スタック) | 1 アカウントで検証可能。マルチアカウントは[カスタマイズ](#-カスタマイズ)を参照 |
| Assets ステージ | なし | CDK Pipelines はスタックにファイル/Docker アセットがある場合のみ `Assets` ステージを追加(ここの Lambda はインライン) |

## 🎯 設計判断とベストプラクティス

### 1. CDK Pipelines と手組みの CodePipeline

| | CDK Pipelines(本構成) | 手組みの CodePipeline([`cicd-codecommit-cross-account`](../cicd-codecommit-cross-account/)) |
|---|---|---|
| ステージ/アクション | `Stage` オブジェクトから生成 | 1 つずつ記述 |
| CDK アプリのデプロイ | 標準対応: `Prepare`/`Deploy` アクション、アセット、bootstrap ロール | CodeBuild 内で `cdk deploy` をスクリプト化 |
| 自己更新 | 組み込み(`UpdatePipeline`) | 自前で構築 |
| CDK 以外のステップ(Docker ビルド、独自テスト) | `ShellStep` / `CodeBuildStep` | ネイティブ |
| アクション/IAM の細かい制御 | 限定的(`codePipeline` の L2 やエスケープハッチへ) | 完全 |

配信対象が CDK アプリなら CDK Pipelines、各アクションを厳密に制御したい場合や CDK 以外の配信なら手組みの CodePipeline を選びます。

### 2. パイプラインはビルド元のリポジトリの中にある

`app/lib/pipeline-stack.ts` はパイプラインが監視するリポジトリの一部です。これを変更するコミットが来ると `UpdatePipeline` がパイプラインスタックに `cdk deploy` を実行し、`restartExecutionOnUpdate` により新しい定義で実行が再起動します。[`test-pipeline.sh`](#-動作確認スクリプト) がこれを E2E で実証します。1 つのコミットで `ENABLE_SECURITY_CHECK` を反転すると、パイプラインが**自力で Dev に `SecurityCheck` アクションを獲得**します。

### 3. `project` / `env` は synth コマンドに埋め込む

`cdk synth -c project=… -c env=…` は最初にデプロイしたときの props から生成されるため、自己更新しても値が保たれます。`cdk.json` にコンテキストを持たず、手元のデプロイとパイプラインの間でずれることもありません。

### 4. リポジトリスタックを分け、ブートストラップは 2 段階

順序が重要です。**(1)** `RepositoryStack`(リポジトリの作成とシード)→ **(2)** `app/` で `cdk deploy`(パイプラインを作成。すぐに実行が始まる)→ 以降は `git push` のみ。`AWS::CodeCommit::Repository` の `Code` は初期コミット専用で、`app/` を変更して `RepositoryStack` を再デプロイしても、既存リポジトリにコミットは**追加されません**。

### 5. テストがパイプラインのゲートになる(仮定の話ではない)

`npm test` は Build ステージで実行されるため、テストが落ちると自己更新やデプロイの**前に**止まります。検証中、`ENABLE_SECURITY_CHECK` を反転したコミットは最初 Build ステージで失敗しました。「`SecurityCheck` アクションが無い」というユニットテストが、フラグ変更で正当に壊れたためです。修正は「フラグが立っているときに限ってアクションが存在する」と検証する形にすることでした。パイプラインの構造を検証するテストは、定数ではなく `lib/config.ts` に追従させてください。

### 6. 最小権限のスモークテストをパイプラインのステップに

`CodeBuildStep` + `envFromCfnOutputs` は、デプロイ済みスタックの出力から関数名を実行時に解決し、`rolePolicyStatements` でそのステップに**その 1 関数の ARN への `lambda:InvokeFunction` だけ**を付与します。スモークテストが失敗すると承認の前で止まるので、壊れた Dev が Prod の承認待ちに載ることはありません。

### 7. 単一アカウントではクロスアカウント KMS キーを作らない

`crossAccountKeys: false` により、KMS キー(月額約 $1)とキーポリシーの管理を避けます。Dev/Prod が別アカウントになるときに有効化します(カスタマイズを参照)。

### 8. アーティファクトバケットを自分で持つ

`codePipeline:` に `codepipeline.Pipeline` を渡すことで、スタック側でアーティファクトバケット(プライベート、TLS 限定、SSE-S3、本番以外は `autoDeleteObjects`)を所有できます。既定のバケットは保持(retain)されて `cdk destroy` の妨げになります。

### 9. 環境別パラメータ

命名とパイプラインの設定値はリポジトリの中身として存在する必要があるため `app/lib/naming.ts` と `app/lib/config.ts` に置いています。ワークスペース直下のスタックは `parameters/<env>-params.ts`(`EnvParams`)です。

## 🏛️ Well-Architected との対応

| 柱 | 実装 |
|---|---|
| **運用上の優秀性** | インフラと配信をコード化、自己更新するパイプライン、ビルドログは CloudWatch、`test-pipeline.sh` がリリースと自己更新を実証 |
| **セキュリティ** | Prod 前の手動承認、最小権限のスモークテストロール、プライベート・TLS 限定・暗号化のアーティファクトバケット、デプロイは CDK bootstrap ロール、全スタックに CDK Nag |
| **信頼性** | テストとスモークテストが昇格のゲート、失敗したデプロイは CloudFormation がロールバック、更新時再起動で古い定義のまま走らない |
| **パフォーマンス効率** | `SMALL` の CodeBuild、Docker-in-Docker なし、Dev/Prod は 1 つの synth 済みクラウドアセンブリからデプロイ |
| **コスト最適化** | V2 パイプラインはアクション実行時間で課金、KMS キーなし、ログ保持は短期間、コミットの間は何も動かない |
| **持続可能性** | ビルドはオンデマンドのみ、常駐のビルド基盤なし |

## 💰 コスト最適化

### 1 リリースあたり・月額のコスト目安(ap-northeast-1、概算、無料枠を除く)

```
1 リリース(1 コミットが Dev と Prod を通過):
  CodeBuild(SMALL Linux): Synth 約2分 + SelfMutate 約1分 + スモークテスト2回 約1分  ≈ 4〜5分 x 約$0.005/分  ≈ $0.02〜0.03
  CodePipeline V2:        約10アクション分 x $0.002                                  ≈ $0.02
  Lambda / ログ / S3:     わずか
  -------------------------------------------------------------------------------
  ≈ 1 リリースあたり $0.05

月額(30 リリース): ≈ $1.5、アイドル時のパイプライン: ≈ $0
```

最新の単価は CodePipeline / CodeBuild の料金ページで確認してください(V1 パイプラインはアクティブなパイプライン単位の課金です)。

### コストレバー

1. 単一アカウントでは**クロスアカウント KMS キーを作らない**(`crossAccountKeys: false`)。
2. **`npm test` を速く保つ** — コストの大半はビルド時間です。
3. このサイズのアプリなら **`SMALL` コンピュート**で十分です。
4. 共有ビルドロググループの**保持期間を短く**する。

## 🔒 セキュリティ

### 実装済み

- ✅ Prod は**手動承認**でゲート
- ✅ **最小権限のスモークテスト**(1 つの ARN への `lambda:InvokeFunction`)
- ✅ **アーティファクトバケット**: プライベート(パブリックアクセスブロック)、TLS 限定、SSE-S3
- ✅ **デプロイは CDK bootstrap ロール**(パイプラインは `cdk-*` ロールを引き受け、自身は広い権限を持たない)
- ✅ パイプラインとアプリのスタックに **CDK Nag**(`AwsSolutions`)を適用し、Build ステージで実行

### CDK Nag の抑制(理由付き)

| ルール | 抑制する理由 |
|---|---|
| `AwsSolutions-IAM5` | CDK Pipelines が必要とするワイルドカード権限を生成する(アーティファクトのオブジェクト、ログストリーム、レポートグループ、`cdk-*` bootstrap ロールへの `sts:AssumeRole`) |
| `AwsSolutions-IAM4` | CodeBuild/CodePipeline の既定ポリシーはコンストラクトが生成する |
| `AwsSolutions-CB4` | ビルド出力は SSE-S3 のバケットにあるクラウドアセンブリのみで、CMK は不要 |
| `AwsSolutions-S1` | 短命なアーティファクトバケットのアクセスログは、監査上の価値なしにバケットが増えるだけ |

### 対象外(環境ごとに追加)

- **承認できる人**: `codepipeline:PutApprovalResult` を承認者のロール/グループに限定し、承認ステップに SNS 通知を追加する。
- CodeCommit リポジトリの**ブランチ保護 / PR レビュー**(承認ルールテンプレート)。
- **クロスアカウント**デプロイ(カスタマイズを参照)。

## 📋 前提条件

- CDK の bootstrap 済みの AWS アカウント、`${PROJECT}-${ENV}` という名前のプロファイルを設定した AWS CLI v2、Node.js 20 以上、確認スクリプト用の `jq`
- **アカウントで AWS CodeCommit が利用可能**であること(2024-07-25 から新規顧客の受け付けを停止していましたが、2025-11-24 に再開されました)
- それ以外は不要: CodeBuild は `aws/codebuild/standard:7.0`(Node.js 22)を使います

## 🚀 デプロイ手順

```bash
cd infrastructure
npm install
export PROJECT=<project> ENV=dev

# 1. リポジトリ(app/ をシード)
npm run bootstrap        -w workspaces/cdk-pipelines-self-mutating   # 初回のみ
npm run stage:deploy:all -w workspaces/cdk-pipelines-self-mutating

# 2. パイプライン本体 — 唯一の手動デプロイ。デプロイ直後に実行が始まる
cd workspaces/cdk-pipelines-self-mutating/app
npm ci
npx cdk deploy -c project=$PROJECT -c env=$ENV --profile $PROJECT-$ENV
```

CodePipeline のコンソール(または `./test-pipeline.sh`)で実行を確認します。ビルド、自己更新、Dev のデプロイ、スモークテストと進み、**承認待ちで止まります**。

```bash
aws codepipeline put-approval-result --pipeline-name $PROJECT-$ENV-cdkp-pipeline --stage-name Prod \
  --action-name PromoteToProd --result summary=ok,status=Approved --token <get-pipeline-state のトークン>
```

開発者としてアプリを編集するには: `git clone codecommit::ap-northeast-1://$PROJECT-$ENV-cdkp-app`(`git-remote-codecommit` が必要)、編集して `git push` します。

## 🧪 動作確認スクリプト

パイプラインスタックをデプロイできても、パイプラインが動く証明にはなりません。[`test-pipeline.sh`](./test-pipeline.sh) は、実際のリリースと自己更新を通して検証します。

```bash
./test-pipeline.sh --project <project> --env dev              # 検証
./test-pipeline.sh --project <project> --env dev --cleanup    # 検証後にすべてのスタックを削除
./test-pipeline.sh --project <project> --env dev --destroy-only
```

1. 最初の実行(ビルド → 自己更新 → Dev → **承認で停止**)を待機
2. Dev が稼働中(`stage=Dev, version=1.0.0`)で、**Prod がまだ存在しない**ことを確認
3. 承認して Prod が稼働中であることを確認
4. **CodeCommit API 経由(git クライアント不要)で 1 つのコミット**をプッシュ(`APP_VERSION=1.1.0` **と** `ENABLE_SECURITY_CHECK=true`)し、次を確認: パイプラインが**自分自身を再定義**した(Dev に `SecurityCheck` アクションが増えた)、承認待ちの実行が新しいコミットからビルドされている、Dev は 1.1.0 で Prod はまだ 1.0.0、承認後に Prod が 1.1.0

`aws` と `jq` が必要です。`--cleanup` は、パイプラインが作成したアプリのスタック(Prod、Dev)、パイプラインスタック、リポジトリスタックを削除します。

## 🧪 テスト戦略

```bash
npm test -w workspaces/cdk-pipelines-self-mutating   # ワークスペース直下 + app/ のテスト(24件)
```

| 場所 | 種類 | 対象 |
|---|---|---|
| `test/` | ユニット / スナップショット / CDK Nag | `RepositoryStack`(名前、シード、削除ポリシー、出力。アセットのハッシュは正規化) |
| `app/test/` | ユニット | `PipelineStack`: V2 + 更新時再起動、KMS キーなし、ステージ順、ソースのリポジトリ/ブランチ、`UpdatePipeline`、Prod 前の承認、スモークテストの IAM 範囲、バケットのハードニング、埋め込まれた synth コマンド。`HelloStack`/`AppStage` |
| `app/test/` | CDK Nag | パイプラインとアプリのスタック — **パイプラインの Build ステージでも実行される** |

コミットとデプロイの間に立つのは `app/` のテストです。

## ⚙️ カスタマイズ

- **ステージの追加**: `pipeline.addStage(new AppStage(this, 'Stg', …), { pre: [new pipelines.ManualApprovalStep(…)] })`
- **ウェーブ**(複数リージョン/アカウントの並列): `pipeline.addWave('Prod', { post: [...] })` の後に `wave.addStage(...)`
- **マルチアカウント**: Dev/Prod のステージにそれぞれ別の `env: { account, region }` を指定し、`crossAccountKeys: true` にして、デプロイ先ごとに `cdk bootstrap --trust <パイプラインのアカウント> --cloudformation-execution-policies …` を実行します。パイプラインのアカウントには CodeCommit のソース用ロールも必要です(`cicd-codecommit-cross-account` を参照)。
- **CodeCommit の代わりに GitHub**: `CodePipelineSource.connection('owner/repo', 'main', { connectionArn })`(CodeStar connection をコンソールで一度承認しておく)
- **Docker ビルド / アセット**: `Assets` ステージが自動で追加されます。synth に Docker が必要なら `dockerEnabledForSynth` を設定します。
- **本格的な承認フロー**: `ManualApprovalStep` は `comment` を指定でき、SNS トピックへ通知して承認者を制限します。

## 🔧 トラブルシューティング

### Build ステージが失敗して何もデプロイされない
ビルドのロググループ(`…-BuildLogGroup…`)を確認します。型エラー、ユニットテスト、Nag の失敗は仕様として実行を止めます。`app/` でローカル再現できます: `npm ci && npm run build && npm test`。

### 最初の実行で `Source` が失敗する / リポジトリが見つからない
リポジトリスタックより先にパイプラインスタックをデプロイしています。先に `RepositoryStack` をデプロイしてください(リポジトリ名は `<project>-<env>-cdkp-app` と一致する必要があります)。

### `app/` を変更したのにリポジトリが変わらない
リポジトリの `Code` は初期コミット専用です。git でプッシュするか、リポジトリスタックを削除して作り直してください。

### 最初の実行で `UpdatePipeline` が失敗する
パイプラインスタックの `-c project= -c env=` は最初のデプロイと一致している必要があります。同じコンテキストで `app/` から再デプロイしてください。

### 自己更新の後に実行が再起動しない
下位の `codepipeline.Pipeline` で `restartExecutionOnUpdate` が `true` である必要があります(本構成では設定済み)。これがないと古い定義のまま実行が続きます。

### しばらくすると `app/` の `cdk deploy` が "no credentials" で失敗する
同梱の CDK は期限切れの SSO トークンを更新できません。短期認証情報をエクスポート(`aws configure export-credentials --format env`)するか、`aws sso login` をやり直してください。

### `cdk destroy` でスタックが残る
Dev/Prod のスタックはパイプラインが作成したもので、パイプラインスタックを削除しても消えません。`./test-pipeline.sh --destroy-only` を使ってください。

## 🧹 クリーンアップ

```bash
./test-pipeline.sh --project $PROJECT --env $ENV --destroy-only
```

Prod と Dev のアプリスタック、パイプラインスタック(アーティファクトバケットは本番以外では自動で空になります)、リポジトリスタックの順に削除します。

## 📚 参考資料

### AWS ドキュメント
- [CDK Pipelines を使用した継続的インテグレーションとデリバリー (CI/CD)](https://docs.aws.amazon.com/cdk/v2/guide/cdk_pipeline.html)
- [`aws-cdk-lib/pipelines` モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.pipelines-readme.html)
- [CodePipeline のパイプラインタイプ(V1 と V2)と料金](https://docs.aws.amazon.com/codepipeline/latest/userguide/pipeline-types.html)
- [CDK のブートストラップと `--trust`](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html)

### 関連アーキテクチャ
- [cicd-codecommit-cross-account](../cicd-codecommit-cross-account/) — アカウントをまたぐ、手組みの CodePipeline/CodeBuild
- [cicd-cloudfront-s3](../cicd-cloudfront-s3/) — 静的サイト配信の CI/CD パイプライン
- [ecspresso-bedrock-review](../ecspresso-bedrock-review/) — CI/CD 駆動の ECS デプロイ

## 📄 ライセンス

このプロジェクトは MIT ライセンスです。詳細は [LICENSE](../../LICENSE) を参照してください。

## 👥 コントリビュート

コントリビュートを歓迎します。詳細は [CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。

## 🏆 このリファレンスアーキテクチャについて

**対象レベル**: 300 (Intermediate)

---

**注意**: これは単一アカウントにデプロイするリファレンス実装です。本番の配信に使う前に、マルチアカウントのステージ、承認者の制御、ブランチ保護、通知を追加してください。
