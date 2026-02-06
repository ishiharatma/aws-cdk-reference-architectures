import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from "parameters/environments";
import { VpcConfig } from '@common/types';

import { VpcConstruct } from '@common/constructs/vpc/vpc';

export interface StackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly config: VpcConfig;
    readonly allowedIpsforAlb?: string[];
}
export class BaseStack extends cdk.Stack {
  public readonly vpc: VpcConstruct;
  public readonly ecsSecurityGroup: cdk.aws_ec2.SecurityGroup;
  public readonly albSecurityGroup: cdk.aws_ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    // Create VPC
    this.vpc = new VpcConstruct(this, 'Vpc', {
      project: props.project,
      environment: props.environment,
      config: props.config,
      prefix: [props.project, props.environment].join('/'),
    });

    // Create ALB Security Group
    const albSecurityGroup = new cdk.aws_ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc.vpc,
      securityGroupName: `${props.project}-${props.environment}-AlbSecurityGroup`,
      description: 'Security group for Application Load Balancer',
      allowAllOutbound: true,
    });

    // Allow inbound traffic on port 443
    if (props.allowedIpsforAlb && props.allowedIpsforAlb.length > 0) {
      props.allowedIpsforAlb.forEach(ip => {
        albSecurityGroup.addIngressRule(
          cdk.aws_ec2.Peer.ipv4(ip),
          cdk.aws_ec2.Port.tcp(443),
          `Allow inbound HTTPS traffic from ${ip}`
        );
        albSecurityGroup.addIngressRule(
          cdk.aws_ec2.Peer.ipv4(ip),
          cdk.aws_ec2.Port.tcp(80),
          `Allow inbound HTTP traffic from ${ip}`
        );
      });
    } else {
      console.log('⚠️No allowed IPs provided for ALB. Allowing inbound HTTP/HTTPS traffic from anywhere.');
      albSecurityGroup.addIngressRule(
        cdk.aws_ec2.Peer.anyIpv4(),
        cdk.aws_ec2.Port.tcp(443),
        'Allow inbound HTTPS traffic from anywhere'
      );
      albSecurityGroup.addIngressRule(
        cdk.aws_ec2.Peer.anyIpv4(),
        cdk.aws_ec2.Port.tcp(80),
        'Allow inbound HTTP traffic from anywhere'
      );
    }
    this.albSecurityGroup = albSecurityGroup;

    // Create ECS Security Group
    const ecsSecurityGroup = new cdk.aws_ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc: this.vpc.vpc,
      securityGroupName: `${props.project}-${props.environment}-EcsSecurityGroup`,
      description: 'Security group for ECS tasks',
      allowAllOutbound: true,
    });

    // Allow inbound traffic on port 80 from ALB Security Group
    ecsSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.securityGroupId(this.albSecurityGroup.securityGroupId),
      cdk.aws_ec2.Port.tcp(80),
      'Allow inbound HTTP traffic from ALB'
    );
    this.ecsSecurityGroup = ecsSecurityGroup;

  }
}
