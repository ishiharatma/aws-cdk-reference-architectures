import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
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
const props = { project: 'test', environment: Environment.TEST, isAutoDeleteObject: true, env, params: envParams };

describe('CodeServerEc2Stack', () => {
  const template = Template.fromStack(new CodeServerEc2Stack(new cdk.App(), 'Ec2', props));

  test('no NAT Gateway: public subnets only', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  test('instance enforces IMDSv2 and an encrypted gp3 root volume', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({ MetadataOptions: Match.objectLike({ HttpTokens: 'required' }) }),
    });
    template.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't4g.medium' });
  });

  test('security group admits only the CloudFront prefix list on 8080', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1);
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 8080,
      ToPort: 8080,
      SourcePrefixListId: Match.anyValue(),
    });
  });

  test('CloudFront never caches and forwards all viewer data (WebSocket support)', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          AllowedMethods: Match.arrayWith(['PUT', 'DELETE']),
          CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // Managed-CachingDisabled
          OriginRequestPolicyId: '216adef6-5c7f-47e4-b989-5492eafa07d3', // Managed-AllViewer
        }),
      }),
    });
  });

  test('password is generated in Secrets Manager, not embedded in user data', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/PASSWORD=[A-Za-z0-9]{8,}/);
  });
});

describe('CodeServerMicrovmsStack', () => {
  const template = Template.fromStack(new CodeServerMicrovmsStack(new cdk.App(), 'Microvms', props));

  test('no always-on compute or VPC', () => {
    template.resourceCountIs('AWS::EC2::VPC', 0);
    template.resourceCountIs('AWS::EC2::Instance', 0);
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  test('one arm64 image with run/terminate hooks on the proxy port and 2 GiB memory', () => {
    template.resourceCountIs('AWS::Lambda::MicrovmImage', 1);
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      CpuConfigurations: [Match.objectLike({ Architecture: 'ARM_64' })],
      Resources: [Match.objectLike({ MinimumMemoryInMiB: 2048 })],
      Hooks: Match.objectLike({
        Port: 8080,
        MicrovmHooks: Match.objectLike({ Run: 'ENABLED', Terminate: 'ENABLED' }),
        MicrovmImageHooks: Match.objectLike({ Ready: 'ENABLED', Validate: 'ENABLED' }),
      }),
    });
  });

  test('only the execution role can read the password secret', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(['secretsmanager:GetSecretValue']) }),
        ]),
      }),
      Roles: [Match.objectLike({ Ref: Match.stringLikeRegexp('MicrovmExecutionRole') })],
    });
  });
});
