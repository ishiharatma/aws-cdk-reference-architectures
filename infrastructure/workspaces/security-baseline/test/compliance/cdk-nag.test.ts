import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { SecurityBaselineStack } from 'lib/stacks/security-baseline-stack';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

describe('CDK Nag AwsSolutions Pack', () => {
  let stack: SecurityBaselineStack;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new SecurityBaselineStack(app, 'SecurityBaseline', {
      project: 'example',
      environment: envName,
      isAutoDeleteObject: true,
      env: defaultEnv,
      params: envParams,
    });

    // Suppressions must be applied before the Aspect runs.
    applySuppressions(stack);
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  });

  test('No unsuppressed Warnings', () => {
    const warnings = Annotations.fromStack(stack).findWarning(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    );
    expect(warnings.map((w) => `${w.id}: ${JSON.stringify(w.entry.data)}`)).toEqual([]);
  });

  test('No unsuppressed Errors', () => {
    const errors = Annotations.fromStack(stack).findError(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    );
    expect(errors.map((e) => `${e.id}: ${JSON.stringify(e.entry.data)}`)).toEqual([]);
  });
});

/** Apply CDK Nag suppressions, each scoped to a path and carrying its reason. */
function applySuppressions(stack: SecurityBaselineStack): void {
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.node.id}/Notification/Dlq/Resource`,
    [
      {
        id: 'AwsSolutions-SQS3',
        reason:
          'This queue is itself the dead-letter destination for undeliverable findings; a DLQ for the DLQ adds nothing.',
      },
    ]
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.node.id}/Config/RecorderRole/Resource`,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWS_ConfigRole is the AWS managed policy AWS documents for the Config recorder role; it is maintained as new resource types are supported.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWS_ConfigRole'],
      },
    ]
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.node.id}/LogArchive/Bucket/Resource`,
    [
      {
        id: 'AwsSolutions-S1',
        reason:
          'This bucket is the terminal audit-log archive; server access logs would need a second archive bucket that itself needs logging.',
      },
    ]
  );
}
