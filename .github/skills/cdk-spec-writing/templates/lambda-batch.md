# Lambda バッチ処理 仕様書テンプレート

> このテンプレートをコピーして `.github/specs/<feature>.md` に配置し、プロジェクト固有の値を埋めてください。
> SQS トリガー型（非同期ログ処理等）と EventBridge スケジュール型（定時バッチ等）の両方に対応。

---

# Lambda バッチ処理 仕様

## 概要

（1〜3 文で機能の目的を記述。例:）
- SQS キューに蓄積されたメッセージを Lambda で処理し、Firehose 経由で S3 に永続化する
- EventBridge スケジュールで定時起動し、S3 バケット間のファイル加工・転送を行う

---

## インフラとアプリの責務分離

### CDK 管理（インフラチーム）

| リソース | 責務 |
|----------|------|
| IAM Role（Lambda 実行ロール） | Lambda が必要とする AWS サービスへのアクセス権限 |
| SQS Queue + DLQ | メッセージバッファリング（SQS トリガー型の場合） |
| S3 バケット | 入出力データの保管 |
| Kinesis Data Firehose | ストリーミング書き出し（必要な場合） |
| Parameter Store | インフラ情報をアプリパイプラインへ公開 |

### アプリパイプライン管理（アプリチーム・CDK 管理外）

| リソース | 責務 |
|----------|------|
| Lambda 関数 | ビジネスロジックの実行 |
| Lambda Layer | 共通ライブラリ（Powertools 等） |
| Event Source Mapping | SQS → Lambda トリガー設定 |
| EventBridge Rule | スケジュール起動設定 |

### 分離の理由

- Lambda コードの更新頻度はインフラより高い（CDK デプロイ不要にする）
- timeout / memory / log_level をアプリチームが自律的に管理できる
- function.json で関数ごとの設定を宣言的に管理する

---

## 対象 AWS リソース

### CDK 管理リソース

| リソース | 命名規則 | 備考 |
|----------|---------|------|
| IAM Role | `<project>-<env>-<feature>-role` | Lambda 実行ロール |
| SQS Queue | `<project>-<env>-<feature>-queue` | SQS トリガー型の場合 |
| SQS DLQ | `<project>-<env>-<feature>-dlq` | 処理失敗メッセージの退避 |
| S3 バケット | `<project>-<env>-<purpose>-<accountId>-<regionShort>` | 入出力データ |
| Firehose | `<project>-<env>-<feature>-stream` | ストリーミング型の場合 |

### アプリパイプライン管理リソース（CDK 管理外）

| リソース | 命名規則 | 備考 |
|----------|---------|------|
| Lambda 関数 | `<project>-<env>-<feature>-<functionName>` | buildspec で作成/更新 |
| Lambda Layer | `<project>-<env>-<feature>-common` | 共通ライブラリ |
| Event Source Mapping | — | SQS → Lambda（buildspec で設定） |
| EventBridge Rule | `<functionName>-schedule` | スケジュール起動（buildspec で設定） |

---

## ユースケース / フロー

### SQS トリガー型（非同期処理）

```text
[ 上流システム ] → SQS Queue → Lambda → [ 下流システム / S3 / Firehose ]
                      ↓ (失敗時)
                   SQS DLQ
```

### EventBridge スケジュール型（定時バッチ）

```text
EventBridge (cron) → Lambda → [ S3 入力バケット → 加工 → S3 出力バケット ]
```

---

## function.json 設計

各 Lambda 関数のディレクトリに配置し、関数ごとの設定を宣言する。

### SQS トリガー型

```json
{
  "timeout": 30,
  "memory": 128,
  "log_level": "INFO",
  "event_source": {
    "type": "sqs",
    "ssm_arn_key": "/${PROJECT}/${ENV}/<feature>/sqs-queue-arn",
    "batch_size": 10,
    "batching_window_seconds": 5
  }
}
```

### EventBridge スケジュール型

```json
{
  "timeout": 60,
  "memory": 256,
  "event_source": {
    "type": "eventbridge",
    "schedule": "cron(0 * * * ? *)"
  }
}
```

### トリガーなし（ヘルスチェック等）

```json
{
  "timeout": 10,
  "memory": 128,
  "event_source": {
    "type": "none"
  }
}
```

