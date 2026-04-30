# CDK テストパターン集

実プロジェクトで検証済みのテストパターン。

---

## 1. テストヘルパー設計

### 共通パターン

```typescript
import * as cdk from 'aws-cdk-lib';
import { Template, Match, Annotations } from 'aws-cdk-lib/assertions';

// トークンを確定値で解決するため account/region を明示
const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };

function makeStack(): cdk.Stack {
  return new cdk.Stack(new cdk.App(), 'TestStack', { env: defaultEnv });
}
```

### Construct 生成ヘルパー（overrides パターン）

```typescript
const baseParams: MyParams = {
  cpu: 256, memory: 512, minCount: 1, maxCount: 2,
};

function makeConstruct(
  stack: cdk.Stack,
  overrides?: Partial<MyParams>
): MyConstruct {
  return new MyConstruct(stack, 'Target', {
    project: 'Test',
    environment: Environment.TEST,
    params: { ...baseParams, ...overrides },
  });
}
```

---

## 2. Unit テスト（Fine-grained Assertions）

### リソース数の検証

```typescript
test('SQS Queue が 2 つ作成される（メイン + DLQ）', () => {
  template.resourceCountIs('AWS::SQS::Queue', 2);
});
```

### プロパティの検証

```typescript
test('S3 バケットに SSE-S3 暗号化が設定される', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: Match.arrayWith([
        Match.objectLike({
          ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
        }),
      ]),
    },
  });
});
```

### IAM ポリシーの検証

```typescript
test('TaskRole に sqs:SendMessage のみ許可される', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Action: 'sqs:SendMessage' }),
      ]),
    },
  });
});
```

### SSM Parameter Store 出力の検証

```typescript
test('SSM Parameter – cluster-arn が作成される', () => {
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/Test/test/ecs/cluster-arn',
    Type: 'String',
  });
});
```

### findResources で詳細検証

```typescript
test('NightStop で minCapacity=0 が設定される', () => {
  const targets = template.findResources('AWS::ApplicationAutoScaling::ScalableTarget');
  const target = Object.values(targets)[0];
  const actions = target.Properties.ScheduledActions;
  const nightStop = actions.find((a: any) => a.ScheduledActionName === 'NightStop');
  expect(nightStop.ScalableTargetAction.MinCapacity).toBe(0);
});
```

---

## 3. Validation テスト

### エラーが throw されることの検証

```typescript
test('不正な CIDR でエラーになる', () => {
  expect(() => {
    const stack = makeStack();
    new VpcConstruct(stack, 'Vpc', {
      params: { createConfig: { cidr: 'invalid', azCount: 2 } },
    });
  }).toThrow(/CIDR/);
});
```

### 境界値テスト

```typescript
test('azCount が 0 でエラーになる', () => {
  expect(() => makeConstruct(makeStack(), { azCount: 0 })).toThrow();
});

test('azCount が 3 で正常に作成される', () => {
  expect(() => makeConstruct(makeStack(), { azCount: 3 })).not.toThrow();
});
```

---

## 4. Compliance テスト（cdk-nag）

```typescript
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';

describe('cdk-nag Compliance', () => {
  let stack: cdk.Stack;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new ApplicationStack(app, 'Test', { ... });
    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: false }));

    // 正当な例外
    NagSuppressions.addStackSuppressions(stack, [
      { id: 'AwsSolutions-IAM4', reason: 'AWS managed policy for ECS task execution' },
    ]);
  });

  test('AwsSolutions エラーがない', () => {
    const errors = Annotations.fromStack(stack)
      .findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors).toHaveLength(0);
  });
});
```

---

## 5. Snapshot テスト

```typescript
describe('Snapshot Tests', () => {
  test('CloudFormation テンプレートのスナップショット', () => {
    const app = new cdk.App();
    const stack = new ApplicationStack(app, 'Test', { ... });
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
```

更新コマンド: `npx jest test/snapshot --updateSnapshot`

---

## 6. テスト実行の使い分け

```bash
# 変更した Construct のユニットテストのみ
npx jest test/unit/vpc-construct.test.ts

# バリデーションテスト全体
npx jest test/validation

# cdk-nag コンプライアンス
npx jest test/compliance

# 全テスト
npm test
```
