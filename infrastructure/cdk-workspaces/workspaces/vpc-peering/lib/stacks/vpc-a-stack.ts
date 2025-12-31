import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { VpcConstruct } from '@common/constructs/vpc/vpc';
import { VpcPeering } from '@common/constructs/vpc/vpc-peering';
import { Environment } from "@common/parameters/environments";
import { EnvParams } from 'lib/types/vpc-peering-params';
import { TestInstance } from '@common/constructs/ec2/ec2-testinstance';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface VpcAStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * VPC Peering Stack
 * 
 * This stack creates:
 * - VPC A and VPC B in Account A
 * - VPC Peering connection between VPC A and VPC B
 * - Route tables and security groups for the peering connection
 * 
 * For cross-account peering (VPC B <-> VPC C), use a separate stack in Account B
 */
export class VpcAStack extends cdk.Stack {
  public readonly vpcA: VpcConstruct;
  public readonly vpcB: VpcConstruct;
  public readonly vpcABPeering: VpcPeering;
  public readonly vpcAInstanceSecurityGroups: ec2.ISecurityGroup[] = [];
  public readonly vpcBInstanceSecurityGroups: ec2.ISecurityGroup[] = [];

  constructor(scope: Construct, id: string, props: VpcAStackProps) {
    super(scope, id, props);

    // Create VPC A
    this.vpcA = new VpcConstruct(this, 'VpcA', {
      project: props.project,
      environment: props.environment,
      config: props.params.vpcAConfig,
      prefix: [props.project, props.environment].join('/'),
    });

    // Create VPC B
    this.vpcB = new VpcConstruct(this, 'VpcB', {
      project: props.project,
      environment: props.environment,
      config: props.params.vpcBConfig,
      prefix: [props.project, props.environment].join('/'),
    });

    if (props.params.accountBId) {
      // Create Parameter Store for VPC B ID
      const vpcBIdParam = new ssm.StringParameter(this, 'VpcBIdParam', {
        stringValue: this.vpcB.vpc.vpcId,
        description: 'VPC B ID in Account A',
        parameterName: `/${props.project}/${props.environment}/vpc-b/id`,
      });
      
      // Create Parameter Store for VPC B CIDR
      const vpcBCidrParam = new ssm.StringParameter(this, 'VpcBCidrParam', {
        stringValue: this.vpcB.vpc.vpcCidrBlock,
        description: 'VPC B CIDR Block in Account A',
        parameterName: `/${props.project}/${props.environment}/vpc-b/cidr`,
      });
      // Create IAM Role for Account B to read Parameter Store (for Custom Resource)
      const parameterReadRole = new iam.Role(this, 'ParameterStoreReadRole', {
        assumedBy: new iam.AccountPrincipal(props.params.accountBId),
        roleName: `${props.project}-${props.environment}-ParameterStoreReadRole`,
        description: `Role to allow Account ${props.params.accountBId} to read VPC C parameters from Parameter Store`,
      });
      vpcBIdParam.grantRead(parameterReadRole);
      vpcBCidrParam.grantRead(parameterReadRole);

      // Output Parameter Store names
      new cdk.CfnOutput(this, 'VpcBIdParamName', {
        value: vpcBIdParam.parameterName,
        description: 'SSM Parameter Store name for VPC B ID',
        exportName: `${props.project}-${props.environment}-VpcB-Id-Param-Name`,
      });
      
      new cdk.CfnOutput(this, 'VpcBCidrParamName', {
        value: vpcBCidrParam.parameterName,
        description: 'SSM Parameter Store name for VPC B CIDR',
        exportName: `${props.project}-${props.environment}-VpcB-Cidr-Param-Name`,
      });
    }

    // Create VPC Peering between VPC A and VPC B
    this.vpcABPeering = new VpcPeering(this, 'VpcABPeering', {
      project: props.project,
      environment: props.environment,
      vpc: this.vpcA.vpc,
      peerVpc: this.vpcB.vpc,
    });
    this.vpcAInstanceSecurityGroups.push(this.vpcABPeering.localSecurityGroup);
    this.vpcBInstanceSecurityGroups.push(this.vpcABPeering.peeringSecurityGroup);

    // Create Test Instance in VPC A (optional)
    const vpcATestInstance = new TestInstance(this, 'VpcATestInstance', {
      project: props.project,
      environment: props.environment,
      vpc: this.vpcA.vpc,
      additionalSecurityGroups: [this.vpcABPeering.localSecurityGroup],
    });

    // Create Security Group Allowing traffic from VPC C to VPC B Test Instance
    if (props.params.vpcCConfig?.createConfig?.cidr) {
      // Create Security Group to allow traffic from VPC C to VPC B
      const peeringSg = new ec2.SecurityGroup(this, 'VpcBPeeringSG', {
        vpc: this.vpcB.vpc,
        description: `Security group for VPC Peering traffic from VPC C`,
        allowAllOutbound: true,
      });
      peeringSg.addIngressRule(
        ec2.Peer.ipv4(props.params.vpcCConfig.createConfig.cidr),
        ec2.Port.allTraffic(),
        `Allow all traffic from peer VPC C`
      );
      this.vpcBInstanceSecurityGroups.push(peeringSg);
    }
    // Create Test Instance in VPC B (optional)
    const vpcBTestInstance = new TestInstance(this, 'VpcBTestInstance', {
      project: props.project,
      environment: props.environment,
      vpc: this.vpcB.vpc,
      additionalSecurityGroups: this.vpcBInstanceSecurityGroups,
    });

    // Apply tags
    if (props.params.tags) {
      Object.entries(props.params.tags).forEach(([key, value]) => {
        cdk.Tags.of(this).add(key, value);
      });
    }

    // Stack outputs
    new cdk.CfnOutput(this, 'VpcAPeeringStatus', {
      value: 'VPC A <-> VPC B peering created',
      description: 'VPC Peering status between VPC A and VPC B',
    });
    new cdk.CfnOutput(this, 'VpcBInstanceId', {
      value: vpcBTestInstance.instance.instanceId,
      description: 'Test EC2 Instance ID in VPC B',
    });
    new cdk.CfnOutput(this, 'VpcAInstanceId', {
      value: vpcATestInstance.instance.instanceId,
      description: 'Test EC2 Instance ID in VPC A',
    });
  }
}