### フィールド仕様

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `timeout` | number | ✅ | タイムアウト（秒）。CDK 上限ガード以下 |
| `memory` | number | ✅ | メモリ（MB）。CDK 上限ガード以下 |
| `log_level` | string | — | ログレベル（省略時は CDK デフォルト値） |
| `event_source.type` | string | ✅ | `sqs` / `eventbridge` / `none` |
| `event_source.ssm_arn_key` | string | ※ | ESM ソース ARN の SSM キー（type=sqs 時） |
| `event_source.batch_size` | number | — | ESM バッチサイズ（デフォルト: 10） |
| `event_source.schedule` | string | ※ | cron 式（type=eventbridge 時） |

---

## パラメータ設計

### 型定義

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `lambdaMemoryMaxMb` | `number` | ✅ | Lambda メモリ上限（CDK 上限ガード） |
| `lambdaTimeoutMaxSec` | `number` | ✅ | Lambda タイムアウト上限（CDK 上限ガード） |
| `lambdaLogLevel` | `string` | — | デフォルトログレベル |
| `lambdaLogRetentionDays` | `number` | — | CW Logs 保持日数 |

> CDK パラメータは「上限ガード」として機能する。実際の値は function.json で管理し、
> buildspec-deploy で 2 段階バリデーション（Lambda 制限 + CDK 上限）を実行する。

### 環境別パラメータ例

| 設定項目 | dev | stage | prod |
|---------|-----|-------|------|
| メモリ上限 | 256 MB | 256 MB | 512 MB |
| タイムアウト上限 | 60 秒 | 120 秒 | 120 秒 |
| ログレベル | DEBUG | INFO | INFO |
| ログ保持 | 14 日 | 30 日 | 90 日 |

---

## Parameter Store キー設計

| SSM キー | 出力元 | 参照先 |
|---------|--------|--------|
| `/<project>/<env>/<feature>/role-arn` | Construct | buildspec（create-function --role） |
| `/<project>/<env>/<feature>/function-name` | Construct | buildspec（関数名プレフィックス） |
| `/<project>/<env>/<feature>/sqs-queue-arn` | Construct | buildspec（ESM event-source-arn） |
| `/<project>/<env>/<feature>/sqs-queue-url` | Construct | Lambda 環境変数 |

> 機能に応じて追加キーを定義する（S3 バケット名、Firehose ストリーム名等）。

---

## CDK 実装ガイドライン

### Construct の責務

- Lambda 関数リソースは作成しない
- IAM Role + 周辺リソース + SSM 出力のみ
- Lambda への EventBridge 呼び出し許可（`addPermission` 相当）は CDK が付与

### 初回デプロイの順序

```text
1. CDK デプロイ（IAM Role / SQS / S3 等を作成）
2. アプリパイプライン実行（Lambda 関数を作成 + ESM / EventBridge 設定）
```

---

## 受け入れ基準（テスト観点）

### Fine-grained assertions

- [ ] IAM Role が作成され、必要最小限の権限のみ付与される
- [ ] SQS Queue + DLQ が作成される（SQS トリガー型の場合）
- [ ] SSM Parameter が全キー出力される
- [ ] Lambda 関数リソースが CDK で作成されない
- [ ] EventBridge Rule が CDK で作成されない（アプリパイプライン管理）

### バリデーションテスト

- [ ] `lambdaMemoryMaxMb` が 128〜10240 の範囲外でエラーになる
- [ ] `lambdaTimeoutMaxSec` が 1〜900 の範囲外でエラーになる
- [ ] SQS 可視性タイムアウト > Lambda タイムアウト上限であること

### Compliance tests (cdk-nag)

- [ ] SQS に暗号化が設定されている
- [ ] S3 バケットにパブリックアクセスブロックが設定されている
- [ ] IAM ポリシーにワイルドカード `*` がない（正当な例外を除く）

---

## ディレクトリ構成

```text
app/<feature>/
├── buildspec-test.yml
├── buildspec-build.yml
├── buildspec-deploy.yml
└── src/
    ├── layer/common/
    │   └── requirements.txt
    └── functions/
        ├── <function-a>/
        │   ├── index.py
        │   └── function.json
        └── <function-b>/
            ├── index.py
            └── function.json
```

---

## 未確定事項・TODO

| 項目 | 暫定値 | 確認先 |
|------|--------|--------|
| Lambda メモリ上限（prod） | 512 MB | アプリ担当 |
| Lambda タイムアウト上限（prod） | 120 秒 | アプリ担当 |
| SQS メッセージ保持期間 | 7 日 | アプリ担当 |
| EventBridge スケジュール | `cron(0 * * * ? *)` | アプリ担当 |
