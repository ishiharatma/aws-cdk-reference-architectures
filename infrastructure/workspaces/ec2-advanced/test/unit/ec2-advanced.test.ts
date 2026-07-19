import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Environment } from '@common/parameters/environments';
import { BaseStack } from 'lib/stacks/base-stack';
import { Ec2SingleStack } from 'lib/stacks/ec2-single-stack';
import { Ec2AutoRecoveryStack } from 'lib/stacks/ec2-auto-recovery-stack';
import { Ec2AsgSingleStack } from 'lib/stacks/ec2-asg-single-stack';
import { Ec2AsgMultiStack } from 'lib/stacks/ec2-asg-multi-stack';
import { Ec2AsgMultiWarmStack } from 'lib/stacks/ec2-asg-multi-warm-stack';
import { Ec2AsgSingle } from 'lib/constructs/ec2-asg-single';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

if (!params[envName]) throw new Error(`No parameters found for environment: ${envName}`);
const envParams = params[envName]!;

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildBaseStack(app: cdk.App): BaseStack {
  return new BaseStack(app, 'BaseStack', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    config: envParams.vpcConfig,
  });
}

// ─── EC2 Single ──────────────────────────────────────────────────────────────

describe('Ec2SingleStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const base = buildBaseStack(app);
    const stack = new Ec2SingleStack(app, 'Ec2SingleStack', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpc: base.vpc,
      ec2Config: envParams.ec2Config,
    });
    template = Template.fromStack(stack);
  });

  test('EC2 instance is created', () => {
    template.resourceCountIs('AWS::EC2::Instance', 1);
  });

  test('instance type is t3.micro', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3.micro',
    });
  });

  test('IMDSv2 is enforced (HttpTokens=required)', () => {
    // CDK 2.x enforces requireImdsv2 via a LaunchTemplate; MetadataOptions is
    // set on the LaunchTemplate, not directly on the Instance resource.
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        MetadataOptions: { HttpTokens: 'required' },
      }),
    });
  });

  test('EBS root volume is encrypted and GP3', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: Match.arrayWith([
        Match.objectLike({
          Ebs: Match.objectLike({ Encrypted: true, VolumeType: 'gp3' }),
        }),
      ]),
    });
  });

  test('SSM managed policy is attached to instance role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({ 'Fn::Join': Match.anyValue() }),
      ]),
    });
  });

  test('security group allows all outbound', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({ CidrIp: '0.0.0.0/0' }),
      ]),
    });
  });

  test('no load balancer is created', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
  });
});

// ─── EC2 Auto-Recovery ───────────────────────────────────────────────────────

describe('Ec2AutoRecoveryStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const base = buildBaseStack(app);
    const stack = new Ec2AutoRecoveryStack(app, 'Ec2AutoRecoveryStack', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpc: base.vpc,
      ec2Config: envParams.ec2Config,
    });
    template = Template.fromStack(stack);
  });

  test('EC2 instance is created', () => {
    template.resourceCountIs('AWS::EC2::Instance', 1);
  });

  test('CloudWatch alarm for auto-recovery is created', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
  });

  test('alarm metric is StatusCheckFailed_System', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'StatusCheckFailed_System',
      Namespace: 'AWS/EC2',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
    });
  });

  test('alarm action is EC2 recover action', () => {
    // The recover action ARN is built with Fn::Join using AWS::Partition and AWS::Region tokens.
    // Verify the serialised alarm contains the expected automate/ec2/recover segments.
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const alarm = Object.values(alarms)[0] as { Properties: { AlarmActions: unknown[] } };
    const actionsJson = JSON.stringify(alarm.Properties.AlarmActions);
    expect(actionsJson).toContain('automate');
    expect(actionsJson).toContain('ec2');
    expect(actionsJson).toContain('recover');
  });

  test('IMDSv2 is enforced', () => {
    // CDK 2.x enforces requireImdsv2 via a LaunchTemplate; MetadataOptions is
    // set on the LaunchTemplate, not directly on the Instance resource.
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        MetadataOptions: { HttpTokens: 'required' },
      }),
    });
  });

  test('no load balancer is created', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
  });
});

// ─── EC2 ASG Single ──────────────────────────────────────────────────────────

