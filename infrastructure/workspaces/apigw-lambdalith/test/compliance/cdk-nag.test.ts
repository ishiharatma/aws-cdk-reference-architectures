import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { ApigwLambdalithStack } from 'lib/stacks/apigw-lambdalith-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'example';
const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

describe('CDK Nag AwsSolutions Pack', () => {
  let stack: ApigwLambdalithStack;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new ApigwLambdalithStack(app, `${projectName}-${envName}-apigw-lambdalith`, {
      project: projectName,
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
    if (warnings.length > 0) {
      console.log(JSON.stringify(warnings.map((w) => ({ id: w.id, entry: w.entry })), null, 2));
    }
    expect(warnings).toHaveLength(0);
  });

  test('no unsuppressed Errors', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    if (errors.length > 0) {
      console.log(JSON.stringify(errors.map((e) => ({ id: e.id, entry: e.entry })), null, 2));
    }
    expect(errors).toHaveLength(0);
  });
});

/**
 * CDK Nag suppressions.
 *
 * The suppressed rules are all authN/Z, WAF, and request-validation concerns
 * that are intentionally out of scope for this reference: it isolates the
 * *Lambda integration style* (one function + in-process routing). Adding a
 * Cognito/JWT/IAM authorizer, a WAFv2 Web ACL, and model-based request
 * validation is documented in the README as an environment-specific step.
 */
function applySuppressions(stack: cdk.Stack): void {
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-L1',
        reason:
          'The function runtime is intentionally pinned to nodejs22.x (the current Node.js LTS on Lambda) for ' +
          'reproducible builds; it is reviewed and bumped deliberately rather than floating.',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSLambdaBasicExecutionRole (CloudWatch Logs) and AmazonAPIGatewayPushToCloudWatchLogs are the ' +
          'AWS-recommended managed policies for Lambda and API Gateway logging; scoping them by hand adds no security.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'DynamoDB grant*Data helpers add a table/index/* resource so secondary indexes remain reachable; the ' +
          'actions are limited to this single table.',
      },
      {
        id: 'AwsSolutions-APIG2',
        reason:
          'Request validation is performed inside the function by the Hono framework/handler; API Gateway model ' +
          'validation would duplicate it for this reference.',
      },
      {
        id: 'AwsSolutions-APIG3',
        reason: 'WAFv2 Web ACL association is environment-specific and layered on separately (see README Security section).',
      },
      {
        id: 'AwsSolutions-APIG4',
        reason: 'Authorization is an orthogonal concern for this pattern comparison; the README shows how to add an authorizer.',
      },
      {
        id: 'AwsSolutions-COG4',
        reason: 'A Cognito user pool authorizer is one of several valid options; authN/Z is intentionally out of scope here.',
      },
    ],
    true,
  );
}
