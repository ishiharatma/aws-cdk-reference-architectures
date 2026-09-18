# Ecspresso-Bedrock-Review — Amazon Bedrock によるAgentic Code Reviewを組み込んだ ECS Fargate CI/CD

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## 概要

OpenAI 社内の "agentic software factory" 図にある、並列の専門エージェントによる
コードレビュー + リスク分類のステップに着想を得た、**Amazon Bedrock による
Agentic Code Review ゲートを組み込んだ ECS Fargate 向け CodePipeline CI/CD**
のリファレンス実装。疑似マルチエージェント（観点ごとに4回の Bedrock 呼び出し
を並列実行）が push ごとの `git diff` を検査し、集約したリスクレベルが高い
場合にパイプラインを止める。

サンプルアプリケーションは [ecspresso](https://github.com/kayac/ecspresso) +
**jsonnet** のタスク/サービス定義でデプロイする構成。**このワークスペースには
対応する ECS クラスタ/サービスの実体がない**ため、Deploy ステージは
`ecspresso render`（AWS API を呼ばないローカル処理）までに留め、
`ecspresso verify` / `ecspresso deploy` は実行しない。

### このサンプルが示すもの

- `git diff` を対象にした **Agentic Code Review** ステージ（Amazon Bedrock）:
  security / infra / quality / cost の4観点を並列（`Promise.all`）でレビュー
  し、それぞれ JSON でリスク判定を返す。最も高いリスクレベルを採用する
- **ブロッキングゲート**: 集約リスクレベルが `RISK_THRESHOLD`（既定 `high`）
  以上になると CodeBuild が非ゼロ終了してパイプラインを停止する（図の
  「リスク分類」分岐に対応）
- **モデルの差し替え**: レビューに使う Bedrock モデル ID は CodeBuild の環境
  変数（`BEDROCK_MODEL_ID`、`EnvParams.bedrockModelId` 由来）で切り替わる。
  モデルを変えてもコード変更は不要
- **ecspresso + jsonnet** のデプロイ定義（`ecspresso.jsonnet`,
  `ecs-task-def.jsonnet`, `ecs-service-def.jsonnet`）。ECS クラスタ/サービス
  名はビルド時に SSM Parameter Store から解決する（`std.native('env')` /
  `must_env()`）
- `buildspec-test.yml` / `buildspec-build.yml` / `buildspec-review.yml` /
  `buildspec-deploy.yml` をサンプルアプリ側
  （`backend/ecspresso-bedrock-review-app/`）に配置し、パイプラインの各
  ステージが1ファイルずつ対応する

## アーキテクチャ概要

```text
Source(CodeCommit) ─▶ Test ─▶ Build ─▶ AgenticReview(Bedrock) ─▶ [Approve*] ─▶ Deploy(ecspresso)
                                              │
                                              ├─ security  ─┐
                                              ├─ infra      ─┤  Promise.all → 集約
                                              ├─ quality    ─┤  (最も高いriskLevelを採用)
                                              └─ cost       ─┘
                                              risk >= RISK_THRESHOLD ⇒ CodeBuild失敗（ブロッキング）
```

`*` Approve ステージは `EnvParams.requireManualApproval` が `true` の場合のみ挿入される。

### 主要コンポーネント

| コンポーネント | 設計ポイント |
| --------- | ------------- |
| CodeCommit リポジトリ（`RepositoryStack`） | `backend/ecspresso-bedrock-review-app/` の内容を `develop` ブランチへシード |
| Test / Build CodeBuild | `npm test`；`docker build` → Trivy スキャン（JSON出力、HIGH/CRITICAL で `--exit-code 1`、ブロッキング）→ ASFF変換（`scripts/sechub_parser.py`）→ ECR push（`imagedefinitions.json`, `image-tag.txt`） |
| AgenticReview CodeBuild | `CodeCommitSourceAction` はスナップショットしか渡さないため、CodeCommit を履歴付きで再 clone して `git diff` を計算し、`scripts/agentic-review.js` で Bedrock をレビューする |
| Deploy CodeBuild | SSM から ECS クラスタ/サービス/ロール/ネットワーク設定を解決した上で `ecspresso render` のみ実行（`verify`/`deploy` は未実施。理由は下記） |
| SSM パラメータ（`/<project>/<env>/ecs/*`） | `PipelineStack` がプレースホルダー（`REPLACE_ME`）として作成。実クラスタに接続する場合は実値で上書きする |

## `ecspresso verify` / `ecspresso deploy` を実行しない理由

このワークスペースには対応する ECS クラスタ/サービスのスタックがないため、
`buildspec-deploy.yml` では `ecspresso render <config|task-def|service-def>`
（AWS API を一切呼ばないローカル処理で、jsonnet 定義が正しくレンダリング
されるかを確認するだけ）のみを実行する。`ecspresso verify`（クラスタ/ロール/
イメージ/ロググループの存在確認）と `ecspresso deploy`（タスク定義登録 +
サービス更新）はどちらも実在しないリソースに対して AWS API を呼び出すため、
コメントアウトしている。実 ECS クラスタに接続する場合は
`buildspec-deploy.yml` 内のコメントを外すこと。

## Trivy の検出結果 → Security Hub（ASFF変換、環境変数でゲート）

`buildspec-build.yml` は Trivy を `--format json` で実行し、その結果を
`scripts/sechub_parser.py` で
[AWS Security Finding Format (ASFF)](https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-findings-format.html)
に変換する。実装は AWS Security Blog の
[「Trivy と AWS Security Hub を使ったコンテナ脆弱性スキャン CI/CD パイプラインの構築方法」](https://aws.amazon.com/jp/blogs/security/how-to-build-ci-cd-pipeline-container-vulnerability-scanning-trivy-and-aws-security-hub/)
とそのリファレンススクリプト
[`aws-samples/aws-security-hub-scan-with-trivy`](https://github.com/aws-samples/aws-security-hub-scan-with-trivy)
の `sechub_parser.py` を、現行の Trivy JSON 構造（`Results[].Vulnerabilities[]`）
向けに書き直したもの。

変換した findings を実際に Security Hub へ送信するかどうかは
`EnvParams.securityHubImportEnabled`（`SECURITYHUB_IMPORT_ENABLED` 環境変数）
で制御する:

- `false`（既定）: ASFF に変換して標準出力にログ出力するだけで、Security Hub
  へは送信しない
- `true`: `securityhub:BatchImportFindings` で実送信する（100件ずつバッチ分割）

このトグルは、上記の HIGH/CRITICAL によるビルドブロッキング判定とは独立して
おり、`SECURITYHUB_IMPORT_ENABLED` の値に関わらず Trivy の `--exit-code` に
よるビルド失敗は常に発生する。

## Bedrock レビューモデルの切り替え

`parameters/dev-params.ts` を編集する（または synth 時に `BEDROCK_MODEL_ID`
環境変数で上書きする）。

```typescript
// parameters/dev-params.ts
bedrockModelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
riskThreshold: 'high', // low | medium | high | critical — パイプラインを止める最小リスクレベル
```

この値はそのまま `AgenticReview` CodeBuild プロジェクトの `BEDROCK_MODEL_ID`
環境変数として渡される。別モデル（クロスリージョン推論プロファイル ID など）
を試す際もコード変更は不要。

## 前提条件

- `bedrockModelId` に設定するモデルへの Amazon Bedrock アクセスが有効な AWS アカウント
- AWS CLI v2.x
- Node.js 20.x 以降
- AWS CDK 2.x

### 必要な IAM 権限

デプロイ実行者には以下の作成・管理権限が必要: CodeCommit, CodePipeline,
CodeBuild, ECR, IAM, S3（アーティファクトバケット）, SSM Parameter Store,
SNS, EventBridge。

## デプロイ手順

```bash
export PROJECT=myproject
export ENV=dev
npm run bootstrap -w workspaces/ecspresso-bedrock-review    # 初回のみ
npm run stage:deploy:all -w workspaces/ecspresso-bedrock-review -- --project=$PROJECT --env=dev
```

### パイプラインを動かす

```bash
# repositoryName は "ecspresso-bedrock-review-app"（parameters/shared-params.ts の既定値）
git clone codecommit::ap-northeast-1://ecspresso-bedrock-review-app
cd ecspresso-bedrock-review-app
git checkout develop
git commit --allow-empty -m "trigger pipeline"
git push origin develop
```

## テスト戦略

```
test/
├── compliance/
│   └── cdk-nag.test.ts          # AwsSolutionsChecks（サプレッション理由を明記）
├── snapshot/
│   └── snapshot.test.ts         # RepositoryStack + PipelineStack のテンプレートスナップショット
└── unit/
    ├── repository-stack.test.ts
    └── pipeline-stack.test.ts   # ステージ順序、AgenticReviewの環境変数/IAM、Approveの有無
```

```bash
npm test -w workspaces/ecspresso-bedrock-review
```

サンプルアプリ自体にもテストがある:

```bash
cd backend/ecspresso-bedrock-review-app
npm test
```

## セキュリティ上の考慮事項

- ✅ `Build` の Trivy スキャンは HIGH/CRITICAL の脆弱性を検知すると
  （`--exit-code 1`）ECR への push をブロックする
- ✅ Security Hub への送信は `securityHubImportEnabled` が明示的に `true`
  の場合のみ発生する。既定ではパイプラインが `BatchImportFindings` を呼ぶ
  ことはなく、変換した ASFF をログ出力するだけ
- ✅ `AgenticReview` の CodeBuild ロールは、対象リポジトリ ARN に対する
  `codecommit:GitPull` と、このリージョンの foundation-model /
  inference-profile ARN に対する `bedrock:InvokeModel` のみに絞っている
- ✅ `Deploy` の CodeBuild ロールは、自プロジェクト/環境の SSM パス
  （`/${project}/${env}/ecs/*`）に対する `ssm:GetParameter` のみ許可
- ✅ アーティファクトバケットはパブリックアクセスを全ブロックし SSL を強制。
  SNS 通知トピックも SSL を強制（`enforceSSL: true`）
- ✅ `test/compliance/` で `AwsSolutionsChecks`（CDK Nag）を実行し、残る
  ワイルドカード/マネージドポリシーの指摘はすべて理由を明記して抑制
  （`lib/stacks/pipeline-stack.ts` 参照）
- ⚠️ モデルによるレビューは「ゲート」であって人間のレビューの代替ではない。
  見落としや誤判定があり得るため、重要な環境では `requireManualApproval:
  true` を必ず前段に置くこと。

## カスタマイズ

### 実 ECS クラスタに接続する

1. 自前の ECS/VPC スタックをデプロイし、クラスタ名・サービス名・タスク/実行
   ロール ARN・サブネット ID・セキュリティグループ ID・（あれば）ターゲット
   グループ ARN を控える。
2. `PipelineStack` が作成する SSM パラメータ（`/${project}/${env}/ecs/*`）を
   実値で上書きする。または `lib/stacks/pipeline-stack.ts` のプレースホルダー
   `ssm.StringParameter` ブロックを削除し、ECS スタック側で管理する。
3. `ecspresso verify`/`deploy` に必要な `ecspresso:*`, `iam:PassRole`,
   `ecr:Describe*`, `elasticloadbalancing:Describe*` 等の権限を
   `DeployProject` に追加する（権限一式は本リポジトリの
   `infrastructure/common/constructs/cicd/ecs-fargate-cicd.ts` を参照）。
4. `backend/ecspresso-bedrock-review-app/buildspec-deploy.yml` 内の
   `ecspresso verify` / `ecspresso deploy` のコメントを外す。

### 手動承認を有効にする

```typescript
// parameters/dev-params.ts
requireManualApproval: true,
approvalTopicArn: 'arn:aws:sns:ap-northeast-1:111111111111:ecspresso-bedrock-review-dev-approvals',
```

### Security Hub へのインポートを有効にする

```typescript
// parameters/dev-params.ts
securityHubImportEnabled: true, // または process.env.SECURITYHUB_IMPORT_ENABLED === 'true'
```

実際に Security Hub に findings を表示させるには、事前に（アカウント/
リージョンごとに1回）以下も実行しておく:

```bash
aws securityhub enable-import-findings-for-product \
  --product-arn arn:aws:securityhub:ap-northeast-1::product/aquasecurity/aquasecurity
```

### レビュー観点の調整

`backend/ecspresso-bedrock-review-app/scripts/agentic-review.js` の
`PERSPECTIVES` 配列を編集し、レビュー観点（既定: security/infra/quality/
cost）の追加・削除・文言変更を行う。

## 参考リンク

### AWS ドキュメント
- [AWS CodePipeline User Guide](https://docs.aws.amazon.com/codepipeline/latest/userguide/welcome.html)
- [AWS CodeBuild User Guide](https://docs.aws.amazon.com/codebuild/latest/userguide/welcome.html)
- [Amazon Bedrock Runtime — Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
- [Trivy と AWS Security Hub を使ったコンテナ脆弱性スキャン CI/CD パイプラインの構築方法](https://aws.amazon.com/jp/blogs/security/how-to-build-ci-cd-pipeline-container-vulnerability-scanning-trivy-and-aws-security-hub/)
- [AWS Security Finding Format (ASFF) syntax](https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-findings-format-syntax.html)

### 関連ツール
- [ecspresso](https://github.com/kayac/ecspresso) — ECS デプロイツール
- [go-jsonnet](https://github.com/google/go-jsonnet) — ecspresso が使う jsonnet 実装
- [aws-samples/aws-security-hub-scan-with-trivy](https://github.com/aws-samples/aws-security-hub-scan-with-trivy) — 本ワークスペースの `sechub_parser.py` の元にしたリファレンス実装

### 関連アーキテクチャ
- [`cicd-codecommit-cross-account`](../cicd-codecommit-cross-account/) — 本ワークスペースの土台にした CodeCommit → CodePipeline の雛形
- `infrastructure/common/constructs/cicd/ecs-fargate-cicd.ts` — 実クラスタ向け `ecspresso verify`/`deploy` の完全な IAM 権限セット

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](../../../LICENSE) file for details.

## 👥 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](../../../docs/contribution/CONTRIBUTING.md) for details.

---

**注記**: これは実 ECS クラスタを持たないリファレンス実装です。本番投入前
に、要件と組織のポリシーに沿ってレビュー・カスタマイズを行ってください。
