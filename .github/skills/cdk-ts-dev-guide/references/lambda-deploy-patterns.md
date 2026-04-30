# CDK + アプリパイプラインによる Lambda デプロイパターン

CDK は Lambda 関数自体を作成せず、IAM Role・SQS・Firehose 等の周辺リソースのみ管理する。
Lambda の作成・更新はアプリリポジトリの CodePipeline（buildspec）が担う。

---

## 1. 責務分担

| 責務 | 管理者 |
|------|--------|
| IAM Role（Lambda 実行ロール） | CDK |
| SQS / Firehose / S3 等の周辺リソース | CDK |
| SSM Parameter Store 出力（Role ARN・Queue URL 等） | CDK |
| Lambda 関数の作成・コード更新 | アプリパイプライン（buildspec） |
| Lambda Layer の発行 | アプリパイプライン（buildspec） |
| Event Source Mapping（SQS → Lambda） | アプリパイプライン（buildspec） |
| EventBridge スケジュールルール | アプリパイプライン（buildspec） |

### CDK が Lambda を作成しない理由

- Lambda のコードとインフラの変更サイクルが異なる
- アプリチームが timeout / memory / log_level を自律的に管理できる
- CDK で Lambda を作成すると、コード更新のたびに CDK デプロイが必要になる

---

## 2. CDK 側の実装

### 周辺リソース + IAM Role + SSM 出力

```typescript
export class SqsLambdaConstruct extends Construct {
  public readonly queue: sqs.IQueue;
  public readonly lambdaRole: iam.IRole;

  constructor(scope: Construct, id: string, props: SqsLambdaConstructProps) {
    super(scope, id);

    // SQS Queue + DLQ
    const dlq = new sqs.Queue(this, 'Dlq', { ... });
    this.queue = new sqs.Queue(this, 'Queue', {
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // Firehose
    const firehose = new CfnDeliveryStream(this, 'Firehose', { ... });

    // Lambda 実行ロール（CDK が作成、Lambda 関数はアプリが作成）
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    // SQS 受信権限
    this.queue.grantConsumeMessages(lambdaRole);
    // Firehose 書き込み権限
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
      resources: [firehose.attrArn],
    }));

    // SSM 出力（アプリパイプラインが参照）
    new ssm.StringParameter(this, 'RoleArn', {
      parameterName: `/${project}/${env}/my-service/role-arn`,
      stringValue: lambdaRole.roleArn,
    });
    new ssm.StringParameter(this, 'QueueArn', {
      parameterName: `/${project}/${env}/my-service/sqs-queue-arn`,
      stringValue: this.queue.queueArn,
    });
    new ssm.StringParameter(this, 'QueueUrl', {
      parameterName: `/${project}/${env}/my-service/sqs-queue-url`,
      stringValue: this.queue.queueUrl,
    });
  }
}
```

---

## 3. function.json（関数ごとの設定ファイル）

各 Lambda 関数のディレクトリに配置し、timeout / memory / event_source を宣言する。

```json
{
  "timeout": 30,
  "memory": 128,
  "log_level": "INFO",
  "event_source": {
    "type": "sqs",
    "ssm_arn_key": "/${PROJECT}/${ENV}/my-service/sqs-queue-arn",
    "batch_size": 10,
    "batching_window_seconds": 5
  }
}
```

| フィールド | 説明 |
|-----------|------|
| `timeout` | Lambda タイムアウト（秒）。CDK 上限ガード以下であること |
| `memory` | Lambda メモリ（MB）。CDK 上限ガード以下であること |
| `log_level` | ログレベル（省略時は CDK パラメータのデフォルト値） |
| `event_source.type` | `sqs` / `eventbridge` / `none` |
| `event_source.ssm_arn_key` | ESM のソース ARN を取得する SSM キー |
| `event_source.schedule` | EventBridge cron 式（type=eventbridge 時） |

---

## 4. buildspec-build.yml（ビルドステージ）

