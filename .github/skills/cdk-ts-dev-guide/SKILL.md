---
name: cdk-ts-dev-guide
description: AWS CDK TypeScript プロジェクトの開発ガイド。CDK スタック・Construct の設計、型安全なパラメータ管理、テスト戦略、命名規約、TypeDoc によるドキュメント生成など、実プロジェクトで検証済みのパターンを網羅する。「CDK の設計方針は？」「Construct をどう分割する？」「テストはどう書く？」などと聞かれたときに使用する。
---

# AWS CDK TypeScript 開発ガイド

実プロジェクトで検証済みの CDK 開発パターン集。プロジェクト固有の情報を含まず、どの CDK プロジェクトでも再利用可能。

> **初めてプロジェクトに参加する場合:** まず `references/dev-environment-setup.md` で開発環境をセットアップしてください。Node.js / AWS CLI / VSCode の設定、ESLint / Prettier / Husky の導入、npm スクリプトの設計が含まれています。

---

## 1. プロジェクト構成

### ディレクトリ構造

```text
infra/
├── bin/                 # CDK App エントリーポイント
├── lib/
│   ├── aspects/         # cdk.IAspect 実装
│   ├── constants/       # 定数定義
│   ├── constructs/      # カスタム Construct
│   ├── stacks/          # Stack 定義
│   ├── stages/          # Stage 定義（マルチアカウント対応）
│   └── types/           # 型定義（インターフェース・enum）
├── parameters/          # 環境別パラメータ（TypeScript）
├── src/                 # Lambda 等のアプリケーションコード
└── test/
    ├── compliance/      # cdk-nag テスト
    ├── helpers/         # テストヘルパー
    ├── integration/     # スタック間結合テスト
    ├── parameters/      # テスト用パラメータ
    ├── snapshot/        # スナップショットテスト
    ├── unit/            # Fine-grained assertions
    └── validation/      # バリデーションテスト
```

### tsconfig.json パスエイリアス

```json
{
  "compilerOptions": {
    "baseUrl": "./",
    "paths": {
      "lib/*": ["lib/*"],
      "parameters/*": ["parameters/*"],
      "test/*": ["test/*"]
    }
  }
}
```

テスト実行時は `tsconfig-paths` で解決する:

```json
// jest.config.js
{ "moduleNameMapper": { "^lib/(.*)$": "<rootDir>/lib/$1" } }
```

---

## 2. 命名規約

### ファイル名

| 種別 | 形式 | 例 |
|------|------|-----|
| Stack | `<purpose>-stack.ts` | `application-stack.ts` |
| Construct | `<resource>-construct.ts` | `vpc-construct.ts` |
| 型定義 | `<scope>.types.ts` | `vpc.types.ts` |
| パラメータ | `<env>-params.ts` | `dev-params.ts` |
| テスト | `<target>.test.ts` | `vpc-construct.test.ts` |

### コーディング

| 対象 | 規約 | 例 |
|------|------|-----|
| クラス・インターフェース | PascalCase | `VpcConstruct`, `VpcParams` |
| 変数・メンバー | camelCase | `ecsMinTaskCount` |
| AWS リソース物理名 | `<project>-<env>-<purpose>` | `myapp-prod-api-cluster` |
| Construct 論理 ID | PascalCase、`Stack`/`Construct` サフィックス不要 | `new VpcConstruct(this, 'Network')` |

### 論理 ID の注意点

```typescript
// ❌ 論理 ID に Stack/Construct を含めない
new NetworkStack(this, 'NetworkStack');

// ✅ シンプルな名称
new NetworkStack(this, 'Network');
```

---

## 3. スタック設計

### 基本方針

原則として単一スタック + Construct 分割。分割する場合はステートフル/ステートレスで分離する。

```typescript
// bin/app.ts
const dataStack = new DataStack(stage, 'Data', {
  terminationProtection: true,  // ステートフル: 削除保護
});

const appStack = new ApplicationStack(stage, 'Application', {
  apiLogBucket: dataStack.apiLogBucket,  // props 経由で明示的に渡す
});
appStack.addDependency(dataStack);
```

### スタック分割の判定基準

| 条件 | 対応 |
|------|------|
| リソース数 500 に近づく | 分割必須 |
| ステートフル（S3/RDS）とステートレス（ECS/Lambda）の混在 | 分割推奨 |
| ライフサイクルが大きく異なる | 分割検討 |
| 上記以外 | 単一スタック + Construct 分割 |

### Cross-Stack Reference の回避

```typescript
// ❌ CfnOutput/Fn::ImportValue（デッドロックリスク）
// CDK が自動生成する Export/Import に依存しない

// ✅ props 経由で明示的に渡す
interface ApplicationStackProps extends cdk.StackProps {
  readonly apiLogBucket?: s3.IBucket;
}
```

