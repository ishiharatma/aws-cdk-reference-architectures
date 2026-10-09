import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { CodeServerEc2Stack } from 'lib/stacks/code-server-ec2-stack';
import { CodeServerMicrovmsStack } from 'lib/stacks/code-server-microvms-stack';
import { params } from 'parameters/environments';
import '../parameters';

const env = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for the test environment');
}
const props = { project: 'test', environment: Environment.TEST, isAutoDeleteObject: false, env, params: envParams };

describe('CDK Nag AwsSolutions Pack', () => {
  let stacks: cdk.Stack[];

  beforeAll(() => {
    const app = new cdk.App();
    const ec2Stack = new CodeServerEc2Stack(app, 'Ec2', props);
    const microvmsStack = new CodeServerMicrovmsStack(app, 'Microvms', props);
    stacks = [ec2Stack, microvmsStack];

    NagSuppressions.addStackSuppressions(ec2Stack, [
      { id: 'AwsSolutions-VPC7', reason: 'Reference pattern: VPC flow logs would dominate the cost of a single-instance demo.' },
      { id: 'AwsSolutions-EC28', reason: 'Single-instance demo; detailed monitoring is not required.' },
      { id: 'AwsSolutions-EC29', reason: 'Single-instance demo; termination protection would block cdk destroy.' },
      { id: 'AwsSolutions-CFR1', reason: 'Access is controlled by the code-server password; geo restriction is not part of this pattern.' },
      { id: 'AwsSolutions-CFR2', reason: 'WAF for CloudFront must live in us-east-1; documented as a hardening step in the README.' },
      { id: 'AwsSolutions-CFR3', reason: 'Access logging omitted to keep the demo free of extra buckets; documented in the README.' },
      { id: 'AwsSolutions-CFR4', reason: 'The default CloudFront certificate is used; TLS_V1_2_2021 applies once a custom domain is attached.' },
      { id: 'AwsSolutions-CFR5', reason: 'Origin is HTTP-only because the instance has no certificate; the origin SG admits only CloudFront IPs.' },
      { id: 'AwsSolutions-SMG4', reason: 'Login password for a demo environment; rotation is not required.' },
      { id: 'AwsSolutions-IAM5', reason: 'Only the Region segment of the Bedrock foundation-model ARN is a wildcard: cross-region inference profiles route to foundation models in other Regions.' },
      { id: 'AwsSolutions-IAM4', reason: 'AmazonSSMManagedInstanceCore is the AWS-recommended policy for Session Manager.' },
    ], true);

    NagSuppressions.addStackSuppressions(microvmsStack, [
      { id: 'AwsSolutions-SMG4', reason: 'Login password for a demo environment; rotation is not required.' },
      { id: 'AwsSolutions-IAM5', reason: 'Build role needs read on the asset bucket prefix; the Bedrock foundation-model ARN wildcards only its Region segment (cross-region inference profiles).' },
    ], true);

    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  });

  test.each([0, 1])('stack %i has no unsuppressed warnings or errors', (i) => {
    const pattern = Match.stringLikeRegexp('AwsSolutions-.*');
    expect(Annotations.fromStack(stacks[i]).findWarning('*', pattern)).toHaveLength(0);
    expect(Annotations.fromStack(stacks[i]).findError('*', pattern)).toHaveLength(0);
  });
});
