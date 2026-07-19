import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { BaseStack } from 'lib/stacks/base-stack';
import { Ec2SingleStack } from 'lib/stacks/ec2-single-stack';
import { Ec2AutoRecoveryStack } from 'lib/stacks/ec2-auto-recovery-stack';
import { Ec2AsgSingleStack } from 'lib/stacks/ec2-asg-single-stack';
import { Ec2AsgMultiStack } from 'lib/stacks/ec2-asg-multi-stack';
import { Ec2AsgMultiWarmStack } from 'lib/stacks/ec2-asg-multi-warm-stack';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

if (!params[envName]) throw new Error(`No parameters found for environment: ${envName}`);
const envParams = params[envName]!;

// ─── helpers ─────────────────────────────────────────────────────────────────

function printAnnotations(label: string, items: ReturnType<typeof Annotations.prototype.findError>) {
  if (items.length > 0) {
    console.log(`\n=== CDK Nag ${label} ===`);
    items.forEach((item, i) => {
      console.log(`\n${label} ${i + 1}:`);
      console.log(`  Path: ${item.id}`);
      console.log(`  Entry:`, JSON.stringify(item.entry, null, 2));
    });
    console.log('======================\n');
  }
}

function nagTest(stackName: string, stack: cdk.Stack) {
  describe(`CDK Nag AwsSolutions — ${stackName}`, () => {
    beforeAll(() => {
      applyCommonSuppressions(stack, stackName);
      cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    });

    test('No unsuppressed Warnings', () => {
      const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
      printAnnotations('Warning', warnings);
      expect(warnings).toHaveLength(0);
    });

    test('No unsuppressed Errors', () => {
      const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
      printAnnotations('Error', errors);
      expect(errors).toHaveLength(0);
    });
  });
}

// ─── suppression helper ───────────────────────────────────────────────────────

function applyCommonSuppressions(stack: cdk.Stack, _stackName: string): void {
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-EC29',
      reason: 'This is a reference architecture example. Termination protection is intentionally disabled for demo purposes.',
    },
    {
      id: 'AwsSolutions-IAM4',
      reason: 'AmazonSSMManagedInstanceCore is the recommended managed policy for SSM Session Manager access.',
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Wildcard permissions are from CDK-generated SSM Session Manager policy scoped to this account.',
    },
    {
      id: 'AwsSolutions-ELB2',
      reason: 'ALB access logging is omitted in this reference architecture example to reduce cost and complexity.',
    },
    {
      id: 'AwsSolutions-AS3',
      reason: 'ASG notifications are omitted in this reference architecture example.',
    },
    {
      id: 'AwsSolutions-EC26',
      reason: 'EBS volume encryption is enabled. CMK is not required for this reference architecture example.',
    },
    {
      id: 'AwsSolutions-EC28',
      reason: 'Detailed monitoring is not enabled in this reference architecture example to reduce cost.',
    },
  ], true);
}

// ─── tests per stack ─────────────────────────────────────────────────────────

const app = new cdk.App();

const base = new BaseStack(app, 'BaseStack', {
  project: projectName,
  environment: envName,
  env: defaultEnv,
  isAutoDeleteObject: true,
  config: envParams.vpcConfig,
});

nagTest('Ec2SingleStack', new Ec2SingleStack(app, 'Ec2SingleStack', {
  project: projectName,
  environment: envName,
  env: defaultEnv,
  isAutoDeleteObject: true,
  vpc: base.vpc,
  ec2Config: envParams.ec2Config,
}));

nagTest('Ec2AutoRecoveryStack', new Ec2AutoRecoveryStack(app, 'Ec2AutoRecoveryStack', {
  project: projectName,
  environment: envName,
  env: defaultEnv,
  isAutoDeleteObject: true,
  vpc: base.vpc,
  ec2Config: envParams.ec2Config,
}));

nagTest('Ec2AsgSingleStack', new Ec2AsgSingleStack(app, 'Ec2AsgSingleStack', {
  project: projectName,
  environment: envName,
  env: defaultEnv,
  isAutoDeleteObject: true,
  vpc: base.vpc,
  ec2Config: envParams.ec2Config,
  ports: envParams.ports,
  allowedIpsforAlb: ['203.0.113.0/24'],
}));

nagTest('Ec2AsgMultiStack', new Ec2AsgMultiStack(app, 'Ec2AsgMultiStack', {
  project: projectName,
  environment: envName,
  env: defaultEnv,
  isAutoDeleteObject: true,
  vpc: base.vpc,
  ec2Config: envParams.ec2Config,
  ports: envParams.ports,
  allowedIpsforAlb: ['203.0.113.0/24'],
}));

nagTest('Ec2AsgMultiWarmStack', new Ec2AsgMultiWarmStack(app, 'Ec2AsgMultiWarmStack', {
  project: projectName,
  environment: envName,
  env: defaultEnv,
  isAutoDeleteObject: true,
  vpc: base.vpc,
  ec2Config: envParams.ec2Config,
  ports: envParams.ports,
  allowedIpsforAlb: ['203.0.113.0/24'],
}));
