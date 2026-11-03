import { Match } from 'aws-cdk-lib/assertions';
import { cidrToNetmask, hostAddress } from 'lib/cidr';
import { renderTemplate } from 'lib/constructs/ubuntu';
import { buildStage, templates, testParams } from '../helpers/stage';

const userDataOf = (template: ReturnType<typeof templates>[string]): string => {
  const instances = template.findResources('AWS::EC2::Instance');
  const [instance] = Object.values(instances) as { Properties: { UserData: { 'Fn::Base64': unknown } } }[];
  return JSON.stringify(instance.Properties.UserData['Fn::Base64']);
};

describe('helpers', () => {
  test('cidrToNetmask converts prefix lengths for OpenVPN', () => {
    expect(cidrToNetmask('10.110.0.0/16')).toEqual({ network: '10.110.0.0', netmask: '255.255.0.0', prefix: 16 });
    expect(cidrToNetmask('10.121.0.0/24').netmask).toBe('255.255.255.0');
    expect(() => cidrToNetmask('10.0.0.0/33')).toThrow('Invalid IPv4 CIDR');
  });

  test('hostAddress returns the n-th address', () => {
    expect(hostAddress('10.122.0.0/24', 1)).toBe('10.122.0.1');
    expect(hostAddress('10.0.0.0/16', 256)).toBe('10.0.1.0');
  });

  test('renderTemplate fails on an unresolved placeholder', () => {
    expect(renderTemplate('a=@@A@@', { A: '1' })).toBe('a=1');
    expect(() => renderTemplate('a=@@A@@ b=@@B@@', { A: '1' })).toThrow('@@B@@');
  });
});