```yaml
phases:
  build:
    commands:
      # Lambda Layer ビルド
      - mkdir -p build/layer/python
      - pip install -r src/layer/common/requirements.txt -t build/layer/python/
      - cd build/layer && zip -r ../../dist/layer-common.zip python/ && cd ../..

      # 各 Lambda 関数を個別に zip 化
      - |
        for func_dir in src/functions/*/; do
          func_name=$(basename "${func_dir}")
          zip -j "dist/functions/${func_name}.zip" "${func_dir}"*.py "${func_dir}function.json"
        done

artifacts:
  files:
    - dist/layer-common.zip
    - "dist/functions/*.zip"
```

---

## 5. buildspec-deploy.yml（デプロイステージ）

### 処理フロー

```text
1. SSM から Role ARN・Queue URL 等を取得
2. Lambda Layer を発行
3. 各関数の function.json をパースして設定値を取得
4. バリデーション（Lambda 制限 + CDK 上限ガード）
5. Lambda 関数の作成 or コード/設定更新
6. Event Source Mapping の設定（SQS / EventBridge）
```

### バリデーション（2段階ガード）

```bash
# 1. Lambda サービス制限チェック
if [ "${FUNC_TIMEOUT}" -lt 1 ] || [ "${FUNC_TIMEOUT}" -gt 900 ]; then
  echo "ERROR: timeout=${FUNC_TIMEOUT} は 1〜900 の範囲で設定してください"; exit 1
fi

# 2. CDK 上限ガードチェック（プロジェクト固有の制限）
if [ "${FUNC_TIMEOUT}" -gt "${LAMBDA_TIMEOUT_MAX}" ]; then
  echo "ERROR: timeout=${FUNC_TIMEOUT} がプロジェクト上限 ${LAMBDA_TIMEOUT_MAX} を超えています"; exit 1
fi
```

### Lambda 関数の作成 or 更新（冪等）

```bash
if aws lambda get-function --function-name "${FUNCTION_NAME}" 2>/dev/null; then
  # 既存: コード更新 → wait → 設定更新 → wait
  aws lambda update-function-code --function-name "${FUNCTION_NAME}" --zip-file "fileb://${zip_file}"
  aws lambda wait function-updated --function-name "${FUNCTION_NAME}"
  aws lambda update-function-configuration --function-name "${FUNCTION_NAME}" \
    --runtime python3.13 --handler index.lambda_handler \
    --timeout "${FUNC_TIMEOUT}" --memory-size "${FUNC_MEMORY}" \
    --layers "${LAYER_VERSION_ARN}" --environment "${ENV_VARS}" \
    --logging-config "${LOGGING_CONFIG}" --tracing-config "Mode=Active"
  aws lambda wait function-updated --function-name "${FUNCTION_NAME}"
else
  # 新規: create-function → wait
  aws lambda create-function --function-name "${FUNCTION_NAME}" \
    --runtime python3.13 --handler index.lambda_handler \
    --role "${ROLE_ARN}" --zip-file "fileb://${zip_file}" \
    --timeout "${FUNC_TIMEOUT}" --memory-size "${FUNC_MEMORY}" \
    --layers "${LAYER_VERSION_ARN}" --environment "${ENV_VARS}" \
    --logging-config "${LOGGING_CONFIG}" --tracing-config "Mode=Active"
  aws lambda wait function-active --function-name "${FUNCTION_NAME}"
fi
```

### Event Source Mapping（SQS）

```bash
if [ "${ESM_TYPE}" = "sqs" ]; then
  TARGET_ARN=$(aws ssm get-parameter --name "${SSM_ARN_KEY}" --query "Parameter.Value" --output text)
  EXISTING_UUID=$(aws lambda list-event-source-mappings \
    --function-name "${FUNCTION_NAME}" --event-source-arn "${TARGET_ARN}" \
    --query "EventSourceMappings[0].UUID" --output text 2>/dev/null || echo "None")

  if [ "${EXISTING_UUID}" = "None" ] || [ -z "${EXISTING_UUID}" ]; then
    aws lambda create-event-source-mapping \
      --function-name "${FUNCTION_NAME}" --event-source-arn "${TARGET_ARN}" \
      --batch-size "${BATCH_SIZE}" --enabled
  else
    aws lambda update-event-source-mapping --uuid "${EXISTING_UUID}" \
      --function-name "${FUNCTION_NAME}" --batch-size "${BATCH_SIZE}" --enabled
  fi
fi
```

### EventBridge スケジュール（ファイル連携用）

