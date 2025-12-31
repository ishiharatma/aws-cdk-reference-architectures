import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { VpcConstruct } from '@common/constructs/vpc/vpc';
import { Environment } from "@common/parameters/environments";
import { EnvParams } from 'lib/types/vpc-peering-params';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { C_RESOURCE } from '@common/types';
import { TestInstance } from '@common/constructs/ec2/ec2-testinstance';

export interface VpcCStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
  readonly peeringRoleName?: string;
}

/**
 * VPC C Stack (Account B)
 * 
 * This stack creates:
 * - VPC C in Account B
 * 
 * Note: This stack should be deployed to Account B
 */
export class VpcCStack extends cdk.Stack {
  public readonly vpcC: VpcConstruct;
  public readonly peeringRole: iam.IRole | undefined;
  public readonly InstanceSecurityGroups: ec2.ISecurityGroup[] = [];

  constructor(scope: Construct, id: string, props: VpcCStackProps) {
    super(scope, id, props);

    if (!props.params.vpcCConfig) {
      throw new Error('VPC C configuration is required for this stack');
    }

    // Create VPC C
    this.vpcC = new VpcConstruct(this, C_RESOURCE, {
      project: props.project,
      environment: props.environment,
      config: props.params.vpcCConfig,
      prefix: [props.project, props.environment].join('/'),
    });

    // Apply tags
    if (props.params.tags) {
      Object.entries(props.params.tags).forEach(([key, value]) => {
        cdk.Tags.of(this).add(key, value);
      });
    }

    // Store VPC C information in Parameter Store for cross-account access
    if (props.params.accountAId) {
      // Create Parameter Store for VPC C ID
      const vpcCIdParam = new ssm.StringParameter(this, 'VpcIdParam', {
        stringValue: this.vpcC.vpc.vpcId,
        description: 'VPC C ID in Account B',
        parameterName: `/${props.project}/${props.environment}/vpc-c/id`,
      });
      
      // Create Parameter Store for VPC C CIDR
      const vpcCCidrParam = new ssm.StringParameter(this, 'VpcCidrParam', {
        stringValue: this.vpcC.vpc.vpcCidrBlock,
        description: 'VPC C CIDR Block in Account B',
        parameterName: `/${props.project}/${props.environment}/vpc-c/cidr`,
      });

      // Output Parameter Store names
      new cdk.CfnOutput(this, 'VpcCIdParamName', {
        value: vpcCIdParam.parameterName,
        description: 'SSM Parameter Store name for VPC C ID',
        exportName: `${props.project}-${props.environment}-VpcC-Id-Param-Name`,
      });
      
      new cdk.CfnOutput(this, 'VpcCCidrParamName', {
        value: vpcCCidrParam.parameterName,
        description: 'SSM Parameter Store name for VPC C CIDR',
        exportName: `${props.project}-${props.environment}-VpcC-Cidr-Param-Name`,
      });

      // Create IAM Role for Account A to read Parameter Store (for Custom Resource)
      const parameterReadRole = new iam.Role(this, 'ParameterStoreReadRole', {
        assumedBy: new iam.AccountPrincipal(props.params.accountAId),
        roleName: `${props.project}-${props.environment}-ParameterStoreReadRole`,
        description: `Role to allow Account ${props.params.accountAId} to read VPC C parameters from Parameter Store`,
      });

      // Grant read access to VPC C parameters
      vpcCIdParam.grantRead(parameterReadRole);
      vpcCCidrParam.grantRead(parameterReadRole);

      // Output Parameter Read Role ARN
      new cdk.CfnOutput(this, 'ParameterStoreReadRoleArn', {
        value: parameterReadRole.roleArn,
        description: 'IAM Role ARN for reading VPC C parameters from Parameter Store',
        exportName: `${props.project}-${props.environment}-ParameterStoreReadRole-Arn`,
      });

      // Create Peering Role for accepting VPC Peering connections
      // Requester is Account A, Accepter is Account B
      if (props.peeringRoleName) {
        const peeringRole = new iam.Role(this, 'VpcPeeringRole', {
        assumedBy: new iam.AccountPrincipal(props.params.accountAId),
        roleName: props.peeringRoleName,
        description: `Role to allow Account ${props.params.accountAId} to accept VPC Peering connections in Account ${props.params.accountBId}`,
        });
        this.peeringRole = peeringRole;

        // Attach policy to allow accepting VPC Peering connections
        peeringRole.addToPolicy(new iam.PolicyStatement({
        actions: ['ec2:AcceptVpcPeeringConnection'],
        resources: ['*'],
        }));

        // Output Peering Role ARN
        new cdk.CfnOutput(this, 'PeeringRoleArn', {
        value: this.peeringRole.roleArn,
        description: 'IAM Role ARN for VPC Peering acceptance',
        exportName: `${props.project}-${props.environment}-VpcPeeringRole-Arn`,
        });
      }
    }

    // Stack outputs
    new cdk.CfnOutput(this, 'VpcCId', {
      value: this.vpcC.vpc.vpcId,
      description: 'VPC C ID',
      exportName: `${props.project}-${props.environment}-VpcC-Id`,
    });

    new cdk.CfnOutput(this, 'VpcCCidr', {
      value: this.vpcC.vpc.vpcCidrBlock,
      description: 'VPC C CIDR Block',
      exportName: `${props.project}-${props.environment}-VpcC-Cidr`,
    });

    new cdk.CfnOutput(this, 'AccountBInfo', {
      value: `VPC C created in Account B: ${props.params.accountBId}`,
      description: 'Account B information',
    });

    // Create Peering Security Group in VPC C to allow traffic from VPC B
    const peeringSg = new ec2.SecurityGroup(this, 'VpcPeeringSG', {
      vpc: this.vpcC.vpc,
      description: 'Security Group to allow traffic from VPC B',
      securityGroupName: `${props.project}-${props.environment}-VpcC-Peering-SG`,
      allowAllOutbound: true,
    });
    peeringSg.addIngressRule(
        ec2.Peer.ipv4(props.params.vpcBConfig!.createConfig!.cidr),
        ec2.Port.allTraffic(),
        'Allow all traffic from VPC B'
    );
    this.InstanceSecurityGroups.push(peeringSg);

    // Create Test Instance in VPC C (optional)
    // You can add a test instance here if needed for connectivity testing
    const vpcCTestInstance = new TestInstance(this, 'TestInstance', {
      project: props.project,
      environment: props.environment,
      vpc: this.vpcC.vpc,
      additionalSecurityGroups: [peeringSg],
      targetSubnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    });
    new cdk.CfnOutput(this, 'VpcCTestInstanceId', {
      value: vpcCTestInstance.instance.instanceId,
      description: 'Test EC2 Instance ID in VPC C',
    });

  }
}
