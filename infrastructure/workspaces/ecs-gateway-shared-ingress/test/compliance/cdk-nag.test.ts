import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { buildStacks } from '../helpers/stack';

const expectNoFindings = (stack: cdk.Stack): void => {
  const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
  const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
  const findings = [...warnings, ...errors];
  if (findings.length > 0) {
    console.log(JSON.stringify(findings.map((f) => ({ id: f.id, entry: f.entry.data })), null, 2));
  }
  expect(findings).toHaveLength(0);
};

describe('CDK Nag AwsSolutions Pack', () => {
  const app = new cdk.App();
  const { platform, app: appStack } = buildStacks({ app });
  applyPlatformSuppressions(platform);
  applyAppSuppressions(appStack);
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  app.synth();

  test('platform stack has no unsuppressed findings', () => {
    expectNoFindings(platform);
  });

  test('app stack has no unsuppressed findings', () => {
    expectNoFindings(appStack);
  });
});

/** Suppressions for the platform stack; each one is documented in the README. */
function applyPlatformSuppressions(stack: cdk.Stack): void {
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AmazonECSInfrastructureRoleForGatewayHostSharedALB is the policy AWS publishes for gateway infrastructure roles; ' +
          'its ELB/EC2 write actions are scoped to resources tagged AmazonECSManaged=true. The auto-delete custom resource uses the Lambda basic role.',
      },
      {
        id: 'AwsSolutions-S1',
        reason: 'The bucket only receives ALB access logs; logging the log bucket would recurse.',
      },
    ],
    true,
  );
}

/** Suppressions for the app stack; each one is documented in the README. */
function applyAppSuppressions(stack: cdk.Stack): void {
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'The probe function uses AWSLambdaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole (logs and ENIs) only.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'The task execution role writes to its own log group (log-stream wildcard defined by CDK).',
      },
      {
        id: 'AwsSolutions-ECS2',
        reason: 'The container environment holds only the service name and a version label shown in the response.',
      },
    ],
    true,
  );
}
