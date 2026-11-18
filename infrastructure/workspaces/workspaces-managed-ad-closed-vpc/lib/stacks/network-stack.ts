import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ClosedVpc } from 'lib/constructs/closed-vpc';
import { NetworkParams } from 'lib/types';

/** Properties of {@link NetworkStack}. */
export interface NetworkStackProps extends cdk.StackProps {
  readonly namePrefix: string;
  readonly network: NetworkParams;
  readonly removalPolicy: cdk.RemovalPolicy;
}

/**
 * Closed VPC: no internet gateway, no NAT, interface endpoints for SSM / Secrets Manager / Logs,
 * subnets reserved for a future Transit Gateway attachment.
 */
export class NetworkStack extends cdk.Stack {
  public readonly network: ClosedVpc;

  /**

   * Define the resources.

   *
   * @param scope - Parent construct
   * @param id - Construct ID
   * @param props - Construct properties
   */
  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    this.network = new ClosedVpc(this, 'ClosedVpc', {
      namePrefix: props.namePrefix,
      network: props.network,
      removalPolicy: props.removalPolicy,
    });

    new cdk.CfnOutput(this, 'VpcId', { value: this.network.vpc.vpcId });
    new cdk.CfnOutput(this, 'TransitGatewaySubnetIds', {
      value: this.network.transitGateway.subnets.map((subnet) => subnet.subnetId).join(','),
      description: 'Reserved for the Transit Gateway attachment (not created)',
    });
  }
}
