import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildStacks } from 'test/helpers';

const { microvm, ec2, controlPlane, browserAccess } = buildStacks();
const microvmTemplate = Template.fromStack(microvm);
const ec2Template = Template.fromStack(ec2);
const controlPlaneTemplate = Template.fromStack(controlPlane);
const browserTemplate = Template.fromStack(browserAccess);

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
