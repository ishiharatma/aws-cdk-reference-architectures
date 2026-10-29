import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { NetworkParams } from 'parameters/environments';

/** Properties for {@link NetworkStack}. */
export interface NetworkStackProps extends cdk.StackProps {
  readonly network: NetworkParams;
  readonly logRetentionDays: number;
}

/**
 * VPC shared by both clusters so they differ only in how compute and load balancing are managed.
 *
 * Subnets carry the role tags that the AWS Load Balancer Controller and EKS Auto Mode both use
 * to choose ALB subnets: `kubernetes.io/role/elb` (public) and `kubernetes.io/role/internal-elb`.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;

  /** Creates the VPC, subnet role tags and the REJECT flow log. */
  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.network.vpcCidr),
      maxAzs: props.network.maxAzs,
      natGateways: props.network.natGateways,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        // Pods take VPC IPs (VPC CNI / Auto Mode), so the private subnets get the larger range.
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
      ],
    });
    this.vpc = vpc;
    for (const subnet of vpc.publicSubnets) {
      cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
    }
    for (const subnet of vpc.privateSubnets) {
      cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
    }

    vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'FlowLogGroup', {
          retention: props.logRetentionDays,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      ),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });
  }
}
