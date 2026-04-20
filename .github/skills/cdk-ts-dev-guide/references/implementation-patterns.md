# CDK 実装パターン集

実プロジェクトで検証済みの Construct・Stack 実装パターン。

---

## 1. パラメータ駆動の条件分岐

### 既存リソース参照 or 新規作成

```typescript
export class VpcConstruct extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: VpcConstructProps) {
    super(scope, id);
    const { params } = props;

    if (params.existingVpcId) {
      this.vpc = ec2.Vpc.fromLookup(this, 'Resource', { vpcId: params.existingVpcId });
    } else if (params.createConfig) {
      this.vpc = new ec2.Vpc(this, 'Resource', {
        ipAddresses: ec2.IpAddresses.cidr(params.createConfig.cidr),
        maxAzs: params.createConfig.azCount,
      });
    } else {
      throw new Error('VpcParams requires either existingVpcId or createConfig');
    }
  }
}
```

### オプショナル機能の有効化

```typescript
// パラメータで機能の ON/OFF を制御
if (params.enableAutoScaling) {
  const scalableTarget = new appscaling.ScalableTarget(this, 'ScalableTarget', { ... });
  scalableTarget.scaleToTrackMetric('CpuScaling', { ... });

  // さらにオプショナルなサブ機能
  if (params.ecsNightlySchedule) {
    scalableTarget.scaleOnSchedule('NightStop', {
      schedule: appscaling.Schedule.expression(params.ecsNightlySchedule.stopSchedule),
      minCapacity: 0, maxCapacity: 0,
    });
  }
}
```

---

## 2. ループによる動的リソース生成

### 連携先ごとに独立リソースを生成

```typescript
for (const target of params.targets) {
  const { systemId, direction } = target;

  // direction に応じて必要なバケットのみ作成
  if (direction === 'send' || direction === 'both') {
    new s3.Bucket(this, `ReceiveBucket-${systemId}`, {
      bucketName: `${project}-${env}-receive-${systemId}-${account}-${regionShort}`,
    });
  }
  if (direction === 'receive' || direction === 'both') {
    new s3.Bucket(this, `DeliverBucket-${systemId}`, {
      bucketName: `${project}-${env}-deliver-${systemId}-${account}-${regionShort}`,
    });
  }
}
```

---

## 3. S3 ライフサイクル設定の型安全な管理

```typescript
// 型定義
export interface S3LifecycleConfig {
  readonly standardIaDays?: number;
  readonly glacierFlexibleDays?: number;
  readonly glacierDeepArchiveDays?: number;
  readonly expirationDays?: number;
}

// Construct 内で変換
function toLifecycleRules(config?: S3LifecycleConfig): s3.LifecycleRule[] | undefined {
  if (!config) return undefined;
  const transitions: s3.Transition[] = [];
  if (config.standardIaDays) {
    transitions.push({ storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(config.standardIaDays) });
  }
  // ... 他のストレージクラスも同様
  return [{ transitions, expiration: config.expirationDays ? cdk.Duration.days(config.expirationDays) : undefined }];
}
```

---

## 4. CDK が管理しないリソースとの連携

### Lambda 関数を CDK で作成せず、周辺リソースのみ管理

```typescript
// Lambda 関数名は命名規則から構築（CDK 管理外）
const functionName = `${project}-${environment}-ft-${systemId}`;

// IAM Role のみ CDK で作成
const lambdaRole = new iam.Role(this, `LambdaRole-${systemId}`, {
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
});

// SSM に出力してアプリパイプラインが参照
new ssm.StringParameter(this, `RoleArn-${systemId}`, {
  parameterName: `/${project}/${environment}/my-batch-service/${systemId}/role-arn`,
  stringValue: lambdaRole.roleArn,
});
new ssm.StringParameter(this, `FunctionName-${systemId}`, {
  parameterName: `/${project}/${environment}/my-batch-service/${systemId}/function-name`,
  stringValue: functionName,
});
```

---

## 5. 信頼ポリシーの条件分岐

```typescript
// 3 パターンの信頼ポリシー
let assumedBy: iam.IPrincipal;
if (target.externalAccess) {
  // 非 AWS（IAM Roles Anywhere）
  assumedBy = new iam.ServicePrincipal('rolesanywhere.amazonaws.com');
} else if (target.senderAccountId) {
  // クロスアカウント
  assumedBy = new iam.AccountPrincipal(target.senderAccountId);
} else {
  // 同一アカウント
  assumedBy = new iam.AccountRootPrincipal();
}

const role = new iam.Role(this, `SenderRole-${systemId}`, { assumedBy });
```

---

## 6. Stage での条件付きスタック生成

```typescript
export class InfraStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    // 常に作成
    const dataStack = new DataStack(this, 'Data', { ... });
    const appStack = new ApplicationStack(this, 'Application', { ... });
    appStack.addDependency(dataStack);

    // 特定アカウントのみ（例: CodeCommit 所有アカウント）
    if (props.env?.account === sharedParams.codecommitAccountId) {
      new CommitStack(this, 'Commit', { ... });
    }

    // パラメータが設定されている場合のみ
    if (props.params.pipeline && sharedParams.codecommitAccountId) {
      new PipelineStack(this, 'Pipeline', { ... });
    }
  }
}
```

---

## 7. Aspect によるプロジェクト横断ルール

```typescript
export class BucketEncryptionAspect implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (node instanceof s3.CfnBucket) {
      if (!node.bucketEncryption) {
        Annotations.of(node).addError('S3 Bucket must have encryption enabled');
      }
    }
  }
}

// Stage レベルで適用
Aspects.of(appStack).add(new BucketEncryptionAspect());
```
