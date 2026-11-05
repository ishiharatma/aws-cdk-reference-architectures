import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { Ec2ComputeStack } from 'lib/stacks/ec2-compute-stack';
import { EnvParams } from 'parameters/environments';
import { buildStacks } from 'test/helpers';

const { microvm, ec2, controlPlane, browserAccess, codeCommit } = buildStacks();
const microvmTemplate = Template.fromStack(microvm);
const ec2Template = Template.fromStack(ec2);
const controlPlaneTemplate = Template.fromStack(controlPlane);
const browserTemplate = Template.fromStack(browserAccess);

// Role policies for both compute types must name exactly the configured repositories.
function codeCommitResources(template: Template): string[] {
  const policies = Object.values(template.findResources('AWS::IAM::Policy')) as { Properties: { PolicyDocument: { Statement: { Sid?: string; Resource: unknown }[] } } }[];
  const statement = policies.flatMap((p) => p.Properties.PolicyDocument.Statement).find((s) => s.Sid === 'CodeCommitGitAccess');
  return (statement?.Resource as unknown[]).map((arn) => JSON.stringify(arn));
}

describe('CodeCommit', () => {
  test.each([['MicroVM', microvmTemplate], ['EC2', ec2Template]])('%s role reaches only the configured repositories', (_name, template) => {
    const resources = codeCommitResources(template);
    expect(resources).toHaveLength(3);
    for (const name of ['existing-a', 'existing-b', 'managed-a']) {
      expect(resources.some((arn) => arn.includes(`:${name}`))).toBe(true);
    }
    expect(resources.join()).not.toContain('*');
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Sid: 'CodeCommitGitAccess', Action: ['codecommit:GitPull', 'codecommit:GitPush'] })]) },
    });
  });

  test('only managed repositories are created, and they are deleted with the stack', () => {
    const template = Template.fromStack(codeCommit);
    template.resourceCountIs('AWS::CodeCommit::Repository', 1);
    template.hasResource('AWS::CodeCommit::Repository', {
      Properties: { RepositoryName: 'managed-a' },
      DeletionPolicy: 'Delete',
    });
  });
});

describe('MicrovmComputeStack', () => {
  test('no VPC and no secret: egress is the managed internet connector', () => {
    microvmTemplate.resourceCountIs('AWS::EC2::VPC', 0);
    microvmTemplate.resourceCountIs('AWS::SecretsManager::Secret', 0);
    microvmTemplate.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      CpuConfigurations: [{ Architecture: 'ARM_64' }],
      Hooks: Match.objectLike({ Port: 8080, MicrovmHooks: Match.objectLike({ Run: 'ENABLED' }) }),
    });
  });

  test('egress uses the managed internet connector', () => {
    const image = JSON.stringify(microvmTemplate.findResources('AWS::Lambda::MicrovmImage'));
    expect(image).toContain('aws-network-connector:INTERNET_EGRESS');
  });

  test('the execution role cannot read secrets or the sessions table', () => {
    const policies = JSON.stringify(microvmTemplate.findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('secretsmanager:');
    expect(policies).not.toContain('dynamodb:');
  });
});

describe('Ec2ComputeStack', () => {
  test('the security group has no inbound rule', () => {
    ec2Template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    ec2Template.hasResourceProperties('AWS::EC2::SecurityGroup', { SecurityGroupIngress: Match.absent() });
  });

  test('no instance exists at deploy time; the template requires IMDSv2 and encryption', () => {
    ec2Template.resourceCountIs('AWS::EC2::Instance', 0);
    ec2Template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        MetadataOptions: Match.objectLike({ HttpTokens: 'required' }),
        BlockDeviceMappings: [Match.objectLike({ Ebs: Match.objectLike({ Encrypted: true }) })],
      }),
    });
  });

  test('code-server binds to loopback', () => {
    const userData = JSON.stringify(ec2Template.findResources('AWS::EC2::LaunchTemplate'));
    expect(userData).toContain('--bind-addr 127.0.0.1:8080');
    expect(userData).not.toContain('0.0.0.0');
  });
});

describe('natType', () => {
  const stackWith = (ec2Params: EnvParams['ec2']): Template => Template.fromStack(new Ec2ComputeStack(new cdk.App(), 'Ec2', {
    project: 'test',
    environment: Environment.TEST,
    env: { account: '123456789012', region: 'ap-northeast-1' },
    params: {
      region: 'ap-northeast-1',
      microvm: { baseImageArn: 'arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1', baseImageVersion: '1' },
      ec2: ec2Params,
    },
  }));

  test('defaults to a NAT Gateway', () => {
    const template = stackWith({});
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::EC2::Instance', 0);
  });

  test('instance replaces the gateway and admits only this VPC', () => {
    const template = stackWith({ natType: 'instance' });
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't4g.micro', SourceDestCheck: false });
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: [Match.objectLike({ IpProtocol: '-1', CidrIp: Match.anyValue() })],
      GroupDescription: 'Security Group for NAT instances',
    });
  });
});

describe('ControlPlaneStack', () => {
  test('every route but the portal requires the JWT authorizer', () => {
    const routes = Object.values(controlPlaneTemplate.findResources('AWS::ApiGatewayV2::Route')) as { Properties: { RouteKey: string; AuthorizationType: string } }[];
    expect(routes).toHaveLength(8);
    for (const { Properties: route } of routes) {
      expect(route.AuthorizationType).toBe(route.RouteKey === 'GET /portal' ? 'NONE' : 'JWT');
    }
  });

  test('instance control is limited by tag', () => {
    controlPlaneTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['ec2:StartInstances', 'ec2:StopInstances', 'ec2:TerminateInstances'],
            Condition: { StringEquals: { 'aws:ResourceTag/CodeServerSessions': 'test-test-code-server-sessions' } },
          }),
        ]),
      },
    });
  });

  test('Session Manager is limited to tagged instances and the port forwarding document', () => {
    controlPlaneTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'PortForwardToTaggedInstance', Condition: { StringEquals: { 'ssm:resourceTag/CodeServerSessions': 'test-test-code-server-sessions' } } }),
          Match.objectLike({ Sid: 'PortForwardDocumentOnly', Action: 'ssm:StartSession' }),
        ]),
      },
    });
    const policies = JSON.stringify(controlPlaneTemplate.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('document/AWS-StartPortForwardingSession');
  });

  test('self sign-up is off and EC2 instances are swept on a schedule', () => {
    controlPlaneTemplate.hasResourceProperties('AWS::Cognito::UserPool', { AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } });
    controlPlaneTemplate.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(15 minutes)' });
  });
});

describe('BrowserAccessStack', () => {
  test('the default behavior routes through Lambda@Edge without caching; /__cp strips its prefix', () => {
    browserTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
          LambdaFunctionAssociations: Match.arrayWith([
            Match.objectLike({ EventType: 'origin-request' }),
            Match.objectLike({ EventType: 'origin-response' }),
          ]),
        }),
        CacheBehaviors: [Match.objectLike({ PathPattern: '/__cp/*', FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })] })],
      }),
    });
  });
});
