import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { Environment } from "@common/parameters/environments";
import { EnvParams } from 'lib/types/vpc-peering-params';

export interface CrossAccountPeeringStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
    readonly requestorVpc: ec2.IVpc;
    readonly requestorVpcCidr: string;
    readonly peeringVpcCidr: string;
    readonly peeringRoleName: string;
}

/**
 * Cross-Account VPC Peering Stack (with Custom Resource)
 * 
 * This stack creates:
 * - VPC Peering connection between VPC B (Account A) and VPC C (Account B)
 * - Routes in VPC B route tables to VPC C
 * 
 * This stack uses AWS Custom Resource to automatically retrieve VPC C ID from
 * Account B's Parameter Store, eliminating the need for manual parameter passing.
 * 
 * Note: 
 * - This stack should be deployed to Account A
 * - VPC C Stack must be deployed to Account B first
 * - Peering connection must be accepted in Account B
 * - Route tables in VPC C must be updated via VpcCRoutesStack in Account B
 */
export class CrossAccountPeeringStack extends cdk.Stack {
  public readonly peeringConnection: ec2.CfnVPCPeeringConnection;
  public readonly peeringConnectionId: string;

  constructor(scope: Construct, id: string, props: CrossAccountPeeringStackProps) {
    super(scope, id, props);

    if (!props.params.accountBId) {
      throw new Error('Account B ID is required for cross-account peering');
    }

    if (!props.params.vpcCConfig) {
      throw new Error('VPC C configuration is required for cross-account peering');
    }

    const region = props.params.regionB || props.env?.region;
    const parameterName = `/${props.project}/${props.environment}/vpc-c/id`;
    const parameterReadRoleArn = `arn:aws:iam::${props.params.accountBId}:role/${props.project}-${props.environment}-ParameterStoreReadRole`;

    // Use Custom Resource to read VPC C ID from Account B's Parameter Store
    // This requires assuming a role in Account B that has permission to read the parameter
    const getVpcCId = new cr.AwsCustomResource(this, 'GetVpcCId', {
      onUpdate: {
        service: 'SSM',
        action: 'getParameter',
        parameters: {
          Name: parameterName,
        },
        region: region,
        physicalResourceId: cr.PhysicalResourceId.of('VpcCIdLookup'),
        assumedRoleArn: parameterReadRoleArn,
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [parameterReadRoleArn],
        }),
      ]),
    });

    const vpcCId = getVpcCId.getResponseField('Parameter.Value');

    // Create VPC Peering Connection from VPC B (Account A) to VPC C (Account B)
    const peeringTags = [
      {
        key: 'Name',
        value: `${props.project}-${props.environment}-VpcB-VpcC-Peering`,
      },
    ];

    // Add custom tags from params
    if (props.params.tags) {
      Object.entries(props.params.tags).forEach(([key, value]) => {
        peeringTags.push({
          key: key,
          value: value,
        });
      });
    }

    this.peeringConnection = new ec2.CfnVPCPeeringConnection(this, 'VpcBCPeeringConnection', {
      vpcId: props.requestorVpc.vpcId,
      peerVpcId: vpcCId,
      peerOwnerId: props.params.accountBId,
      peerRegion: region,
      peerRoleArn: `arn:aws:iam::${props.params.accountBId}:role/${props.peeringRoleName}`,
      tags: peeringTags,
    });

    // Store the peering connection ID for use in other stacks
    this.peeringConnectionId = this.peeringConnection.ref;

    // Enable DNS resolution over VPC Peering
    const onCreate: cr.AwsSdkCall = {
        service: 'EC2',
        action: 'modifyVpcPeeringConnectionOptions',
        parameters: {
        VpcPeeringConnectionId: this.peeringConnection.ref,
            RequesterPeeringConnectionOptions: {
                AllowDnsResolutionFromRemoteVpc: true
            }
        },
        region: props.env?.region,
        physicalResourceId: cr.PhysicalResourceId.of(`EnableVpcPeeringDnsResolution:${this.peeringConnection.ref}`),
    }
    const onUpdate = onCreate;
    const onDelete: cr.AwsSdkCall = {
        service: "EC2",
        action: "modifyVpcPeeringConnectionOptions",
        parameters: {
            VpcPeeringConnectionId: this.peeringConnection.ref,
            RequesterPeeringConnectionOptions: {
                AllowDnsResolutionFromRemoteVpc: false
            }
        },
    }
    new cr.AwsCustomResource(this, 'EnableVpcPeeringDnsResolution', {
        onUpdate,
        onCreate,
        onDelete,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE}),
    });

    // Add routes to VPC B private subnets pointing to VPC C
    props.requestorVpc.privateSubnets.forEach((subnet, index) => {
      new ec2.CfnRoute(this, `VpcBToVpcCRoute${index + 1}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: props.peeringVpcCidr,
        vpcPeeringConnectionId: this.peeringConnection.ref,
      });
    });

    // Apply tags
    if (props.params.tags) {
      Object.entries(props.params.tags).forEach(([key, value]) => {
        cdk.Tags.of(this).add(key, value);
      });
    }

    // Store Peering Connection ID in Parameter Store for cross-account access
    const peeringIdParam = new ssm.StringParameter(this, 'PeeringConnectionIdParam', {
      stringValue: this.peeringConnectionId,
      description: 'VPC Peering Connection ID for VPC B <-> VPC C',
      parameterName: `/${props.project}/${props.environment}/peering/vpc-b-vpc-c/id`,
    });
    
    // Create IAM Role for Account B to read Peering Connection ID (for Custom Resource)
    const peeringIdReadRole = new iam.Role(this, 'PeeringIdReadRole', {
      assumedBy: new iam.AccountPrincipal(props.params.accountBId),
      roleName: `${props.project}-${props.environment}-PeeringIdReadRole`,
      description: `Role to allow Account ${props.params.accountBId} to read Peering Connection ID from Parameter Store`,
    });

    // Grant read access to the peering ID parameter
    peeringIdParam.grantRead(peeringIdReadRole);

    // Also grant read access to Account B principal (for backward compatibility)
    peeringIdParam.grantRead(new iam.AccountPrincipal(props.params.accountBId));

    // Output Peering ID Read Role ARN
    new cdk.CfnOutput(this, 'PeeringIdReadRoleArn', {
      value: peeringIdReadRole.roleArn,
      description: 'IAM Role ARN for reading Peering Connection ID from Parameter Store',
      exportName: `${props.project}-${props.environment}-PeeringIdReadRole-Arn`,
    });

    // Stack outputs
    new cdk.CfnOutput(this, 'PeeringConnectionId', {
      value: this.peeringConnection.ref,
      description: 'VPC Peering Connection ID for VPC B <-> VPC C',
      exportName: `${props.project}-${props.environment}-VpcB-VpcC-Peering-Id`,
    });
    
    new cdk.CfnOutput(this, 'PeeringConnectionIdParamName', {
      value: peeringIdParam.parameterName,
      description: 'SSM Parameter Store name for Peering Connection ID',
      exportName: `${props.project}-${props.environment}-VpcB-VpcC-Peering-Id-Param-Name`,
    });

    new cdk.CfnOutput(this, 'PeeringStatus', {
      value: 'Peering connection created. Acceptance required in Account B.',
      description: 'Peering connection status',
    });

    new cdk.CfnOutput(this, 'NextSteps', {
      value: [
        '1. Accept peering connection in Account B',
        '2. Deploy VpcCRoutes stack to add routes in VPC C',
        `   Destination: ${props.peeringVpcCidr}`,
        `   Target: ${this.peeringConnection.ref}`,
      ].join(' | '),
      description: 'Required next steps',
    });
  }
}
