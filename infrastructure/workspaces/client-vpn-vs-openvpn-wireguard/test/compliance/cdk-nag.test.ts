import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagPackSuppression, NagSuppressions } from 'cdk-nag';
import { buildStage } from '../helpers/stage';

const instanceSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-EC28',
    reason: 'Basic (5-minute) monitoring is enough for a verification environment; VPN health is checked by test-vpn.sh.',
  },
  {
    id: 'AwsSolutions-EC29',
    reason: 'Instances are disposable: key material lives in Secrets Manager and the stacks are destroyed after verification.',
  },
];

const ssmCoreSuppression: NagPackSuppression = {
  id: 'AwsSolutions-IAM4',
  reason: 'AmazonSSMManagedInstanceCore is the AWS-maintained minimum for Session Manager / Run Command (no SSH port is opened).',
  appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore'],
};

const selfHostedSuppressions: NagPackSuppression[] = [
  ...instanceSuppressions,
  ssmCoreSuppression,
  {
    id: 'AwsSolutions-EC23',
    reason:
      'A remote-access VPN must accept its UDP port from unpredictable home and mobile networks; only that one port is ' +
      'open and every packet is authenticated by the VPN protocol (TLS client certificate / WireGuard peer key).',
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'The CloudWatch agent creates per-instance log streams inside the server\'s own log group.',
    appliesTo: ['Resource::<ServerLogGroup8435EA51.Arn>:log-stream:*'],
  },
];

describe('CDK Nag AwsSolutions Pack', () => {
  const app = new cdk.App();
  const stage = buildStage({ app });
  const simulator = stage.clientSimulator;
  if (!simulator) {
    throw new Error('The test parameters must enable the client simulator');
  }

  NagSuppressions.addStackSuppressions(stage.target, instanceSuppressions);
  NagSuppressions.addStackSuppressions(stage.clientVpn, [
    {
      id: 'AwsSolutions-IAM4',
      reason: 'The connect handler only needs AWSLambdaBasicExecutionRole to write its decision log.',
      appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
    },
  ]);
  NagSuppressions.addStackSuppressions(stage.openVpn, selfHostedSuppressions);
  NagSuppressions.addStackSuppressions(stage.wireGuard, selfHostedSuppressions);
  NagSuppressions.addStackSuppressions(simulator, [
    ...instanceSuppressions,
    ssmCoreSuppression,
    {
      id: 'AwsSolutions-VPC7',
      reason: 'The simulator VPC only hosts the test client; tunnel traffic is logged by each VPN and the target VPC flow log.',
    },
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'The test client reads every client bundle and VPN parameter under this pattern\'s own prefix and exports the ' +
        'configuration of an endpoint whose ID is only known after deployment.',
    },
  ]);

  const stacks = [stage.target, stage.clientVpn, stage.openVpn, stage.wireGuard, simulator];
  // Aspects added to the App do not reach into a nested Stage; add them to the stage itself.
  cdk.Aspects.of(stage).add(new AwsSolutionsChecks({ verbose: true }));
  app.synth();

  test.each(stacks.map((s) => [s.stackName, s] as const))('%s has no unsuppressed findings', (_name, stack) => {
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    const findings = [...warnings, ...errors];
    if (findings.length > 0) {
      console.log(JSON.stringify(findings.map((f) => ({ id: f.id, entry: String(f.entry.data).slice(0, 120) })), null, 2));
    }
    expect(findings).toHaveLength(0);
  });
});