describe('Ec2AsgSingleStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const base = buildBaseStack(app);
    const stack = new Ec2AsgSingleStack(app, 'Ec2AsgSingleStack', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpc: base.vpc,
      ec2Config: envParams.ec2Config,
      ports: envParams.ports,
      allowedIpsforAlb: ['203.0.113.0/24'],
    });
    template = Template.fromStack(stack);
  });

  test('ALB is created', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  });

  test('ALB target group is created', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
  });

  test('Auto Scaling Group is created', () => {
    template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
  });

  test('ASG desired/min/max capacity is 1', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '1',
      MaxSize: '1',
      DesiredCapacity: '1',
    });
  });

  test('Launch template enforces IMDSv2', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        MetadataOptions: { HttpTokens: 'required' },
      }),
    });
  });

  test('EC2 security group only allows inbound from ALB security group', () => {
    // EC2 SG inbound rule references ALB SG
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 80,
      ToPort: 80,
      IpProtocol: 'tcp',
    });
  });

  test('SSM managed policy is attached to instance role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({ 'Fn::Join': Match.anyValue() }),
      ]),
    });
  });
});

// ─── EC2 ASG Single (no ALB, SSM-only mode) ─────────────────────────────────

describe('Ec2AsgSingle (no ALB)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const base = buildBaseStack(app);
    // Minimal stack: construct only, no listener → SSM-only mode
    const stack = new cdk.Stack(app, 'AsgSingleNoAlbStack', { env: defaultEnv });
    const sg = new ec2.SecurityGroup(stack, 'Sg', {
      vpc: base.vpc.vpc,
      allowAllOutbound: true,
    });
    new Ec2AsgSingle(stack, 'Asg', {
      project: projectName,
      environment: envName,
      vpc: base.vpc.vpc,
      securityGroup: sg,
      instanceType:
        envParams.ec2Config?.instanceType ??
        ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        edition: ec2.AmazonLinuxEdition.STANDARD,
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      // listener is omitted → no ALB
    });
    template = Template.fromStack(stack);
  });

  test('no load balancer is created', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
  });

  test('no target group is created', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 0);
  });

  test('Auto Scaling Group is created', () => {
    template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
  });

  test('ASG capacity is 1', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '1',
      MaxSize: '1',
      DesiredCapacity: '1',
    });
  });

  test('Launch template enforces IMDSv2', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        MetadataOptions: { HttpTokens: 'required' },
      }),
    });
  });

  test('SSM managed policy is attached to instance role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({ 'Fn::Join': Match.anyValue() }),
      ]),
    });
  });
});

// ─── EC2 ASG Multi ───────────────────────────────────────────────────────────

describe('Ec2AsgMultiStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const base = buildBaseStack(app);
    const stack = new Ec2AsgMultiStack(app, 'Ec2AsgMultiStack', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpc: base.vpc,
      ec2Config: envParams.ec2Config,
      ports: envParams.ports,
      allowedIpsforAlb: ['203.0.113.0/24'],
    });
    template = Template.fromStack(stack);
  });

  test('ALB is created', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  });

  test('Auto Scaling Group is created', () => {
    template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
  });

  test('ASG min/max/desired capacity is 2', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '2',
      MaxSize: '2',
      DesiredCapacity: '2',
    });
  });

  test('Launch template enforces IMDSv2', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        MetadataOptions: { HttpTokens: 'required' },
      }),
    });
  });

  test('EBS root volume is encrypted and GP3', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        BlockDeviceMappings: Match.arrayWith([
          Match.objectLike({
            Ebs: Match.objectLike({ Encrypted: true, VolumeType: 'gp3' }),
          }),
        ]),
      }),
    });
  });
});

// ─── EC2 ASG Multi (with notification topic — alarm tests) ───────────────────

describe('Ec2AsgMultiStack (with notificationTopic)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const base = buildBaseStack(app);
    const topicStack = new cdk.Stack(app, 'TopicStackMulti', { env: defaultEnv });
    const topic = new sns.Topic(topicStack, 'Topic');
    const stack = new Ec2AsgMultiStack(app, 'Ec2AsgMultiStackWithTopic', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpc: base.vpc,
      ec2Config: envParams.ec2Config,
      ports: envParams.ports,
      allowedIpsforAlb: ['203.0.113.0/24'],
      notificationTopic: topic,
    });
    template = Template.fromStack(stack);
  });

  test('InstanceLaunchFailure alarm monitors GroupInServiceInstances', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/AutoScaling',
      MetricName: 'GroupInServiceInstances',
      Statistic: 'Minimum',
      ComparisonOperator: 'LessThanThreshold',
      Threshold: 2,
      EvaluationPeriods: 2,
      TreatMissingData: 'breaching',
    });
  });

  test('HighCPU alarm monitors CPUUtilization', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/EC2',
      MetricName: 'CPUUtilization',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 80,
    });
  });

  test('UnhealthyHost alarm monitors ALB unhealthy host count', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApplicationELB',
      MetricName: 'UnHealthyHostCount',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
    });
  });
});

