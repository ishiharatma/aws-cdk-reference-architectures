import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { MultiRegionDrStrategiesStage } from 'lib/stages/multi-region-dr-strategies-stage';
import { params } from 'parameters/environments';
import '../parameters';

const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

describe('CDK Nag AwsSolutions Pack', () => {
  let stacks: cdk.Stack[];

  beforeAll(() => {
    const app = new cdk.App();
    const stage = new MultiRegionDrStrategiesStage(app, 'Stage', {
      project: 'example',
      environment: envName,
      env: { account: '123456789012', region: envParams.primaryRegion },
      isAutoDeleteObject: true,
      terminationProtection: false,
      params: envParams,
      includeRecoveryStack: true,
    });
    stacks = stage.node.findAll().filter((c): c is cdk.Stack => c instanceof cdk.Stack);
    stacks.forEach(applySuppressions);
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    app.synth();
  });

  const findings = (level: 'warning' | 'error') => stacks.flatMap((stack) => {
    const found = level === 'error'
      ? Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))
      : Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    return found.map((f) => `${stack.stackName} ${f.id}: ${String(f.entry.data).split('\n')[0]}`);
  });

  test('No unsuppressed Warnings', () => {
    expect(findings('warning')).toEqual([]);
  });

  test('No unsuppressed Errors', () => {
    expect(findings('error')).toEqual([]);
  });
});

/** Suppressions are limited to costed features and demo-only choices; each states why. */
function applySuppressions(stack: cdk.Stack): void {
  NagSuppressions.addStackSuppressions(
    stack,
    [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole, the VPC execution policy and the AWS Backup service-role policies are the AWS-recommended managed policies.' },
      { id: 'AwsSolutions-IAM5', reason: 'AWS Backup service-role policies and log-group access use AWS-defined wildcards.' },
      { id: 'AwsSolutions-VPC7', reason: 'The VPC only associates the private hosted zone and has no traffic to log.' },
      { id: 'AwsSolutions-L1', reason: 'Runtime is the latest supported Node.js version at authoring time.' },
      { id: 'AwsSolutions-DDB3', reason: 'Point-in-time recovery is enabled on every table; the rule does not recognise the TableV2 form.' },
    ],
    true,
  );
}