describe('ClientVpnVsOpenvpnWireguardStage', () => {
  const stage = buildStage();
  const t = templates(stage);

  describe('target', () => {
    test('VPC has public and isolated subnets but no NAT gateway', () => {
      t.target.resourceCountIs('AWS::EC2::NatGateway', 0);
      t.target.resourceCountIs('AWS::EC2::Subnet', 4);
      t.target.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'ALL' });
    });

    test('target server sits in an isolated subnet with IMDSv2 and an encrypted volume', () => {
      t.target.hasResourceProperties('AWS::EC2::Instance', {
        InstanceType: 't4g.nano',
        BlockDeviceMappings: [Match.objectLike({ Ebs: Match.objectLike({ Encrypted: true, VolumeType: 'gp3' }) })],
      });
      t.target.hasResourceProperties('AWS::EC2::LaunchTemplate', {
        LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
      });
    });

    test('target security group has no ingress of its own (each VPN stack adds one)', () => {
      t.target.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Private web server reachable only through a VPN',
        SecurityGroupIngress: Match.absent(),
      });
    });

    test('publishes target IP and VPC CIDR for the client simulator', () => {
      t.target.hasResourceProperties('AWS::SSM::Parameter', { Name: '/test/test/vpn/target/private-ip' });
      t.target.hasResourceProperties('AWS::SSM::Parameter', { Name: '/test/test/vpn/target/vpc-cidr' });
    });
  });

  describe('Client VPN', () => {
    test('endpoint uses mutual TLS with the ACM ARN from SSM for both server and client CA', () => {
      const endpoint = t.clientVpn.findResources('AWS::EC2::ClientVpnEndpoint');
      const props = (Object.values(endpoint)[0] as { Properties: Record<string, unknown> }).Properties;
      const auth = (props.AuthenticationOptions as { MutualAuthentication: { ClientRootCertificateChainArn: unknown } }[])[0];
      expect(auth.MutualAuthentication.ClientRootCertificateChainArn).toEqual(props.ServerCertificateArn);
      expect(JSON.stringify(t.clientVpn.toJSON().Parameters)).toContain('/test/test/vpn/acm/server-cert-arn');
    });

    test('endpoint settings follow the parameters', () => {
      t.clientVpn.hasResourceProperties('AWS::EC2::ClientVpnEndpoint', {
        ClientCidrBlock: '10.120.0.0/22',
        SplitTunnel: true,
        TransportProtocol: 'udp',
        VpnPort: 443,
        SessionTimeoutHours: 8,
        ClientLoginBannerOptions: { Enabled: true, BannerText: testParams().clientVpn.loginBanner },
        ConnectionLogOptions: Match.objectLike({ Enabled: true }),
        ClientConnectOptions: Match.objectLike({ Enabled: true }),
      });
    });

    test('is associated with one isolated subnet per AZ and authorizes the VPC CIDR', () => {
      t.clientVpn.resourceCountIs('AWS::EC2::ClientVpnTargetNetworkAssociation', 2);
      t.clientVpn.resourceCountIs('AWS::EC2::ClientVpnAuthorizationRule', 1);
    });

    test('connect handler name carries the AWSClientVPN- prefix and the deny list', () => {
      t.clientVpn.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'AWSClientVPN-test-test-connect-handler',
        Runtime: 'python3.14',
        Environment: { Variables: { DENIED_COMMON_NAMES: '["client2.vpn.internal"]' } },
      });
    });

    test('endpoint security group only reaches the VPC on HTTP and ICMP', () => {
      t.clientVpn.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'AWS Client VPN endpoint network interfaces',
        SecurityGroupEgress: Match.arrayWith([Match.objectLike({ IpProtocol: 'tcp', FromPort: 80, ToPort: 80 })]),
      });
    });
  });

  describe.each([
    ['openVpn', 1194, 'OpenVPN', 't4g.micro'],
    ['wireGuard', 51820, 'WireGuard', 't4g.nano'],
  ] as const)('%s server', (key, port, label, instanceType) => {
    test('opens only its UDP port to the configured CIDRs', () => {
      t[key].hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: `${label} server`,
        SecurityGroupIngress: [{ CidrIp: '0.0.0.0/0', IpProtocol: 'udp', FromPort: port, ToPort: port, Description: `${label} clients` }],
      });
    });

    test('runs in a public subnet behind an Elastic IP with source/dest check on', () => {
      t[key].hasResourceProperties('AWS::EC2::Instance', { InstanceType: instanceType, SourceDestCheck: true });
      t[key].resourceCountIs('AWS::EC2::EIP', 1);
    });

    test('adds HTTP and ICMP ingress to the target security group from its own group', () => {
      t[key].resourceCountIs('AWS::EC2::SecurityGroupIngress', 2);
      t[key].hasResourceProperties('AWS::EC2::SecurityGroupIngress', { IpProtocol: 'tcp', FromPort: 80, Description: `HTTP from ${label}` });
    });

    test('role can read only its own secret', () => {
      const policies = JSON.stringify(t[key].findResources('AWS::IAM::Policy'));
      const own = key === 'openVpn' ? 'openvpn' : 'wireguard';
      const other = key === 'openVpn' ? 'wireguard' : 'openvpn';
      expect(policies).toContain(`secret:/test/test/vpn/${own}/server-??????`);
      expect(policies).not.toContain(`/vpn/${other}/`);
      expect(policies).not.toContain('/vpn/clients/');
    });
  });

  test('OpenVPN user data pushes the VPC route and enforces the CRL', () => {
    const userData = userDataOf(t.openVpn);
    expect(userData).toContain("TUNNEL_NETWORK='10.121.0.0'");
    expect(userData).toContain("TUNNEL_NETMASK='255.255.255.0'");
    expect(userData).toContain("VPC_NETWORK='10.110.0.0'");
    expect(userData).toContain("VPC_NETMASK='255.255.0.0'");
    expect(userData).toContain('route $VPC_NETWORK $VPC_NETMASK');
    expect(userData).toContain('crl-verify /etc/openvpn/server/crl.pem');
    expect(userData).toContain("SECRET_ID='/test/test/vpn/openvpn/server'");
  });

  test('WireGuard user data uses the first tunnel address and the peer list parameter', () => {
    const userData = userDataOf(t.wireGuard);
    expect(userData).toContain("SERVER_ADDRESS='10.122.0.1/24'");
    // Pinned below the 1500-byte internet path (wg-quick would pick 8921 from the 9001 ENI MTU).
    expect(userData).toContain('MTU = 1420');
    expect(userData).toContain("PEERS_PARAM='/test/test/vpn/wireguard/peers'");
    t.wireGuard.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'ssm:GetParameter' })]) },
    });
  });

  test('client simulator lives in its own VPC and can export the Client VPN profile', () => {
    t.clientSimulator.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.200.0.0/16' });
    t.clientSimulator.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: 'ec2:ExportClientVpnClientConfiguration' })]),
      },
    });
    t.clientSimulator.resourceCountIs('AWS::EC2::VPCPeeringConnection', 0);
  });

  test('client simulator can be disabled', () => {
    const noSim = buildStage({ overrides: { clientSimulator: { ...testParams().clientSimulator, enabled: false } } });
    expect(noSim.clientSimulator).toBeUndefined();
  });

  test('VPN stacks depend on the target stack only', () => {
    for (const s of [stage.clientVpn, stage.openVpn, stage.wireGuard]) {
      expect(s.dependencies.map((d) => d.stackName)).toEqual([stage.target.stackName]);
    }
  });
});
