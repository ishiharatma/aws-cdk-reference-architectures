import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { LambdaMicrovmsCodexAppserverStack } from 'lib/stacks/lambda-microvms-codex-appserver-stack';
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
  let stack: LambdaMicrovmsCodexAppserverStack;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new LambdaMicrovmsCodexAppserverStack(app, `${projectName}-${envName}-lambda-microvms-codex-appserver`, {
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
 * This reference isolates the MicroVM session lifecycle: authN/Z beyond a
 * Cognito JWT authorizer (WAF, request validation, MFA) is intentionally
 * out of scope, and several IAM actions are scoped to '*' because the
 * Lambda MicroVMs data-plane API operates on MicroVM/image identifiers
 * minted at RunMicrovm time, whose ARNs cannot be known ahead of
 * deployment. See README.md "Security Considerations" for what to add per
 * environment.
 */
function applySuppressions(stack: cdk.Stack): void {
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-L1',
        reason:
          'Control-plane function runtimes are intentionally pinned to nodejs22.x (the current Node.js LTS on ' +
          'Lambda) for reproducible builds; bumped deliberately rather than floating.',
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
          'lambda-microvms:* actions (RunMicrovm, GetMicrovm, SuspendMicrovm, ResumeMicrovm, TerminateMicrovm, ' +
          'CreateMicrovmAuthToken) operate on MicroVM/image identifiers generated at RunMicrovm time, so their ' +
          'resource ARNs are unknown ahead of deployment. DynamoDB grant*Data helpers add a table/index/* resource ' +
          'so secondary indexes remain reachable; both are limited to this session table and this MicroVM image.',
      },
      {
        id: 'AwsSolutions-APIG1',
        reason: 'Access logging is enabled on the single HTTP API stage via accessLogSettings; this rule flags the REST API shape it does not recognize on HttpApi.',
      },
      {
        id: 'AwsSolutions-APIG2',
        reason: 'Request validation is out of scope for this reference; the control-plane handlers validate their own JSON bodies/path parameters.',
      },
      {
        id: 'AwsSolutions-APIG3',
        reason: 'WAFv2 Web ACL association is environment-specific and layered on separately (see README Security section).',
      },
      {
        id: 'AwsSolutions-APIG4',
        reason: 'Every route requires the Cognito JWT authorizer (defaultAuthorizer); this rule does not recognize HttpApi JWT authorizers.',
      },
      {
        id: 'AwsSolutions-COG4',
        reason: 'The HTTP API uses a Cognito user pool JWT authorizer (HttpUserPoolAuthorizer) on every route; this rule does not recognize HttpApi authorizers.',
      },
      {
        id: 'AwsSolutions-COG2',
        reason: 'MFA enforcement is environment-specific policy left to the operator; out of scope for this reference architecture.',
      },
      {
        id: 'AwsSolutions-COG3',
        reason: 'Cognito advanced security features are a per-environment cost/security tradeoff left to the operator.',
      },
      {
        id: 'AwsSolutions-COG8',
        reason: 'The Plus feature plan (advanced security features) is an additional per-MAU cost the operator opts into per environment; not required for this reference.',
      },
      {
        id: 'AwsSolutions-SMG4',
        reason: 'Automatic rotation does not apply to a third-party (OpenAI) API key with no Secrets Manager rotation Lambda; the key is rotated manually per the README.',
      },
      {
        id: 'AwsSolutions-VPC7',
        reason: 'VPC Flow Logs are an environment-specific observability/cost tradeoff left to the operator for this reference.',
      },
      {
        id: 'AwsSolutions-EC23',
        reason: 'The egress security group only allows outbound traffic (allowAllOutbound); it has no inbound rules for MicroVMs to be reached through.',
      },
    ],
    true,
  );
}
