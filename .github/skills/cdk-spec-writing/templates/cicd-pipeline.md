# CI/CD パイプライン 仕様書テンプレート

> このテンプレートをコピーして `.github/specs/cicd.md` に配置し、プロジェクト固有の値を埋めてください。

---

# CI/CD パイプライン 仕様

## 概要

CodeCommit + CodePipeline + CodeBuild によるクロスアカウント CI/CD 基盤を定義する。CodeCommit は prod アカウントに一元管理し、EventBridge 転送で各環境アカウントのパイプラインを起動する。

---

## AWS アカウント構成

| 環境 | アカウント | 役割 |
|------|----------|------|
| prod | `<prod-account-id>` | CodeCommit 所有 + prod パイプライン |
| dev | `<dev-account-id>` | dev パイプライン |
| stage | `<stage-account-id>` | stage パイプライン |

---

## パイプライン一覧

| パイプライン | ソース | 対象パス | デプロイ方式 |
|-------------|--------|---------|-------------|
| `<project>-<env>-infra-pipeline` | `<project>-infra` | `infra/` | なし（CI のみ） |
| `<project>-<env>-app-pipeline` | `<project>-app` | `backend-api/` | ecspresso |
| `<project>-<env>-<feature>-pipeline` | `<project>-app` | `<feature>/` | Lambda update |

---

## クロスアカウントトリガーの全体像

```text
[ prod アカウント ]
  CodeCommit → EventBridge
    ├── <project>-to-dev-rule   → dev event bus
    ├── <project>-to-stage-rule → stage event bus
    └── (prod は同一アカウントなので転送不要)

[ dev / stage アカウント ]
  event bus → パス変更検知 Lambda → CodePipeline 起動
```

---

## ブランチ・環境マッピング

| 環境 | ブランチ | EventBridge ルール |
|------|---------|-------------------|
| dev | `develop` | `<project>-to-dev-rule` |
| stage | `staging` | `<project>-to-stage-rule` |
| prod | `main` | 転送不要（同一アカウント） |

---

## パイプライン種別

### インフラ CI パイプライン

```text
[ Source ] → [ Test ]
               ├── npm ci
               ├── npm run lint
               ├── cdk synth
               └── npm test
```

- Deploy ステージなし（CDK デプロイは手動）
- パス検知: `infra/` 配下の変更のみ

### アプリ CD パイプライン（ECS）

```text
[ Source ] → [ Test ] → [ Build ] → [ Approve ] → [ Deploy ]
                          ECR push    prod のみ     ecspresso
```

- パス検知: `backend-api/` 配下の変更のみ

### Lambda CD パイプライン

```text
[ Source ] → [ Test ] → [ Build ] → [ Approve ] → [ Deploy ]
                          zip 化      prod のみ     Lambda update
```

- パス検知: `<feature>/` 配下の変更のみ
- function.json で timeout / memory / event_source を管理

---

## 手動承認ステージ

| 環境 | app | Lambda CD |
|------|-----|-----------|
| dev | 無効 | 無効 |
| stage | 無効 | 無効 |
| prod | **有効** | **有効** |

---

## パス変更検知

EventBridge → Lambda → `StartPipelineExecution` で、対象パス配下に変更がある場合のみパイプラインを起動する。

| パイプライン | 検知パス |
|-------------|---------|
| infra-pipeline | `infra/` |
| app-pipeline | `backend-api/` |
| `<feature>-pipeline` | `<feature>/` |

---

## クロスアカウントに必要なリソース

### prod アカウント（CommitStack）

| リソース | 目的 |
|---------|------|
| CodeCommit × 2 | ソースリポジトリ |
| EventBridge 転送ルール | ブランチ push を各アカウントへ転送 |
| EventBridge 転送用 IAM Role | クロスアカウント PutEvents |
| PipelineSourceRole | dev/stage が AssumeRole して CodeCommit を読む |

### dev / stage アカウント（PipelineStack）

| リソース | 目的 |
|---------|------|
| EventBus リソースポリシー | prod からの PutEvents を許可 |
| S3 アーティファクトバケット（KMS 暗号化） | パイプラインアーティファクト |
| S3 / KMS リソースポリシー | PipelineSourceRole のアクセス許可 |

---

## パラメータ設計

### 型定義

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `pipeline.app.requireManualApproval` | `boolean` | — | アプリパイプラインの手動承認 |
| `pipeline.<feature>.requireManualApproval` | `boolean` | — | Lambda パイプラインの手動承認 |
| `pipeline.notificationTopicArn` | `string` | — | 失敗通知 SNS トピック ARN |

### 共通パラメータ（shared-params.ts）

| パラメータ | 説明 |
|-----------|------|
| `codecommitAccountId` | CodeCommit 所有アカウント ID |
| `forwardTargets` | EventBridge 転送先一覧 |
| `existingInfraRepoArn` | 既存リポジトリ ARN（未指定時は新規作成） |
| `existingAppRepoArn` | 既存リポジトリ ARN（未指定時は新規作成） |

---

## 受け入れ基準（テスト観点）

### Fine-grained assertions

- [ ] 各パイプラインが正しいステージ構成で作成される
- [ ] prod のみ Approve ステージが存在する
- [ ] Source Action のブランチが環境に対応している
- [ ] S3 アーティファクトバケットに KMS 暗号化が設定されている
- [ ] CommitStack は CodeCommit 所有アカウントのみで作成される

### バリデーションテスト

- [ ] `codecommitAccountId` 未設定時に PipelineStack が作成されない

---

## 未確定事項・TODO

| 項目 | 暫定値 | 確認先 |
|------|--------|--------|
| prod アカウント ID | — | インフラ担当 |
| dev アカウント ID | — | インフラ担当 |
| stage アカウント ID | — | インフラ担当 |
| 既存 CodeCommit リポジトリ ARN | — | インフラ担当 |
| SNS 通知先 | — | 運用担当 |
