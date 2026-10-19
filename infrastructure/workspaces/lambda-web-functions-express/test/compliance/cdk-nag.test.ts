import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { CloudfrontWafStack } from 'lib/stacks/cloudfront-waf-stack';
import { buildStack, envName, projectName, testEnv } from '../helpers/stack';

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
  test.each([
    ['default', false],
    ['with VPC egress', true],
  ])('main stack (%s) has no unsuppressed findings', (_label, vpcEgress) => {
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = buildStack(app, { vpcEgress: { enabled: vpcEgress as boolean, maxAzs: 2 } });
    applyMainStackSuppressions(stack);
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    app.synth();
    expectNoFindings(stack);
  });

  test('WAF stack has no unsuppressed findings', () => {
    const app = new cdk.App();
    const stack = new CloudfrontWafStack(app, 'CloudfrontWaf', {
      project: projectName,
      environment: envName,
      allowedIps: ['203.0.113.10'],
      rateLimitPerIp: 1000,
      env: { account: testEnv.account, region: 'us-east-1' },
    });
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    app.synth();
    expectNoFindings(stack);
  });
});

/**
 * Suppressions for the main stack. Each one is either a CDK-managed helper
 * (BucketDeployment / auto-delete custom resources) or a deliberate scope cut
 * documented in the README.
 */
function applyMainStackSuppressions(stack: cdk.Stack): void {
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSLambdaBasicExecutionRole is attached only to CDK-managed custom resource handlers ' +
          '(BucketDeployment, S3 auto-delete); the Web Function role uses scoped inline log permissions.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Wildcards are limited to: log streams under the function log groups (stream names are generated), ' +
          'DynamoDB grant*Data index/* resources, and CDK BucketDeployment object/asset access.',
      },
      {
        id: 'AwsSolutions-L1',
        reason:
          'Applies to the CDK-managed BucketDeployment / auto-delete handlers whose runtime is chosen by aws-cdk-lib. ' +
          'The Web Function itself runs nodejs24.x, the only Web Functions runtime.',
      },
      {
        id: 'AwsSolutions-S1',
        reason:
          'The code bucket only holds immutable deployment zips written by CloudFormation; access is audited via CloudTrail ' +
          'and server access logs add no value for this reference.',
      },
      {
        id: 'AwsSolutions-CFR1',
        reason: 'Geo restriction is a business decision; the WAF allow list and managed rules provide access control here.',
      },
      {
        id: 'AwsSolutions-CFR3',
        reason: 'CloudFront access logging is environment-specific; standard logging v2 can be added (see README).',
      },
      {
        id: 'AwsSolutions-CFR4',
        reason:
          'The default *.cloudfront.net certificate cannot enforce TLSv1.2 as minimum; a custom domain with ACM ' +
          '(then set minimumProtocolVersion TLS_V1_2_2021) removes this finding.',
      },
    ],
    true,
  );
}
