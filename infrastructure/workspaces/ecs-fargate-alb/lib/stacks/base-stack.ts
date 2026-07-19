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
    readonly hostedZoneId?: string;
    readonly allowedIpsforAlb?: string[];
    readonly ports?: number[];
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

    const isHTTPSOnly = props.hostedZoneId ? true : false;

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
        if (isHTTPSOnly) {
          albSecurityGroup.addIngressRule(
            cdk.aws_ec2.Peer.ipv4(ip),
            cdk.aws_ec2.Port.tcp(443),
            `Allow inbound HTTPS traffic from ${ip}`
          );
        } else {
          albSecurityGroup.addIngressRule(
            cdk.aws_ec2.Peer.ipv4(ip),
            cdk.aws_ec2.Port.tcp(80),
            `Allow inbound HTTP traffic from ${ip}`
          );
        }
      });
    } else {
      console.log('⚠️No allowed IPs provided for ALB. Allowing inbound HTTP/HTTPS traffic from anywhere.');
      if (isHTTPSOnly) {
        albSecurityGroup.addIngressRule(
          cdk.aws_ec2.Peer.anyIpv4(),
          cdk.aws_ec2.Port.tcp(443),
          'Allow inbound HTTPS traffic from anywhere'
        );
      } else {
        albSecurityGroup.addIngressRule(
          cdk.aws_ec2.Peer.anyIpv4(),
          cdk.aws_ec2.Port.tcp(80),
          'Allow inbound HTTP traffic from anywhere'
        );
      }
    }
    this.albSecurityGroup = albSecurityGroup;

    // Create ECS Security Group
    const ecsSecurityGroup = new cdk.aws_ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc: this.vpc.vpc,
      securityGroupName: `${props.project}-${props.environment}-EcsSecurityGroup`,
      description: 'Security group for ECS tasks',
      allowAllOutbound: true,
    });

    // Allow inbound traffic from ALB Security Group on specified ports
    props.ports?.forEach(port => {
      ecsSecurityGroup.addIngressRule(
          cdk.aws_ec2.Peer.securityGroupId(this.albSecurityGroup.securityGroupId),
          cdk.aws_ec2.Port.tcp(port),
          `Allow inbound traffic on port ${port} from ALB`
        );
    });
    this.ecsSecurityGroup = ecsSecurityGroup;

  }
}
