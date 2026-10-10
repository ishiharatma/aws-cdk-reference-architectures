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
    `/${stack.node.id}/Remediation/Dlq/Resource`,
    [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This queue is itself the dead-letter destination for events the rules could not deliver to the function; a DLQ for the DLQ adds nothing.',
      },
    ]
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.node.id}/Remediation/Function/ServiceRole/Resource`,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is the AWS-recommended policy for Lambda log delivery.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
    ]
  );
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.node.id}/Remediation/Function/ServiceRole/DefaultPolicy/Resource`,
    [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'The security group, instance and bucket to fix are named by the finding at run time, so their ARNs cannot be listed. The actions are limited to the calls the three remediations need; dry-run mode and the skip tag are the safeguards (README, Security Considerations).',
        appliesTo: ['Resource::*', 'Resource::arn:aws:s3:::*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'kms:GenerateDataKey* on the findings topic key is what the CDK grant for publishing to a CMK-encrypted topic adds.',
        appliesTo: ['Action::kms:GenerateDataKey*'],
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
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.node.id}/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource`,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          "This is the CDK-provided shared Lambda used by every AwsCustomResource in the stack (Config recorder/channel/start-recording, see ConfigConstruct); AWSLambdaBasicExecutionRole is CDK's own default for it and only grants CloudWatch Logs write access.",
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
      },
    ]
  );
  [
    'Config/Recorder/CustomResourcePolicy/Resource',
    'Config/DeliveryChannel/CustomResourcePolicy/Resource',
    'Config/StartRecording/CustomResourcePolicy/Resource',
  ].forEach((path) => {
    NagSuppressions.addResourceSuppressionsByPath(stack, `/${stack.node.id}/${path}`, [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'PutConfigurationRecorder/PutDeliveryChannel/StartConfigurationRecorder are account-and-Region singleton Config APIs with no resource-level ARNs to scope to; see the comment in ConfigConstruct for why these are AwsCustomResource SDK calls instead of the native (structurally broken) CfnConfigurationRecorder/CfnDeliveryChannel resources.',
        appliesTo: ['Resource::*'],
      },
    ]);
  });
}
