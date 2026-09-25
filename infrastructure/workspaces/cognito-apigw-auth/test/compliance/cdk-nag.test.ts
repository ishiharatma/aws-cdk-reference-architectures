import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { CognitoApigwAuthStack } from 'lib/stacks/cognito-apigw-auth-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

describe('CDK Nag AwsSolutions Pack', () => {
  let stack: CognitoApigwAuthStack;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new CognitoApigwAuthStack(app, 'ExampleCognitoApigwAuth', {
      project: 'example',
      environment: envName,
      isAutoDeleteObject: true,
      env: testEnv,
      params: envParams,
    });
    applySuppressions(stack);
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  });

  test('no unsuppressed Warnings', () => {
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    if (warnings.length > 0) console.log(JSON.stringify(warnings.map((w) => ({ id: w.id, entry: w.entry.data })), null, 2));
    expect(warnings).toHaveLength(0);
  });

  test('no unsuppressed Errors', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    if (errors.length > 0) console.log(JSON.stringify(errors.map((e) => ({ id: e.id, entry: e.entry.data })), null, 2));
    expect(errors).toHaveLength(0);
  });
});

/** Suppressions are limited to costed features and cross-cutting concerns; each states why. */
function applySuppressions(stack: cdk.Stack): void {
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole and AmazonAPIGatewayPushToCloudWatchLogs are the AWS-recommended logging policies.',
      },
      {
        id: 'AwsSolutions-COG2',
        reason: 'MFA is OPTIONAL (TOTP) so the scripted verification can sign in; make it REQUIRED for real users (README, Security).',
      },
      {
        id: 'AwsSolutions-COG3',
        reason: 'Advanced Security (threat protection) needs the Plus feature plan, a per-MAU charge that is out of scope for this reference.',
      },
      {
        id: 'AwsSolutions-COG8',
        reason: 'The Plus feature plan (threat protection, compromised-credential checks) is billed per monthly active user; out of scope for this reference.',
      },
      {
        id: 'AwsSolutions-APIG3',
        reason: 'A WAFv2 Web ACL has a fixed monthly cost; stage throttling and the authorizer bound abuse here. See README Security.',
      },
    ],
    true,
  );
}
