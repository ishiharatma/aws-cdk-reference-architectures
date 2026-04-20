---
name: cdk-spec-writing
description: CDK インフラプロジェクトの仕様書（Spec）を作成するためのガイド。「仕様書を書いて」「spec を作成して」「機能の設計をドキュメント化して」などと言われたときに使用する。仕様駆動開発（Spec-Driven Development）のテンプレートとガイドラインを提供する。
---

# CDK インフラ仕様書作成ガイド

仕様書（Spec）を先に書き、それに基づいて実装・テストを行う「仕様駆動開発」のためのガイド。

---

## 1. 仕様駆動開発の流れ

```text
1. Spec 作成   → .github/specs/<feature>.md
2. 型定義      → lib/types/<feature>.types.ts（Spec のパラメータ表から生成）
3. Construct   → lib/constructs/<feature>-construct.ts（Spec の CDK 実装方針に従う）
4. テスト      → test/unit/<feature>-construct.test.ts（Spec の受け入れ基準から生成）
5. パラメータ  → parameters/<env>-params.ts（Spec の環境別差異から設定）
```

### Spec を先に書くメリット

- 実装前に設計レビューができる
- 受け入れ基準が明確になり、テストコードを自動生成しやすい
- AI（Copilot 等）に Spec を読ませることで、仕様に沿った実装を生成できる
- 実装後の仕様との乖離を防げる

---

## 2. Spec ファイルの配置

```text
.github/specs/
├── index.md                    # 仕様書一覧・概要
├── ecs-backend-api.md          # ECS Fargate Backend API
├── lambda-batch.md             # Lambda バッチ処理
├── vpc.md                      # VPC / ネットワーク
├── cicd.md                     # CI/CD パイプライン
└── <feature>.md                # 追加機能
```

---

## 3. Spec の共通セクション構成

すべての Spec は以下のセクション構成に従う。機能によって不要なセクションは省略可。

```markdown
# <機能名> 仕様

## 概要
（1〜3 文で機能の目的と設計方針を記述）

## インフラとアプリの責務分離
（CDK が管理するもの / アプリパイプラインが管理するものを明確に分離）

## 対象 AWS リソース
（CDK 管理 / アプリ管理それぞれのリソース一覧表）

## ユースケース / フロー
（ASCII 図 or Mermaid でデータフロー・処理フローを図示）

## インターフェース定義
（入出力のデータ形式・プロトコル・ポート等）

## パラメータ設計
（TypeScript 型定義 + 環境別パラメータ例）

## 環境別差異
（dev / stage / prod の設定値比較表）

## CDK 実装ガイドライン
（Construct の責務・SSM 出力キー・実装上の注意点）

## Parameter Store キー設計
（CDK が出力する SSM キーの一覧と参照先）

## 受け入れ基準（テスト観点）
（Fine-grained assertions / バリデーション / Compliance の具体的なチェック項目）

## 未確定事項・TODO
（暫定値・確認待ち事項を明示）
```

---

## 4. 機能別テンプレート

### 4.1 ECS Fargate Backend API

`templates/ecs-backend-api.md` を参照。

主要セクション:
- ALB + WAF + ECS Cluster の構成
- CDK / ecspresso の責務分担
- Auto Scaling 設計
- セキュリティ（SG / IAM Role 分離）
- SSM キー設計（ecspresso が参照）

### 4.2 Lambda バッチ処理

`templates/lambda-batch.md` を参照。

主要セクション:
- CDK 管理リソース（IAM Role / SQS / S3 等）とアプリ管理リソース（Lambda 関数）の分離
- function.json による関数設定管理
- イベントソース設計（SQS トリガー / EventBridge スケジュール / なし）
- buildspec によるデプロイフロー

### 4.3 VPC / ネットワーク

`templates/vpc-network.md` を参照。

主要セクション:
- アウトバウンド通信方式の切り替え（TransitGateway / NAT Gateway / NAT Instance）
- サブネット構成
- VPC エンドポイント

### 4.4 CI/CD パイプライン

`templates/cicd-pipeline.md` を参照。

主要セクション:
- クロスアカウント構成（CodeCommit + EventBridge 転送）
- パイプライン種別（インフラ CI / アプリ CD / Lambda CD）
- パス変更検知
- 手動承認ステージ

---

## 5. 受け入れ基準の書き方

受け入れ基準はテストコードに直接変換できる粒度で記述する。