```bash
if [ "${ESM_TYPE}" = "eventbridge" ]; then
  RULE_NAME="${FUNCTION_NAME}-schedule"
  aws events put-rule --name "${RULE_NAME}" \
    --schedule-expression "${SCHEDULE}" --state ENABLED
  aws events put-targets --rule "${RULE_NAME}" \
    --targets "Id=lambda,Arn=arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FUNCTION_NAME}"
fi
```

> `put-rule` / `put-targets` は冪等のため、存在確認は不要。

---

## 6. CDK パイプライン Construct 側の設計

```typescript
export class ApiLoggingPipelineConstruct extends Construct {
  constructor(scope: Construct, id: string, props: Props) {
    // CodeBuild Deploy プロジェクトに渡す環境変数
    const deployProject = new codebuild.PipelineProject(this, 'Deploy', {
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      environmentVariables: {
        PROJECT: { value: project },
        ENV: { value: environment },
        LAMBDA_MEMORY_MAX: { value: String(params.lambdaMemoryMaxMb) },
        LAMBDA_TIMEOUT_MAX: { value: String(params.lambdaTimeoutMaxSec) },
        LAMBDA_LOG_LEVEL: { value: params.lambdaLogLevel ?? 'INFO' },
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('my-service/buildspec-deploy.yml'),
    });

    // Deploy プロジェクトに必要な IAM 権限
    deployProject.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'lambda:CreateFunction', 'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration',
        'lambda:GetFunction', 'lambda:GetFunctionConfiguration',
        'lambda:PublishLayerVersion', 'lambda:GetLayerVersion',
        'lambda:CreateEventSourceMapping', 'lambda:UpdateEventSourceMapping',
        'lambda:ListEventSourceMappings',
      ],
      resources: ['*'],  // 関数名が動的なため
    }));
    deployProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [lambdaRoleArn],  // CDK が作成した Lambda 実行ロール
    }));
    deployProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter/${project}/${env}/*`],
    }));
  }
}
```

---

## 7. ディレクトリ構成

```text
app/my-service/
├── buildspec-test.yml          # テストステージ
├── buildspec-build.yml         # ビルドステージ（Layer + 関数 zip）
├── buildspec-deploy.yml        # デプロイステージ（Lambda 作成/更新）
└── src/
    ├── layer/common/
    │   └── requirements.txt    # Lambda Layer 依存パッケージ
    └── functions/
        ├── log-processor/
        │   ├── index.py        # Lambda ハンドラー
        │   └── function.json   # 関数設定（timeout/memory/event_source）
        └── health-check/
            ├── index.py
            └── function.json
