import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { buildMainStack, buildWafStack, newApp } from '../helpers/stack';

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
  test('main stack has no unsuppressed findings', () => {
    const app = newApp();
    const stack = buildMainStack(app);
    applyMainStackSuppressions(stack);
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    app.synth();
    expectNoFindings(stack);
  });

  test('WAF stack has no unsuppressed findings', () => {
    const app = newApp();
    const stack = buildWafStack(app);
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    app.synth();
    expectNoFindings(stack);
  });
});

/**
 * Suppressions for the main stack. Each one is a deliberate scope cut of this
 * verification architecture, documented in the README.
 */
function applyMainStackSuppressions(stack: cdk.Stack): void {
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'The origin function uses AWSLambdaBasicExecutionRole only (CloudWatch Logs); it calls no AWS APIs.',
      },
      {
        id: 'AwsSolutions-VPC7',
        reason: 'The VPC only hosts the internet-facing ALB; ALB and WAF logs cover the traffic of interest.',
      },
      {
        id: 'AwsSolutions-ELB2',
        reason: 'WAF logs (both Web ACLs) record every request with the matched rules; ALB access logs are omitted.',
      },
      {
        id: 'AwsSolutions-EC23',
        reason: 'Ingress is limited to the CloudFront origin-facing prefix list and the verification client /32.',
      },
      {
        id: 'AwsSolutions-SMG4',
        reason: 'The origin verify value is static per deployment; rotate by redeploying (see README).',
      },
      {
        id: 'AwsSolutions-CFR1',
        reason: 'Geo restriction is a business decision; the WAF IP allow list restricts this verification stack.',
      },
      {
        id: 'AwsSolutions-CFR3',
        reason: 'CloudFront access logging is omitted; WAF logs record every request with the matched rules.',
      },
      {
        id: 'AwsSolutions-CFR4',
        reason: 'The default *.cloudfront.net certificate cannot enforce TLSv1.2; use a custom domain with ACM in production.',
      },
      {
        id: 'AwsSolutions-CFR5',
        reason:
          'CloudFront reaches the ALB over HTTP because the verification stack has no domain or certificate; ' +
          'production should use an HTTPS listener (README: Security considerations).',
      },
    ],
    true,
  );
}
