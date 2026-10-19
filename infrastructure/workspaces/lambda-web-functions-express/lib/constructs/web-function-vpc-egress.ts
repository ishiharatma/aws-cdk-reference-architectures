import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/** Properties for {@link WebFunctionVpcEgress}. */
export interface WebFunctionVpcEgressProps {
  /** Name prefix for the connector. */
  readonly namePrefix: string;
  /** Number of Availability Zones for the connector subnets. */
  readonly maxAzs: number;
}

/**
 * VPC egress for a Lambda Web Function.
 *
 * Creates an isolated VPC (no NAT, no internet route) with a DynamoDB gateway endpoint,
 * and an `AWS::Lambda::NetworkConnector` (VPC_EGRESS, `WebFunction`) in its subnets.
 * A revision that references the connector sends its outbound traffic through the VPC,
 * so the app reaches DynamoDB over the gateway endpoint and nothing else.
 *
 * - The revision needs the version-qualified ARN (`LatestVersionArn`); the unqualified
 *   `Arn` is rejected.
 * - A VPC_EGRESS connector requires an operator role that Lambda assumes to manage ENIs.
 */
export class WebFunctionVpcEgress extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly connector: lambda.CfnNetworkConnector;
  /** Version-qualified connector ARN to pass to `serviceConfig.egressNetworkConnectorArn`. */
  public readonly connectorVersionArn: string;

  constructor(scope: Construct, id: string, props: WebFunctionVpcEgressProps) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: props.maxAzs,
      natGateways: 0,
      subnetConfiguration: [{ name: 'web-function', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
      gatewayEndpoints: { DynamoDb: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB } },
    });
    vpc.addFlowLog('FlowLog', { trafficType: ec2.FlowLogTrafficType.REJECT });
    this.vpc = vpc;

    const securityGroup = new ec2.SecurityGroup(this, 'ConnectorSecurityGroup', {
      vpc,
      description: 'Outbound HTTPS only for the Lambda Web Function (DynamoDB gateway endpoint)',
      allowAllOutbound: false,
    });
    securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to AWS APIs through VPC endpoints');

    const operatorRole = new iam.Role(this, 'ConnectorOperatorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Assumed by Lambda to manage ENIs for the Web Function egress connector',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],
    });

    this.connector = new lambda.CfnNetworkConnector(this, 'Connector', {
      name: `${props.namePrefix}-egress`,
      operatorRole: operatorRole.roleArn,
      configuration: {
        vpcEgressConfiguration: {
          associatedComputeResourceTypes: ['WebFunction'],
          subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
          securityGroupIds: [securityGroup.securityGroupId],
          networkProtocol: 'IPv4',
        },
      },
    });
    // The bundled cfn-lint schema only allows `MicroVm` here; `WebFunction` is valid in CloudFormation.
    cdk.Validations.of(this.connector).acknowledge({
      id: 'CloudFormation-Validate::W3030',
      reason: 'WebFunction is a valid AssociatedComputeResourceTypes value missing from the bundled cfn-lint schema',
    });
    this.connectorVersionArn = this.connector.attrLatestVersionArn;
  }
}
