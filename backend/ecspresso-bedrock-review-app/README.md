# ecspresso-bedrock-review-app

ECS Fargate 上で動かす Node.js サンプル API。`example-nodejs-api` をベースに、
CodePipeline から呼び出す buildspec 一式と、Amazon Bedrock による Agentic Code
Review 用のスクリプト、ecspresso（jsonnet）のデプロイ定義を追加したもの。

対応する CDK パイプライン定義は
[`infrastructure/workspaces/ecspresso-bedrock-review`](../../infrastructure/workspaces/ecspresso-bedrock-review)
を参照。

## ディレクトリ構成

```
.
├── src/                      アプリ本体（Express）
├── scripts/agentic-review.js Bedrock を使った疑似マルチエージェント・コードレビュー
├── ecspresso/                ecspresso 設定（jsonnet）。cluster/service は SSM 経由で解決
├── buildspec-test.yml        Test ステージ: npm ci && npm test
├── buildspec-build.yml       Build ステージ: docker build → Trivy スキャン(HIGH/CRITICAL でブロッキング) → ECR push
├── buildspec-review.yml      Agentic Review ステージ: git diff を Bedrock でレビュー
└── buildspec-deploy.yml      Deploy ステージ: ecspresso render（verify/deploy は未実施）
```

## パイプラインの流れ

```
Source(CodeCommit) → Test → Build → AgenticReview(Bedrock) → [Approve*] → Deploy(ecspresso)
```

`AgenticReview` ステージは `scripts/agentic-review.js` が算出した総合リスクレベルが
`RISK_THRESHOLD`（既定 `high`）以上の場合、CodeBuild を失敗させてパイプラインを止める
（ブロッキング）。

## Bedrock モデルの切り替え

Agentic Review が使うモデルは CodeBuild 環境変数 `BEDROCK_MODEL_ID` で切り替える
（CDK Construct のプロパティ経由でステージごとに指定）。コードの変更は不要。

## 注意: ecspresso verify / deploy について

本リポジトリには対応する ECS クラスタ・サービスの実体がないため、
`buildspec-deploy.yml` では AWS リソースへアクセスする `ecspresso verify` /
`ecspresso deploy` を実行せず、ローカル処理のみの `ecspresso render` で
jsonnet 定義のレンダリング結果を確認するに留めている。実クラスタが存在する
環境で使う場合は、`buildspec-deploy.yml` 内のコメントアウトされた
`ecspresso verify` / `ecspresso deploy` を有効化すること。