---

## 4. Construct 設計

### 外部公開はインターフェース型

```typescript
export class VpcConstruct extends Construct {
  // ✅ ec2.IVpc（インターフェース型）
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: VpcConstructProps) {
    super(scope, id);
    this.vpc = new ec2.Vpc(this, 'Resource', { ... });
    //                       ^^^^^^^^ 単一リソース → 'Resource'
  }
}
```

### Resource ID の使い分け

| Construct の種類 | 内部リソース ID | 理由 |
|-----------------|----------------|------|
| 単一リソースをラップ（L2 相当） | `'Resource'` | 公式 L2 と統一、`node.defaultChild` でアクセス可能 |
| 複数リソースを作成（L3 相当） | 説明的な ID | `'Handler'`, `'Api'`, `'Queue'` 等 |

### 粒度の目安

```text
❌ 大きすぎ: InfraConstruct → VPC + RDS + Lambda + API GW + ...
❌ 小さすぎ: MyBucketConstruct → S3 1個ラップしただけ
✅ 適切:     EcsConstruct → Cluster + SG + IAM Role + ECR + SSM 出力
```

### SSM Parameter Store 出力パターン

Construct が作成したリソースの ARN・名前を SSM に出力し、外部ツール（ecspresso 等）から参照可能にする:

```typescript
new ssm.StringParameter(this, 'ClusterArnParam', {
  parameterName: `/${project}/${environment}/ecs/cluster-arn`,
  stringValue: this.cluster.clusterArn,
});
```

---

## 5. パラメータ管理

### 基本方針

CloudFormation パラメータや `cdk.json` context は使わない。TypeScript の型定義で管理する。

### 型定義

```typescript
// lib/types/vpc.types.ts
export interface VpcParams {
  readonly existingVpcId?: string;
  readonly createConfig?: VpcCreateConfig;
}

export interface VpcCreateConfig {
  readonly cidr: string;
  readonly azCount: number;
}
```

```typescript
// parameters/environments.ts
export enum Environment {
  DEVELOPMENT = 'dev',
  STAGING = 'stage',
  PRODUCTION = 'prod',
  TEST = 'test',
}

export interface EnvParams extends EnvironmentConfig {
  readonly vpc?: VpcParams;
  readonly apiRelay?: ApiRelayParams;
  // ... 機能ごとにオプショナルで追加
}

export const params: Partial<Record<Environment, EnvParams>> = {};
```

### 環境別パラメータファイル

```typescript
// parameters/dev-params.ts
import { params, EnvParams, Environment } from './environments';

const devParams: EnvParams = {
  vpc: {
    createConfig: { cidr: '10.0.0.0/16', azCount: 2 },
  },
};
params[Environment.DEVELOPMENT] = devParams;
```

### 既存リソース参照 or 新規作成の切り替え

```typescript
// Construct 内で分岐
if (props.existingVpcId) {
  this.vpc = ec2.Vpc.fromLookup(this, 'Resource', { vpcId: props.existingVpcId });
} else if (props.createConfig) {
  this.vpc = new ec2.Vpc(this, 'Resource', { ... });
} else {
  throw new Error('VpcParams requires either existingVpcId or createConfig');
}
```

### バレル export

```typescript
// lib/types/index.ts
export * from './vpc.types';
export * from './api-relay.types';
export * from './s3.types';
```

---

## 6. Stage パターン（マルチアカウント対応）

```typescript
// bin/app.ts
const app = new cdk.App();
const project = app.node.tryGetContext('project');
const environment = process.env.ENV as Environment;

const stage = new InfraStage(app, pascalCase(`${project}-${environment}`), {
  project,
  environment,
  params: params[environment]!,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

// 共通タグ — Stage に対して適用する（App ではなく）
// App → Stage → Stack の構造では Tags.of(app) が Stage 境界を越えて
// CloudFormation テンプレートに反映されない。Tags.of(stage) で確実に伝播する。
cdk.Tags.of(stage).add('Project', project);
cdk.Tags.of(stage).add('Environment', environment);
cdk.Tags.of(stage).add('ManagedBy', 'CDK');
```

```typescript
// lib/stages/infra-stage.ts
export class InfraStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    const dataStack = new DataStack(this, 'Data', { ... });
    const appStack = new ApplicationStack(this, 'Application', {
      apiLogBucket: dataStack.apiLogBucket,
    });
    appStack.addDependency(dataStack);

    // 条件付きスタック（例: prod のみ）
    if (props.env?.account === sharedParams.codecommitAccountId) {
      new CommitStack(this, 'Commit', { ... });
    }
  }
}
```

---

## 7. テスト戦略

