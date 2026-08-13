import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { Ec2DualEniStack } from 'lib/stacks/ec2-dual-eni-stack';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

if (!params[envName]) throw new Error(`No parameters found for environment: ${envName}`);
const envParams = params[envName]!;

function buildStack(managementAllowedCidrs = ['203.0.113.0/24']) {
  const app = new cdk.App();
  return new Ec2DualEniStack(app, 'Stack', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
    envParams,
    managementAllowedCidrs,
  });
}

describe('Ec2DualEniStack', () => {
  let template: Template;

  beforeAll(() => {
    template = Template.fromStack(buildStack());
  });

  // ── VPC ───────────────────────────────────────────────────────────────

  test('VPC is created', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
  });

  test('public and isolated subnets exist', () => {
    // 1 AZ × 2 subnet types = 2 subnets
    template.resourceCountIs('AWS::EC2::Subnet', 2);
  });

  test('internet gateway is attached', () => {
    template.resourceCountIs('AWS::EC2::InternetGateway', 1);
    template.resourceCountIs('AWS::EC2::VPCGatewayAttachment', 1);
  });

  // ── Network interfaces ────────────────────────────────────────────────

  test('two network interfaces are created', () => {
    template.resourceCountIs('AWS::EC2::NetworkInterface', 2);
  });

  test('primary ENI (eth0) description mentions internet', () => {
    template.hasResourceProperties('AWS::EC2::NetworkInterface', {
      Description: Match.stringLikeRegexp('eth0'),
    });
  });

  test('management ENI (eth1) description mentions management', () => {
    template.hasResourceProperties('AWS::EC2::NetworkInterface', {
      Description: Match.stringLikeRegexp('eth1'),
    });
  });

  // ── Elastic IP ────────────────────────────────────────────────────────

  test('Elastic IP is created', () => {
    template.resourceCountIs('AWS::EC2::EIP', 1);
  });

  test('EIP is associated with the primary ENI', () => {
    template.resourceCountIs('AWS::EC2::EIPAssociation', 1);
    template.hasResourceProperties('AWS::EC2::EIPAssociation', {
      NetworkInterfaceId: Match.anyValue(),
    });
  });

  // ── Security groups ───────────────────────────────────────────────────

  test('web security group allows HTTP and HTTPS', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' }),
        Match.objectLike({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }),
      ]),
    });
  });

  test('management security group allows SSH only from specified CIDR', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '203.0.113.0/24' }),
      ]),
    });
  });

  // ── EC2 instance ──────────────────────────────────────────────────────

  test('EC2 instance is created', () => {
    template.resourceCountIs('AWS::EC2::Instance', 1);
  });

  test('instance has two network interfaces attached', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      NetworkInterfaces: Match.arrayWith([
        Match.objectLike({ DeviceIndex: '0' }),
        Match.objectLike({ DeviceIndex: '1' }),
      ]),
    });
  });

  test('IMDSv2 is enforced', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      MetadataOptions: {
        HttpTokens: 'required',
      },
    });
  });

  test('root EBS volume is encrypted with gp3', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: Match.arrayWith([
        Match.objectLike({
          Ebs: Match.objectLike({ Encrypted: true, VolumeType: 'gp3' }),
        }),
      ]),
    });
  });

  // ── IAM ───────────────────────────────────────────────────────────────

  test('instance role has SSM managed policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('AmazonSSMManagedInstanceCore'),
            ]),
          ]),
        }),
      ]),
    });
  });

  // ── Management CIDR override ──────────────────────────────────────────

  test('multiple management CIDRs create multiple SSH ingress rules', () => {
    const multiCidrStack = buildStack(['10.0.0.0/8', '192.168.1.0/24']);
    const multiTemplate = Template.fromStack(multiCidrStack);
    multiTemplate.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ CidrIp: '10.0.0.0/8', FromPort: 22 }),
        Match.objectLike({ CidrIp: '192.168.1.0/24', FromPort: 22 }),
      ]),
    });
  });
});
