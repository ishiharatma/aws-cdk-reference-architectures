import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { VpnNames } from 'lib/vpn-names';

/** Properties for {@link ClientVpnStack}. */
export interface ClientVpnStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly envParams: EnvParams;
  readonly vpc: ec2.IVpc;
  readonly targetSecurityGroup: ec2.ISecurityGroup;
}

const SESSION_TIMEOUTS: Record<number, ec2.ClientVpnSessionTimeout> = {
  8: ec2.ClientVpnSessionTimeout.EIGHT_HOURS,
  10: ec2.ClientVpnSessionTimeout.TEN_HOURS,
  12: ec2.ClientVpnSessionTimeout.TWELVE_HOURS,
  24: ec2.ClientVpnSessionTimeout.TWENTY_FOUR_HOURS,
};

/**
 * Method A: AWS Client VPN with mutual (certificate) authentication.
 *
 * The server certificate is imported into ACM by `setup-pki.sh`; because client certificates are
 * issued by the same CA, the server certificate ARN is also given as the client CA. A client connect
 * handler Lambda adds a policy check after authentication, and connection logs go to CloudWatch Logs.
 */
export class ClientVpnStack extends cdk.Stack {
  /** The Client VPN endpoint. */
  readonly endpoint: ec2.IClientVpnEndpoint;

  /** Creates the resources described above. */
  constructor(scope: Construct, id: string, props: ClientVpnStackProps) {
    super(scope, id, props);
    const { clientVpn, logRetentionDays } = props.envParams;
    const names = new VpnNames(props.project, props.environment);

    const serverCertificateArn = ssm.StringParameter.valueForStringParameter(this, names.acmServerCertArnParam);

    const handlerLogGroup = new logs.LogGroup(this, 'ConnectHandlerLogGroup', {
      retention: logRetentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const connectHandler = new lambda.Function(this, 'ConnectHandler', {
      // Client VPN only invokes functions whose name starts with this prefix
      // (its service-linked role is scoped to AWSClientVPN-*).
      functionName: `AWSClientVPN-${props.project}-${props.environment}-connect-handler`,
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'src', 'client-vpn-connect-handler')),
      // Client VPN gives up after 30 seconds and denies the connection.
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: { DENIED_COMMON_NAMES: JSON.stringify(clientVpn.deniedCommonNames) },
      logGroup: handlerLogGroup,
    });

    const connectionLogGroup = new logs.LogGroup(this, 'ConnectionLogGroup', {
      retention: logRetentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Security group of the endpoint's ENIs: traffic from clients enters the VPC with this group
    // and with the ENI's private IP as the source (Client VPN source-NATs on VPC association).
    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: props.vpc,
      description: 'AWS Client VPN endpoint network interfaces',
      allowAllOutbound: false,
    });
    endpointSg.addEgressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(80), 'HTTP to the target');
    endpointSg.addEgressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.allIcmp(), 'ICMP to the target');

    const subnets = props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED });
    const endpoint = new ec2.ClientVpnEndpoint(this, 'Endpoint', {
      vpc: props.vpc,
      description: `${props.project}-${props.environment} Client VPN (mutual TLS)`,
      cidr: clientVpn.clientCidr,
      serverCertificateArn,
      clientCertificateArn: serverCertificateArn,
      splitTunnel: clientVpn.splitTunnel,
      transportProtocol: clientVpn.transportProtocol === 'udp' ? ec2.TransportProtocol.UDP : ec2.TransportProtocol.TCP,
      port: clientVpn.port === 443 ? ec2.VpnPort.HTTPS : ec2.VpnPort.OPENVPN,
      sessionTimeout: SESSION_TIMEOUTS[clientVpn.sessionTimeoutHours],
      clientLoginBanner: clientVpn.loginBanner,
      logging: true,
      logGroup: connectionLogGroup,
      clientConnectionHandler: connectHandler,
      securityGroups: [endpointSg],
      vpcSubnets: { subnets: subnets.subnets.slice(0, clientVpn.subnetAssociations) },
      // Authorization rule: every authenticated client may reach the VPC CIDR.
      authorizeAllUsersToVpcCidr: true,
    });

    this.endpoint = endpoint;

    addTargetIngress(this, 'TargetFromClientVpn', props.targetSecurityGroup, endpointSg, 'AWS Client VPN');

    new ssm.StringParameter(this, 'EndpointIdParam', {
      parameterName: names.clientVpnEndpointIdParam,
      stringValue: this.endpoint.endpointId,
    });
    new cdk.CfnOutput(this, 'ClientVpnEndpointId', { value: this.endpoint.endpointId });
  }
}

/**
 * Opens the target to one VPN's security group. Declared in the VPN stack (not the target stack)
 * so each VPN can be deployed and destroyed independently of the others.
 */
export function addTargetIngress(
  scope: Construct,
  id: string,
  targetSg: ec2.ISecurityGroup,
  sourceSg: ec2.ISecurityGroup,
  label: string,
): void {
  new ec2.CfnSecurityGroupIngress(scope, `${id}Http`, {
    groupId: targetSg.securityGroupId,
    sourceSecurityGroupId: sourceSg.securityGroupId,
    ipProtocol: 'tcp',
    fromPort: 80,
    toPort: 80,
    description: `HTTP from ${label}`,
  });
  new ec2.CfnSecurityGroupIngress(scope, `${id}Icmp`, {
    groupId: targetSg.securityGroupId,
    sourceSecurityGroupId: sourceSg.securityGroupId,
    ipProtocol: 'icmp',
    fromPort: -1,
    toPort: -1,
    description: `ICMP from ${label}`,
  });
}