### テスト種別

| 種別 | 目的 | ディレクトリ |
|------|------|-------------|
| Unit (Fine-grained) | リソース・プロパティの検証 | `test/unit/` |
| Validation | 入力値の範囲・形式の検証 | `test/validation/` |
| Compliance (cdk-nag) | セキュリティベストプラクティス | `test/compliance/` |
| Snapshot | テンプレートの意図しない変更検知 | `test/snapshot/` |
| Integration | スタック間依存関係の検証 | `test/integration/` |

### テストヘルパーパターン

```typescript
// テスト用デフォルト環境値（トークンを確定値で解決）
const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };

function makeStack(): cdk.Stack {
  return new cdk.Stack(new cdk.App(), 'TestStack', { env: defaultEnv });
}

function makeConstruct(stack: cdk.Stack, overrides?: Partial<MyParams>): MyConstruct {
  return new MyConstruct(stack, 'Target', {
    project: 'Test', environment: Environment.TEST,
    params: { ...baseParams, ...overrides },
  });
}
```

### Unit テスト例

```typescript
describe('EcsConstruct – Auto Scaling', () => {
  let template: Template;

  beforeAll(() => {
    const stack = makeStack();
    makeConstruct(stack, { enableAutoScaling: true });
    template = Template.fromStack(stack);
  });

  test('ScalableTarget が作成される', () => {
    template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 1);
  });

  test('CPU 使用率ベースの ScalingPolicy が作成される', () => {
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      PolicyType: 'TargetTrackingScaling',
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        PredefinedMetricSpecification: {
          PredefinedMetricType: 'ECSServiceAverageCPUUtilization',
        },
      }),
    });
  });
});
```

### Validation テスト例

```typescript
describe('VpcConstruct – バリデーション', () => {
  test('不正な CIDR でエラーになる', () => {
    expect(() => {
      const stack = makeStack();
      new VpcConstruct(stack, 'Vpc', {
        params: { createConfig: { cidr: 'invalid', azCount: 2 } },
      });
    }).toThrow();
  });
});
```

### Compliance テスト例（cdk-nag）

```typescript
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';

describe('cdk-nag Compliance', () => {
  test('ApplicationStack に AwsSolutions 違反がない', () => {
    const app = new cdk.App();
    const stack = new ApplicationStack(app, 'Test', { ... });
    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: false }));

    // 正当な例外を suppress
    NagSuppressions.addResourceSuppressions(stack, [
      { id: 'AwsSolutions-IAM4', reason: 'AmazonECSTaskExecutionRolePolicy is AWS managed' },
    ], true);

    const messages = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(messages).toHaveLength(0);
  });
});
```

---

## 8. Aspects パターン

カスタム Aspect でプロジェクト横断のルールを強制する:

```typescript
import { IAspect, Annotations } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { IConstruct } from 'constructs';

export class LogGroupRetentionAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof logs.CfnLogGroup) {
      if (!node.retentionInDays) {
        Annotations.of(node).addWarning('LogGroup should have retentionInDays set');
      }
    }
  }
}

// bin/app.ts で適用
cdk.Aspects.of(app).add(new LogGroupRetentionAspect());
```

---

## 9. npm スクリプト設計

```json
{
  "scripts": {
    "synth": "cross-env COMMIT_HASH=$(git rev-parse --short HEAD) cdk synth '**' -c project=${PROJECT} -c env=${ENV} --profile ${PROJECT}-${ENV}",
    "diff": "cross-env COMMIT_HASH=$(git rev-parse --short HEAD) cdk diff '**' -c project=${PROJECT} -c env=${ENV} --profile ${PROJECT}-${ENV}",
    "stage:deploy:all": "cross-env COMMIT_HASH=$(git rev-parse --short HEAD) cdk deploy '**' -c project=${PROJECT} -c env=${ENV} --profile ${PROJECT}-${ENV}",
    "test": "jest",
    "lint": "eslint \"**/*.ts\"",
    "docs": "npx typedoc"
  }
}
```

実行例: `PROJECT=myapp ENV=dev npm run synth`

---

## 10. TypeDoc 設定

```json
// typedoc.json
{
  "$schema": "https://typedoc.org/schema.json",
  "entryPoints": ["lib/types", "lib/stacks", "lib/stages", "lib/constructs", "lib/aspects", "lib/constants", "parameters"],
  "entryPointStrategy": "expand",
  "out": "docs/reference",
  "exclude": ["**/*.test.ts", "**/node_modules/**", "**/cdk.out/**"],
  "excludePrivate": true,
  "sort": ["source-order"]
}
```

### JSDoc 必須ルール

