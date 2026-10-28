import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { buildStack } from '../helpers/stack';

describe('CDK Nag AwsSolutions Pack', () => {
  const app = new cdk.App();
  const stack = buildStack({ app });
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'Only the CDK-provided custom resource handlers (default SG restriction, S3 auto-delete, ' +
          'EventBridge log group policy) use the AWSLambdaBasicExecutionRole managed policy.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'The task execution role writes to its own log group (log-stream wildcard defined by CDK).',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'The runtime of the CDK-provided custom resource handlers is chosen by aws-cdk-lib.',
      },
      {
        id: 'AwsSolutions-S1',
        reason: 'The bucket only receives ALB access logs; logging the log bucket would recurse.',
      },
      {
        id: 'AwsSolutions-ECS2',
        reason: 'The container environment holds only the listening port and the drain duration.',
      },
    ],
    true,
  );
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  app.synth();

  test('stack has no unsuppressed findings', () => {
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    const findings = [...warnings, ...errors];
    if (findings.length > 0) {
      console.log(JSON.stringify(findings.map((f) => ({ id: f.id, entry: f.entry.data })), null, 2));
    }
    expect(findings).toHaveLength(0);
  });
});