```

---

## 8. SSM キー設計（CDK → アプリパイプラインの橋渡し）

| SSM キー | 出力元 | 参照先 |
|---------|--------|--------|
| `/<project>/<env>/my-service/role-arn` | SqsLambdaConstruct | buildspec-deploy（create-function --role） |
| `/<project>/<env>/my-service/sqs-queue-arn` | SqsLambdaConstruct | buildspec-deploy（ESM event-source-arn） |
| `/<project>/<env>/my-service/sqs-queue-url` | SqsLambdaConstruct | buildspec-deploy（Lambda 環境変数） |
| `/<project>/<env>/my-service/firehose-stream-name` | SqsLambdaConstruct | buildspec-deploy（Lambda 環境変数） |
| `/<project>/<env>/my-service/function-name` | SqsLambdaConstruct | buildspec-deploy（関数名プレフィックス） |

---

## 9. スケジュール実行型 Lambda の差異（マルチシステム対応）

SQS 連携型 Lambda と比較して、スケジュール実行型 Lambda には以下の差異がある。

### 差異一覧

| 項目 | SQS 連携型 | スケジュール実行型 |
|------|------------|-----------------|
| 関数命名規則 | `${PROJECT}-${ENV}-svc-<name>` | `${PROJECT}-${ENV}-batch-${SYSTEM_ID}-<name>` |
| event_source.type | `sqs` / `none` | `eventbridge` / `none` |
| ESM 設定 | SQS → Lambda（create-event-source-mapping） | EventBridge → Lambda（put-rule / put-targets） |
| スケジュール管理 | なし | function.json の `schedule` で宣言 |
| 環境変数 | SQS_QUEUE_URL, FIREHOSE_STREAM | RECEIVE_BUCKET, DELIVER_BUCKET, SYSTEM_ID |
| SSM キー | `/<project>/<env>/my-service/*` | `/<project>/<env>/my-batch-service/<systemId>/*` |
| パイプライン | 1 本（全関数共通） | 連携先ごとに独立（`targets` ループで動的生成） |
| ビルド対象 | `src/functions/*/` | `systems/${SYSTEM_ID}/*/` |
| Layer | 全関数共通 | 連携先ごとに独立（`shared/layer/common/` は共有） |

### function.json の差異

SQS 連携型（SQS トリガー）:

```json
{
  "timeout": 30,
  "memory": 128,
  "event_source": {
    "type": "sqs",
    "ssm_arn_key": "/${PROJECT}/${ENV}/my-service/sqs-queue-arn",
    "batch_size": 10,
    "batching_window_seconds": 5
  }
}
```

スケジュール実行型（EventBridge スケジュール）:

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

スケジュール実行型（トリガーなし / ヘルスチェック等）:

```json
{
  "timeout": 10,
  "memory": 128,
  "event_source": {
    "type": "none"
  }
}
```

### ディレクトリ構成の差異

```text
app/my-batch-service/
├── buildspecs/
│   ├── buildspec-test.yml
│   ├── buildspec-build.yml       # SYSTEM_ID で対象ディレクトリを切り替え
│   └── buildspec-deploy.yml      # EventBridge put-rule/put-targets を含む
├── shared/
│   └── layer/common/
│       ├── requirements.txt      # 全システム共通の Layer 依存
│       └── utils.py              # 共通ユーティリティ
└── systems/
    ├── system-a/                  # 連携先 A
    │   ├── receive-processor/
    │   │   ├── index.py
    │   │   └── function.json     # type: eventbridge + schedule
    │   ├── deliver-processor/
    │   │   ├── index.py
    │   │   └── function.json
    │   └── health-check/
    │       ├── index.py
    │       └── function.json     # type: none
    └── system-b/                  # 連携先 B
        └── ...
```

### EventBridge スケジュール管理の詳細

buildspec-deploy.yml で `put-rule` / `put-targets` + `add-permission` を実行:

```bash
if [ "${ESM_TYPE}" = "eventbridge" ] && [ -n "${ESM_SCHEDULE}" ]; then
  RULE_NAME="${FUNCTION_NAME}-schedule"
  FUNCTION_ARN="arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FUNCTION_NAME}"

  # ルール作成/更新（冪等）
  RULE_ARN=$(aws events put-rule \
    --name "${RULE_NAME}" \
    --schedule-expression "${ESM_SCHEDULE}" \
    --state ENABLED \
    --query "RuleArn" --output text)

  # ターゲット設定（冪等）
  aws events put-targets --rule "${RULE_NAME}" \
    --targets "Id=Target0,Arn=${FUNCTION_ARN}"

  # Lambda invoke 権限付与（冪等: 既存なら無視）
  aws lambda add-permission \
    --function-name "${FUNCTION_NAME}" \
    --statement-id "EventBridgeInvoke-${func_suffix}" \
    --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn "${RULE_ARN}" 2>/dev/null || true
fi
```

### CDK 側の設計ポイント

- CDK は EventBridge ルールを作成しない（アプリパイプラインが管理）
- CDK は `addPermission` 相当の権限のみ付与（`events.amazonaws.com` → Lambda invoke）
- パイプラインは `fileTransfer.targets` をループして連携先ごとに独立生成
- 各パイプラインに `SYSTEM_ID` 環境変数を渡し、ビルド/デプロイ対象を切り替え

```typescript
// FileTransferPipelineConstruct（連携先ごとに生成）
for (const target of params.fileTransfer.targets) {
  new FileTransferPipelineConstruct(this, `FtPipeline-${target.systemId}`, {
    systemId: target.systemId,
    environmentVariables: {
      SYSTEM_ID: { value: target.systemId },
      LAMBDA_MEMORY_MAX: { value: String(target.lambdaMemoryMaxMb) },
      LAMBDA_TIMEOUT_MAX: { value: String(target.lambdaTimeoutMaxSec) },
    },
  });
}
```
