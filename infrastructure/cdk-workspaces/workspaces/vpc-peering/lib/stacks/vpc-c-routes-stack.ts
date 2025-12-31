import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { Environment } from "@common/parameters/environments";
import { EnvParams } from 'lib/types/vpc-peering-params';

export interface VpcCRoutesStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly vpc: ec2.IVpc;
    readonly vpcBCidr: string;
    readonly peeringIdParamName: string;
    readonly params: EnvParams;
}

/**
 * VPC C Routes Stack (Account B) with Custom Resource
 * 
 * This stack adds routes in VPC C (Account B) to VPC B (Account A)
 * Uses Custom Resource to read Peering Connection ID from Account A's Parameter Store
 * 
 * Prerequisites:
 * - VPC C must exist in Account B
 * - VPC Peering connection must be accepted
 * - Account A must have PeeringIdReadRole for cross-account access
 * 
 * Note: This stack should be deployed to Account B after:
 * 1. VpcCStack is deployed
 * 2. CrossAccountPeeringStack is deployed
 * 3. Peering connection is accepted in Account B
 */
export class VpcCRoutesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VpcCRoutesStackProps) {
    super(scope, id, props);

    // Use Custom Resource to read Peering Connection ID from Account A's Parameter Store
    // This requires assuming a role in Account A that has permission to read the parameter
    const regionA = props.params.regionA || props.env?.region;
    const parameterReadRoleArn = `arn:aws:iam::${props.params.accountAId}:role/${props.project}-${props.environment}-PeeringIdReadRole`;

    const getPeeringConnectionId = new cr.AwsCustomResource(this, 'GetPeeringConnectionId', {
      onUpdate: {
        service: 'SSM',
        action: 'getParameter',
        parameters: {
          Name: props.peeringIdParamName,
        },
        region: regionA,
        physicalResourceId: cr.PhysicalResourceId.of('PeeringConnectionIdLookup'),
        assumedRoleArn: parameterReadRoleArn,
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [parameterReadRoleArn],
        }),
      ]),
    });

    const peeringConnectionId = getPeeringConnectionId.getResponseField('Parameter.Value');

    // VPC Peering ConnectionのDNS解決オプションを許可するCustom Resource
    // (Account B側からピアVPCのDNS解決を有効化)
    const onCreate: cr.AwsSdkCall = {
        service: 'EC2',
        action: 'modifyVpcPeeringConnectionOptions',
        parameters: {
          VpcPeeringConnectionId: peeringConnectionId,
          AccepterPeeringConnectionOptions: {
            AllowDnsResolutionFromRemoteVpc: true,
          },
        },
        region: props.env?.region,
        physicalResourceId: cr.PhysicalResourceId.of(`EnableVpcPeeringDnsResolution:${peeringConnectionId}`),
      }
    const onUpdate = onCreate;
    const onDelete: cr.AwsSdkCall = {
        service: "EC2",
        action: "modifyVpcPeeringConnectionOptions",
        parameters: {
            VpcPeeringConnectionId: peeringConnectionId,
            AccepterPeeringConnectionOptions: {
                AllowDnsResolutionFromRemoteVpc: false,
            }
        },
    }
    new cr.AwsCustomResource(this, 'EnableVpcPeeringDnsResolution', {
      onUpdate,
      onCreate,
      onDelete,
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE}),
    });

    // target Subnet
    // private or isolated subnets
    const targetSubnets =
      (props.vpc.privateSubnets && props.vpc.privateSubnets.length > 0)
        ? props.vpc.privateSubnets
        : props.vpc.isolatedSubnets;
    // Add routes to VPC C private subnets pointing to VPC B
    targetSubnets.forEach((subnet, index) => {
      new ec2.CfnRoute(this, `VpcCToVpcBRoute${index + 1}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: props.vpcBCidr,
        vpcPeeringConnectionId: peeringConnectionId,
      });
    });

    // Stack outputs
    new cdk.CfnOutput(this, 'RoutesConfigured', {
      value: 'Routes successfully configured',
      description: 'VPC C routes configured for VPC B traffic',
    });

    new cdk.CfnOutput(this, 'VpcCId', {
      value: props.vpc.vpcId,
      description: 'VPC C ID',
    });

    new cdk.CfnOutput(this, 'PeeringConnectionIdUsed', {
      value: peeringConnectionId,
      description: 'Peering connection ID used for routes',
    });

    new cdk.CfnOutput(this, 'PeeringConnectionUsed', {
      value: peeringConnectionId,
      description: 'VPC Peering Connection ID used',
    });
  }
}
