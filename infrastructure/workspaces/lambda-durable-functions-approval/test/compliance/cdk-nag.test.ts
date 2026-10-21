import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { buildStack } from '../helpers/stack';

describe('CDK Nag AwsSolutions Pack', () => {
  test('stack has no unsuppressed findings', () => {
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = buildStack(app);
    applySuppressions(stack);
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    app.synth();

    const warnings = Annotations.fromStack(stack).findWarning(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    );
    const errors = Annotations.fromStack(stack).findError(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    );
    const findings = [...warnings, ...errors];
    if (findings.length > 0) {
      console.log(
        JSON.stringify(
          findings.map((f) => ({ id: f.id, entry: f.entry.data })),
          null,
          2
        )
      );
    }
    expect(findings).toHaveLength(0);
  });
});

/**
 * Each suppression is either a managed policy the durable functions documentation names,
 * a resource pattern the durable execution ARN format requires, or a scope cut documented
 * in the README. Suppressions use `appliesTo` so any new, unrelated finding still fails.
 */
function applySuppressions(stack: cdk.Stack): void {
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSLambdaBasicDurableExecutionRolePolicy is the AWS managed policy the Lambda docs name for durable functions ' +
          '(CloudWatch Logs + lambda:CheckpointDurableExecution / GetDurableExecutionState); CDK attaches it when durableConfig is set.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy',
        ],
      },
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'CloudWatch Logs permissions for the three API handler functions; scoped by Lambda to their own log groups.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'Account-level API Gateway CloudWatch role required for execution logging (APIG6).',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Callback APIs are authorized against the durable execution ARN <function-arn>:<version>/durable-execution/..., ' +
          'so the documented resource is <function-arn>:*. It is limited to this one function and to SendDurableExecutionCallbackSuccess.',
        appliesTo: ['Resource::<WorkflowFunction9B932173.Arn>:*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'kms:GenerateDataKey* is added by topic.grantPublish for the topic CMK; the resource is that single key.',
        appliesTo: ['Action::kms:GenerateDataKey*'],
      },
      {
        id: 'AwsSolutions-COG4',
        reason:
          'The API uses IAM (SigV4) authorization for workforce/service callers instead of a Cognito user pool (see README).',
      },
      {
        id: 'AwsSolutions-APIG3',
        reason:
          'IAM authorization rejects unsigned requests and the stage is throttled; add a regional WAF web ACL for public exposure.',
      },
    ],
    true
  );
}
