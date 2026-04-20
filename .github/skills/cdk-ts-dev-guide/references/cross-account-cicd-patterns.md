# クロスアカウント CI/CD パターン

CodeCommit を prod アカウントに一元管理し、EventBridge 転送で dev / stage アカウントの CodePipeline を起動するパターン。

---

## 1. アーキテクチャ概要

```text
[ prod アカウント ]
  CodeCommit (project-infra / project-app)
      │ push (develop / staging / main ブランチ)
      ▼
  EventBridge (default event bus)
      ├── project-to-dev-rule   ──▶ dev アカウント default event bus
      ├── project-to-stage-rule ──▶ stage アカウント default event bus
      └── (prod は同一アカウントなので転送不要)

[ dev アカウント ]
  default event bus ──▶ CodePipeline (project-dev-*-pipeline)
      │ Source Action: prod の CodeCommit を PipelineSourceRole で参照
      ▼
  CodeBuild → Deploy

[ stage アカウント ]
  (同構成)
```

---

## 2. 必要なリソースと配置先

| リソース | 配置先 | 目的 |
|---------|--------|------|
| CodeCommit × 2 | prod | ソースリポジトリ |
| EventBridge 転送ルール | prod | ブランチ push を各アカウントへ転送 |
| EventBridge 転送用 IAM Role | prod | クロスアカウント PutEvents |
| PipelineSourceRole | prod | dev/stage が AssumeRole して CodeCommit を読む |
| EventBus リソースポリシー | dev/stage | prod からの PutEvents を許可 |
| S3 バケットポリシー | dev/stage | PipelineSourceRole の S3 書き込みを許可 |
| KMS キーポリシー | dev/stage | PipelineSourceRole の暗号化操作を許可 |
| CodePipeline | dev/stage/prod | CI/CD パイプライン |

---

## 3. 共通パラメータ設計（shared-params.ts）

```typescript
export interface EventForwardTarget {
  readonly environment: Environment;
  readonly accountId: string;
}

export interface SharedParams {
  /** CodeCommit が配置されている AWS アカウント ID */
  readonly codecommitAccountId?: string;
  /** 既存リポジトリ ARN（未指定時は新規作成） */
  readonly existingInfraRepoArn?: string;
  readonly existingAppRepoArn?: string;
  /** EventBridge 転送先一覧 */
  readonly forwardTargets?: EventForwardTarget[];
}

export const sharedParams: SharedParams = {
  codecommitAccountId: '111111111111',  // prod
  forwardTargets: [
    { environment: Environment.PRODUCTION,  accountId: '111111111111' },
    { environment: Environment.DEVELOPMENT, accountId: '222222222222' },
    { environment: Environment.STAGING,     accountId: '333333333333' },
  ],
};
```

---

## 4. prod アカウント: CommitConstruct

### CodeCommit リポジトリ（既存参照 or 新規作成）

```typescript
this.infraRepo = existingInfraRepoArn
  ? codecommit.Repository.fromRepositoryArn(this, 'InfraRepo', existingInfraRepoArn)
  : new codecommit.Repository(this, 'InfraRepo', {
      repositoryName: `${project}-infra`,
    });
```

### EventBridge 転送ルール（クロスアカウントのみ）

```typescript
// 同一アカウント（prod→prod）は転送不要（400 エラーになる）
const crossAccountTargets = resolvedTargets.filter(t => t.accountId !== stack.account);

// 転送用 IAM Role（1 つで全クロスアカウント分をカバー）
const forwardRole = new iam.Role(this, 'EventBridgeForwardRole', {
  assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
});
// events_targets.EventBus に role を渡すと CDK が自動で grantPutEventsTo を呼ぶ
// → 手動の addToPolicy は不要（二重生成になる）

for (const target of crossAccountTargets) {
  const targetBus = events.EventBus.fromEventBusArn(this, `${target.envLabel}Bus`,
    `arn:aws:events:${region}:${target.accountId}:event-bus/default`);

  new events.Rule(this, `ForwardTo${target.envLabel}Rule`, {
    eventPattern: {
      source: ['aws.codecommit'],
      detailType: ['CodeCommit Repository State Change'],
      detail: {
        event: ['referenceCreated', 'referenceUpdated'],
        referenceName: [target.branch],  // develop / staging / main
      },
    },
    targets: [new events_targets.EventBus(targetBus, { role: forwardRole })],
  });
}
```

### PipelineSourceRole（prod に作成、dev/stage が AssumeRole）

