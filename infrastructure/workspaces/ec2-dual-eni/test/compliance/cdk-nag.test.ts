import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { Ec2DualEniStack } from 'lib/stacks/ec2-dual-eni-stack';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'example';
const envName: Environment = Environment.TEST;

if (!params[envName]) throw new Error(`No parameters found for environment: ${envName}`);
const envParams = params[envName]!;

function applySuppressions(stack: cdk.Stack) {
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-EC28',
      reason: 'Detailed monitoring is not required for this reference pattern.',
    },
    {
      id: 'AwsSolutions-EC29',
      reason: 'Auto Scaling is not part of this single-instance reference pattern.',
    },
    {
      id: 'AwsSolutions-IAM4',
      reason: 'AmazonSSMManagedInstanceCore is an AWS-managed policy used intentionally for SSM access.',
    },
  ]);
}

describe('CDK Nag AwsSolutions Pack', () => {
  let app: cdk.App;
  let stack: Ec2DualEniStack;

  beforeAll(() => {
    app = new cdk.App();

    stack = new Ec2DualEniStack(app, `${projectName}-${envName}`, {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: false,
      terminationProtection: false,
      env: defaultEnv,
      envParams,
      managementAllowedCidrs: ['203.0.113.0/24'],
      webAllowedCidrs: ['192.0.2.1/32'],
    });

    applySuppressions(stack);

    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    app.synth();
  });

  test('no unsuppressed errors', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    if (errors.length > 0) {
      console.log('CDK Nag errors:', JSON.stringify(errors, null, 2));
    }
    expect(errors).toHaveLength(0);
  });
});