### Fine-grained assertions（ユニットテスト）

```markdown
- [ ] ECS Cluster が 1 つ作成される
- [ ] TaskExecutionRole に `AmazonECSTaskExecutionRolePolicy` が付与される
- [ ] TaskRole に `sqs:SendMessage` のみ許可される（対象キュー ARN を限定）
- [ ] SSM Parameter `/<project>/<env>/ecs/cluster-arn` が出力される
- [ ] ECS TaskDefinition は CDK で作成されない（ecspresso 管理）
```

### バリデーションテスト

```markdown
- [ ] Fargate 有効な CPU/メモリ組み合わせ以外でエラーになる
- [ ] ecsMinTaskCount > ecsMaxTaskCount でエラーになる
- [ ] CIDR 形式が不正な場合にエラーになる
```

### Compliance tests（cdk-nag）

```markdown
- [ ] S3 バケットに暗号化が設定されている
- [ ] IAM ポリシーにワイルドカード `*` が含まれていない（正当な例外を除く）
- [ ] SG のインバウンドに 0.0.0.0/0 が含まれていない
```

---

## 6. パラメータ設計表の書き方

Spec のパラメータ設計表は、そのまま TypeScript 型定義に変換できる形式で記述する。

```markdown
### 型定義

| パラメータ | 型 | 必須 | 説明 | 例 |
|-----------|-----|------|------|-----|
| `ecsTaskCpu` | `number` | ✅ | ECS タスク CPU ユニット | `256` / `512` / `1024` |
| `ecsTaskMemory` | `number` | ✅ | ECS タスクメモリ (MB) | `512` / `1024` / `2048` |
| `enableAutoScaling` | `boolean` | — | Auto Scaling 有効化 | `false`（デフォルト） |
| `ecsNightlySchedule` | `EcsNightlySchedule` | — | 夜間停止スケジュール | dev/stage のみ |

### 環境別パラメータ例

| 設定項目 | dev | stage | prod |
|---------|-----|-------|------|
| CPU | 256 | 512 | 1024 |
| メモリ | 512 MB | 1024 MB | 2048 MB |
| Auto Scaling | 無効 | 無効 | 有効 |
```

→ これを以下の型定義に変換:

```typescript
export interface ApiParams {
  readonly ecsTaskCpu: number;
  readonly ecsTaskMemory: number;
  readonly enableAutoScaling?: boolean;
  readonly ecsNightlySchedule?: EcsNightlySchedule;
}
```

---

## 7. 未確定事項の管理

Spec 内の未確定事項は `TODO` コメントと未確定事項テーブルで明示する。

```markdown
## 未確定事項・TODO

| 項目 | 暫定値 | 確認先 | 期限 |
|------|--------|--------|------|
| VPC CIDR | `10.0.0.0/16` | ネットワーク担当 | — |
| ECS CPU/メモリ（prod） | 1024 / 2048 | アプリ担当 | — |
| ALB ヘルスチェックパス | `/health` | アプリ担当 | — |
```

パラメータファイルにも `// TODO:` コメントを残す:

```typescript
ecsTaskCpu: 1024, // TODO: アプリ担当と本番スペックを合意する
```

---

## 8. Spec レビューチェックリスト

Spec 作成後、実装に入る前に以下を確認する。

- [ ] 概要が 1〜3 文で機能の目的を説明している
- [ ] CDK 管理 / アプリ管理の責務分離が明確
- [ ] 対象 AWS リソース一覧に漏れがない
- [ ] フロー図（ASCII or Mermaid）がある
- [ ] パラメータ型定義表がある
- [ ] 環境別差異テーブルがある
- [ ] SSM Parameter Store キー一覧がある
- [ ] 受け入れ基準が具体的（テストコードに変換可能な粒度）
- [ ] 未確定事項が TODO テーブルに整理されている
- [ ] プロジェクト固有の情報（アカウント ID 等）が暫定値 + TODO で管理されている

---

## リファレンス一覧

| ファイル | 内容 |
|---------|------|
| `templates/ecs-backend-api.md` | ECS Fargate Backend API 仕様書テンプレート |
| `templates/lambda-batch.md` | Lambda バッチ処理 仕様書テンプレート |
| `templates/vpc-network.md` | VPC / ネットワーク 仕様書テンプレート |
| `templates/cicd-pipeline.md` | CI/CD パイプライン 仕様書テンプレート |