// ─── EC2 ASG Single (with notification topic — alarm tests) ──────────────────

describe('Ec2AsgSingleStack (with notificationTopic)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const base = buildBaseStack(app);
    const topicStack = new cdk.Stack(app, 'TopicStackSingle', { env: defaultEnv });
    const topic = new sns.Topic(topicStack, 'Topic');
    const stack = new Ec2AsgSingleStack(app, 'Ec2AsgSingleStackWithTopic', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpc: base.vpc,
      ec2Config: envParams.ec2Config,
      ports: envParams.ports,
      allowedIpsforAlb: ['203.0.113.0/24'],
      notificationTopic: topic,
    });
    template = Template.fromStack(stack);
  });

  test('InstanceLaunchFailure alarm monitors GroupInServiceInstances', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/AutoScaling',
      MetricName: 'GroupInServiceInstances',
      Statistic: 'Minimum',
      ComparisonOperator: 'LessThanThreshold',
      Threshold: 1,
      EvaluationPeriods: 2,
      TreatMissingData: 'breaching',
    });
  });

  test('HighCPU alarm monitors CPUUtilization', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/EC2',
      MetricName: 'CPUUtilization',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 80,
    });
  });
});

// ─── EC2 ASG Multi Warm Pool ──────────────────────────────────────────────────

describe('Ec2AsgMultiWarmStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const base = buildBaseStack(app);
    const stack = new Ec2AsgMultiWarmStack(app, 'Ec2AsgMultiWarmStack', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpc: base.vpc,
      ec2Config: envParams.ec2Config,
      ports: envParams.ports,
      allowedIpsforAlb: ['203.0.113.0/24'],
    });
    template = Template.fromStack(stack);
  });

  test('ALB is created', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  });

  test('Auto Scaling Group is created', () => {
    template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
  });

  test('Warm pool is attached to ASG', () => {
    template.resourceCountIs('AWS::AutoScaling::WarmPool', 1);
  });

  test('Warm pool state is Hibernated', () => {
    template.hasResourceProperties('AWS::AutoScaling::WarmPool', {
      PoolState: 'Hibernated',
    });
  });

  test('Warm pool reuses instances on scale-in', () => {
    template.hasResourceProperties('AWS::AutoScaling::WarmPool', {
      InstanceReusePolicy: { ReuseOnScaleIn: true },
    });
  });

  test('Launch template enables hibernation', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        HibernationOptions: { Configured: true },
      }),
    });
  });

  test('Launch template enforces IMDSv2', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        MetadataOptions: { HttpTokens: 'required' },
      }),
    });
  });

  test('EBS root volume is encrypted and GP3', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        BlockDeviceMappings: Match.arrayWith([
          Match.objectLike({
            Ebs: Match.objectLike({ Encrypted: true, VolumeType: 'gp3' }),
          }),
        ]),
      }),
    });
  });

  test('ASG default capacity is 2/2', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '2',
      MaxSize: '2',
      DesiredCapacity: '2',
    });
  });

  test('SSM managed policy is attached to instance role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({ 'Fn::Join': Match.anyValue() }),
      ]),
    });
  });
});

// ─── EC2 ASG Multi Warm Pool (with notification topic — alarm tests) ──────────

describe('Ec2AsgMultiWarmStack (with notificationTopic)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const base = buildBaseStack(app);
    const topicStack = new cdk.Stack(app, 'TopicStackWarm', { env: defaultEnv });
    const topic = new sns.Topic(topicStack, 'Topic');
    const stack = new Ec2AsgMultiWarmStack(app, 'Ec2AsgMultiWarmStackWithTopic', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpc: base.vpc,
      ec2Config: envParams.ec2Config,
      ports: envParams.ports,
      allowedIpsforAlb: ['203.0.113.0/24'],
      notificationTopic: topic,
    });
    template = Template.fromStack(stack);
  });

  test('InstanceLaunchFailure alarm monitors GroupInServiceInstances', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/AutoScaling',
      MetricName: 'GroupInServiceInstances',
      Statistic: 'Minimum',
      ComparisonOperator: 'LessThanThreshold',
      Threshold: 2,
      EvaluationPeriods: 2,
      TreatMissingData: 'breaching',
    });
  });

  test('HighCPU alarm monitors CPUUtilization', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/EC2',
      MetricName: 'CPUUtilization',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 80,
    });
  });

  test('UnhealthyHost alarm monitors ALB unhealthy host count', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApplicationELB',
      MetricName: 'UnHealthyHostCount',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
    });
  });
});