- `export class` / `export interface` の直前に `/** */` 必須
- `public readonly` プロパティの直前に `/** */` 必須
- constructor に `@param` 推奨
- `//` 行コメント禁止（TypeDoc が認識しない）

---

## 11. よくある落とし穴と対策

| 落とし穴 | 対策 |
|---------|------|
| `Tags.of(app)` が Stage 境界を越えてテンプレートに反映されない | `Tags.of(stage)` に適用する。App → Stage → Stack 構造では Stage レベルでタグを付与 |
| S3/ECR バケット名に大文字が含まれる | `.toLowerCase()` を付ける |
| IAM Role description に日本語 | ASCII のみ使用（`[\u0020-\u00FF]`） |
| L2 `rule.addTarget(LambdaFunction)` で未存在 Lambda を参照 | L1 `CfnRule.targets` で ARN を直接指定 |
| `CodeCommitTrigger.EVENTS` がクロスアカウントでサポートスタック生成 | `NONE` + 明示的 EventBridge ルール |
| CDK トークンが `Fn::Join` になりテスト文字列比較が失敗 | リテラル文字列で名前を構築 |
| `set -euo pipefail` + `((count++))` で exit 1 | `count=$((count + 1))` を使用 |
| `cdk destroy` で削除保護スタックが消えない | コンソールで `terminationProtection` を無効化してから実行 |

---

## 12. CDK + ecspresso 連携

CDK は ECS Cluster・SG・IAM Role・ECR のみ管理し、タスク定義・サービスは ecspresso に委任する。SSM Parameter Store を橋渡しに使い、CDK が出力した値を ecspresso の jsonnet から `ssm()` で参照する。

詳細は `references/ecspresso-patterns.md` を参照。

### 責務分担の要点

- CDK: Cluster + SG + IAM + ECR + CW Logs + SSM 出力 + Auto Scaling
- ecspresso: TaskDefinition 登録 + Service Create/Update + ALB TargetGroup アタッチ
- Auto Scaling は ecspresso 初回デプロイ後に `enableAutoScaling: true` で CDK 再デプロイ

---

## 13. CDK + アプリパイプラインによる Lambda デプロイ

CDK は Lambda 関数自体を作成せず、IAM Role・SQS・Firehose 等の周辺リソースのみ管理する。Lambda の作成・コード更新はアプリリポジトリの CodePipeline（buildspec-deploy.yml）が担う。

詳細は `references/lambda-deploy-patterns.md` を参照。

### 設計のポイント

- CDK が作成した IAM Role ARN・Queue URL 等を SSM に出力し、buildspec が参照
- 各関数の `function.json` で timeout / memory / log_level / event_source を宣言
- buildspec-deploy で 2 段階バリデーション（Lambda 制限 + CDK 上限ガード）
- `create-function` / `update-function-code` の冪等な分岐で新規・既存を自動判定
- Event Source Mapping（SQS）や EventBridge スケジュールも buildspec が管理

---

## 14. クロスアカウント CI/CD

CodeCommit を prod アカウントに一元管理し、EventBridge 転送で dev / stage の CodePipeline を起動する。

詳細は `references/cross-account-cicd-patterns.md` を参照。

### 構成の要点

- prod: CodeCommit + EventBridge 転送ルール + PipelineSourceRole
- dev/stage: EventBus リソースポリシー + S3/KMS ポリシー + CodePipeline
- `CodeCommitTrigger.NONE` + 明示的 EventBridge ルールでサポートスタック自動生成を回避
- `shared-params.ts` で `codecommitAccountId` と `forwardTargets` を一元管理
- Stage 内で `props.env?.account === codecommitAccountId` の条件分岐で CommitStack を制御

---

## リファレンス一覧

| ファイル | 内容 |
|---------|------|
| `references/test-patterns.md` | テストパターン集（Unit / Validation / Compliance / Snapshot） |
| `references/implementation-patterns.md` | 実装パターン集（条件分岐・ループ・信頼ポリシー・Aspect） |
| `references/ecspresso-patterns.md` | CDK + ecspresso 連携パターン（責務分担・SSM 設計・ADOT サイドカー） |
| `references/lambda-deploy-patterns.md` | CDK + アプリパイプラインによる Lambda デプロイパターン（function.json・buildspec・ESM） |
| `references/cross-account-cicd-patterns.md` | クロスアカウント CI/CD パターン（EventBridge 転送・PipelineSourceRole・リソースポリシー） |
| `references/dev-environment-setup.md` | 開発環境セットアップ（ESLint・Prettier・Husky・Jest・VSCode・AWS 認証・npm スクリプト） |
| `docs/aws-cdk-development-guideline.md` | CDK 入門ガイドライン（App/Stack/Construct 概念・L1/L2/L3・コーディング規約）※プロジェクトルートの docs/ 配下 |
