import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { buildStacks } from 'test/helpers';

/**
 * Each suppression maps to an item in README "Security Considerations".
 */
const suppressions = [
  { id: 'AwsSolutions-L1', reason: 'Runtimes are pinned to nodejs22.x and bumped deliberately for reproducible builds.' },
  { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole and AmazonSSMManagedInstanceCore are the AWS-recommended managed policies for logging and Session Manager.' },
  {
    id: 'AwsSolutions-IAM5',
    reason:
      'MicroVM identifiers are minted at RunMicrovm time and instance IDs at RunInstances time, so their ARNs are unknown before deployment; instance ' +
      'actions are limited by tag. DescribeInstances has no resource-level permissions. Bedrock foundation models use a Region wildcard for cross-region inference profiles.',
  },
  { id: 'AwsSolutions-APIG1', reason: 'Access logging is enabled on the HTTP API stage; this rule does not recognize that shape.' },
  { id: 'AwsSolutions-APIG4', reason: 'Every route has the Cognito JWT authorizer except GET /portal, a static page holding no data.' },
  { id: 'AwsSolutions-COG2', reason: 'MFA enforcement is environment-specific policy left to the operator (README).' },
  { id: 'AwsSolutions-COG4', reason: 'The JWT authorizer validates Cognito tokens; this rule does not recognize HttpApi authorizers.' },
  { id: 'AwsSolutions-COG8', reason: 'The Plus feature plan is a per-MAU cost the operator opts into per environment.' },
  { id: 'AwsSolutions-VPC7', reason: 'VPC Flow Logs are an environment-specific cost tradeoff left to the operator (README).' },
  { id: 'AwsSolutions-EC23', reason: 'The instance security group has no inbound rules at all.' },
  { id: 'AwsSolutions-CFR1', reason: 'Geo restriction depends on where the users are; left to the operator.' },
  { id: 'AwsSolutions-CFR2', reason: 'AWS WAF on the distribution is an environment-specific addition (README).' },
  { id: 'AwsSolutions-CFR3', reason: 'CloudFront access logging is an environment-specific addition (README).' },
  { id: 'AwsSolutions-CFR4', reason: 'The default CloudFront certificate cannot enforce a minimum TLS version; a custom domain removes this (README).' },
];

describe('CDK Nag AwsSolutions Pack', () => {
  const app = new cdk.App();
  const stacks = buildStacks(app);
  const all = [stacks.microvm, stacks.ec2, stacks.controlPlane, stacks.browserAccess];
  all.forEach((stack) => NagSuppressions.addStackSuppressions(stack, suppressions, true));
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  app.synth();

  test.each(all.map((s) => [s.stackName, s] as const))('%s has no unsuppressed findings', (_name, stack) => {
    const findings = [
      ...Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*')),
      ...Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*')),
    ];
    expect(findings.map((f) => `${f.id}: ${String(f.entry.data).slice(0, 120)}`)).toEqual([]);
  });
});