```typescript
for (const t of crossAccountTargets) {
  new iam.Role(this, `PipelineSourceRole${t.envLabel}`, {
    roleName: `${project}-pipeline-source-action-${t.accountId}`,
    assumedBy: new iam.AccountPrincipal(t.accountId),
    inlinePolicies: {
      sourceaction: new iam.PolicyDocument({
        statements: [
          // CodeCommit 読み取り
          new iam.PolicyStatement({
            actions: ['codecommit:GetBranch', 'codecommit:GetCommit',
                     'codecommit:UploadArchive', 'codecommit:GetUploadArchiveStatus',
                     'codecommit:GetDifferences'],
            resources: [infraRepo.repositoryArn, appRepo.repositoryArn],
          }),
          // dev/stage の S3 アーティファクトバケットへの書き込み
          new iam.PolicyStatement({
            actions: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'],
            resources: [`arn:aws:s3:::${project}-${t.envLabel}-pipeline-artifact-*`],
          }),
          // dev/stage の KMS キーへのアクセス
          new iam.PolicyStatement({
            actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey', 'kms:Encrypt'],
            resources: [`arn:aws:kms:${region}:${t.accountId}:key/*`],
          }),
        ],
      }),
    },
  });
}
```

---

## 5. dev/stage アカウント: PipelineStack

### EventBus リソースポリシー（prod からの受信許可）

```typescript
if (codecommitAccountId && codecommitAccountId !== this.account) {
  new events.CfnEventBusPolicy(this, 'AllowProdPutEvents', {
    statementId: 'AllowProdAccountPutEvents',
    action: 'events:PutEvents',
    principal: codecommitAccountId,
  });
}
```

### S3 / KMS リソースポリシー（PipelineSourceRole のアクセス許可）

```typescript
const sourceRoleArn = `arn:aws:iam::${codecommitAccountId}:role/${project}-pipeline-source-action-${this.account}`;

artifactBucket.addToResourcePolicy(new iam.PolicyStatement({
  principals: [new iam.ArnPrincipal(sourceRoleArn)],
  actions: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'],
  resources: [artifactBucket.bucketArn, artifactBucket.arnForObjects('*')],
}));

artifactBucket.encryptionKey?.addToResourcePolicy(new iam.PolicyStatement({
  principals: [new iam.ArnPrincipal(sourceRoleArn)],
  actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey', 'kms:Encrypt'],
  resources: ['*'],
}));
```

### S3 アーティファクトバケット（KMS 暗号化必須）

```typescript
const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
  encryption: s3.BucketEncryption.KMS,  // クロスアカウントには CMK が必須
  enforceSSL: true,
});
```

---

## 6. CodePipeline Source Action でのクロスアカウント参照

```typescript
// パイプライン Construct 内
const sourceRoleArn = `arn:aws:iam::${codecommitAccountId}:role/${project}-pipeline-source-action-${this.account}`;
const sourceRole = iam.Role.fromRoleArn(this, 'SourceRole', sourceRoleArn);

new codepipeline_actions.CodeCommitSourceAction({
  actionName: 'Source',
  repository: codecommit.Repository.fromRepositoryArn(this, 'Repo', repoArn),
  branch: branchName,
  output: sourceOutput,
  role: sourceRole,  // ← これにより CDK のサポートスタック自動生成が抑止される
  trigger: codepipeline_actions.CodeCommitTrigger.NONE,  // EventBridge で起動
});
```

---

## 7. Stage での条件分岐

```typescript
// InfraStage
// CommitStack は CodeCommit 所有アカウントのみ
if (props.env?.account === sharedParams.codecommitAccountId) {
  new CommitStack(this, 'Commit', { forwardTargets: sharedParams.forwardTargets });
}

// PipelineStack は codecommitAccountId が確定している場合のみ
if (params.pipeline && sharedParams.codecommitAccountId) {
  new PipelineStack(this, 'Pipeline', { ... });
}
```

---

## 8. ブランチ・環境マッピング

| 環境 | ブランチ | EventBridge ルール |
|------|---------|-------------------|
| dev | `develop` | `project-to-dev-rule` |
| stage | `staging` | `project-to-stage-rule` |
| prod | `main` | 転送不要（同一アカウント） |

```typescript
function getBranchName(env: Environment): string {
  switch (env) {
    case Environment.DEVELOPMENT: return 'develop';
    case Environment.STAGING: return 'staging';
    case Environment.PRODUCTION: return 'main';
    default: return 'develop';
  }
}
```

---

## 9. よくある落とし穴

| 問題 | 対策 |
|------|------|
| `CodeCommitTrigger.EVENTS` がクロスアカウントでサポートスタックを自動生成 | `NONE` + 明示的 EventBridge ルール |
| 同一アカウントへの EventBridge 転送で 400 エラー | Source と Target が同じ event bus の場合は転送ルールを作成しない |
| `events_targets.EventBus` に role を渡すと CDK が自動で `grantPutEventsTo` を呼ぶ | 手動の `addToPolicy` は不要（二重生成になる） |
| PipelineSourceRole の S3/KMS 権限不足 | dev/stage 側のバケットポリシー・キーポリシーにも追加が必要 |
| IAM Role description に日本語を含むと CREATE_FAILED | ASCII のみ使用 |
| `artifactBucket` が SSE-S3 だとクロスアカウント Source Action が失敗 | `BucketEncryption.KMS`（CMK）が必須 |

---

## 10. インフラ CI パイプライン

インフラ CDK リポジトリの変更を検知し、lint / synth / test を自動実行するパイプライン。
Deploy ステージは持たない（CDK デプロイは手動 or 別パイプラインで実施）。

### パイプライン構成

```text
[ Source ] → [ Test ]
  CodeCommit     CodeBuild (buildspec-ci.yml)
  (NONE trigger)   ├── npm ci
                    ├── npm run lint
                    ├── cdk synth
                    └── npm test
```

### buildspec-ci.yml

```yaml
version: 0.2
phases:
  install:
    runtime-versions:
      nodejs: 22
    commands:
      - cd infra
      - npm ci

  pre_build:
    commands:
      - npm run lint
      - |
        PROFILE_OPT=""
        if [ -n "$CDK_PROFILE" ]; then
          PROFILE_OPT="--profile $CDK_PROFILE"
        fi
        COMMIT_HASH=$(git rev-parse --short HEAD) \
          npx cdk synth --version-reporting false --asset-metadata false \
          $PROFILE_OPT

  build:
    commands:
      - npm test
```

> `CDK_PROFILE` は空文字で設定し、CodeBuild インスタンスロールを使用する。
> ローカル実行時は `--profile` を付けるが、CI では不要。

### CDK Construct（InfraPipelineConstruct）

```typescript
const testProject = new codebuild.PipelineProject(this, 'TestProject', {
  projectName: `${project}-${environment}-infra-test`,
  buildSpec: codebuild.BuildSpec.fromSourceFilename('infra/buildspec-ci.yml'),
  environment: {
    buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
    environmentVariables: {
      PROJECT: { value: project },
      ENV: { value: environment },
      CDK_PROFILE: { value: '' },
    },
  },
});

const pipeline = new codepipeline.Pipeline(this, 'Resource', {
  pipelineName: `${project}-${environment}-infra-pipeline`,
  stages: [
    {
      stageName: 'Source',
      actions: [new codepipeline_actions.CodeCommitSourceAction({
        repository: infraRepo,
        branch: getBranchName(environment),
        output: sourceOutput,
        trigger: codepipeline_actions.CodeCommitTrigger.NONE,
        role: isCrossAccount ? sourceRole : undefined,
      })],
    },
    {
      stageName: 'Test',
      actions: [new codepipeline_actions.CodeBuildAction({
        actionName: 'Test',
        project: testProject,
        input: sourceOutput,
      })],
    },
  ],
});
```

### パス変更検知（infra/ 配下のみ起動）

EventBridge → Lambda → `StartPipelineExecution` で、`infra/` 配下に変更がある場合のみパイプラインを起動する。

```typescript
createPathFilterTrigger(this, 'InfraPathFilter', {
  ruleName: `${project}-${environment}-infra-pipeline-trigger`,
  repository: infraRepo,
  pipeline,
  branchName: getBranchName(environment),
  pathPrefixes: ['infra/'],  // infra/ 配下の変更のみ
});
```

### アプリパイプラインとの違い

| 項目 | インフラ CI | アプリ CD |
|------|-----------|----------|
| ステージ数 | 2（Source → Test） | 4〜5（Source → Test → Build → [Approve] → Deploy） |
| Deploy | なし（手動 `cdk deploy`） | あり（ecspresso / Lambda update） |
| 手動承認 | なし | prod のみ有効 |
| パス検知 | `infra/` | `<app-name>/` / `<service-a>/` / `<service-b>/` |
| buildspec | `infra/buildspec-ci.yml` | `app/*/buildspec-*.yml` |
