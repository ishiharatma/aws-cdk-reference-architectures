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
├── scripts/sechub_parser.py  Trivy の JSON 結果を ASFF に変換（Security Hub 送信は環境変数で制御）
├── ecspresso/                ecspresso 設定（jsonnet）。cluster/service は SSM 経由で解決
├── buildspec-test.yml        Test ステージ: npm ci && npm test
├── buildspec-build.yml       Build ステージ: docker build → Trivy スキャン → ASFF変換 → ECR push
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

## Trivy スキャン結果の Security Hub 連携（ASFF変換）

`buildspec-build.yml` の Build ステージは、Trivy を JSON 出力（`--format json`）で
実行し、その結果を `scripts/sechub_parser.py` で
[AWS Security Finding Format (ASFF)](https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-findings-format.html)
に変換する（参考:
[Trivy と AWS Security Hub を使ったコンテナ脆弱性スキャン CI/CD パイプラインの構築方法](https://aws.amazon.com/jp/blogs/security/how-to-build-ci-cd-pipeline-container-vulnerability-scanning-trivy-and-aws-security-hub/)、
実装は [aws-samples/aws-security-hub-scan-with-trivy](https://github.com/aws-samples/aws-security-hub-scan-with-trivy) の
`sechub_parser.py` を、現行の Trivy JSON 構造（`Results[].Vulnerabilities[]`）向けに
書き直したもの）。

Security Hub への実送信（`BatchImportFindings`）は `SECURITYHUB_IMPORT_ENABLED`
環境変数で制御する:

- `false`（既定）: ASFF に変換した findings を標準出力にログ出力するだけで、
  Security Hub へは送信しない
- `true`: `securityhub:BatchImportFindings` で実際に送信する（100件ずつバッチ分割）

HIGH/CRITICAL の脆弱性があった場合にビルドを失敗させる判定（Trivy の
`--exit-code`）は、`SECURITYHUB_IMPORT_ENABLED` の値に関わらず常に行われる
（ASFF 変換・送信の成否とは独立している）。

## 注意: desiredCount と Application Auto Scaling

`ecs-service-def.jsonnet` は既定で `DESIRED_COUNT`（既定 `1`）を
`desiredCount` として書き込む。**対象の ECS サービスに Application Auto
Scaling を設定している場合はこのままにしないこと。** `ecspresso deploy` は
service definition の `desiredCount` を毎回 `UpdateService` にそのまま渡す
ため、固定値を書いたままだと Auto Scaling がスケールさせた台数を deploy の
たびに上書きしてしまう。`AUTO_SCALING_ENABLED=true` を渡すと
`ecs-service-def.jsonnet` は `desiredCount` フィールド自体を省略し、
ecspresso は `DesiredCount` を `UpdateService` に渡さなくなる（＝ Auto
Scaling が設定した現在値がそのまま維持される）。詳細は CDK 側 README の
「desiredCount vs. Application Auto Scaling」節、および
`ecspresso/ecs-service-def.jsonnet` 冒頭のコメントを参照。

## 注意: ecspresso verify / deploy について

本リポジトリには対応する ECS クラスタ・サービスの実体がないため、
`buildspec-deploy.yml` では AWS リソースへアクセスする `ecspresso verify` /
`ecspresso deploy` を実行せず、ローカル処理のみの `ecspresso render` で
jsonnet 定義のレンダリング結果を確認するに留めている。実クラスタが存在する
環境で使う場合は、`buildspec-deploy.yml` 内のコメントアウトされた
`ecspresso verify` / `ecspresso deploy` を有効化すること。
