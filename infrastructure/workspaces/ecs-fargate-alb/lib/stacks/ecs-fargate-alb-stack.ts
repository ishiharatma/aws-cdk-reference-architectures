import * as cdk from "aws-cdk-lib";
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EcsFargateConfig } from '@common/types';
import { EnvParams } from "parameters/environments";

import { AlbConstruct } from '@common/constructs/alb';
import { EcrConstruct } from '@common/constructs/ecr';
import { EcsFargateConstruct } from '@common/constructs/ecs/ecs-fargate';

export interface StackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly config: EnvParams;
    readonly vpc: ec2.IVpc;
    readonly vpcSubnets: ec2.SubnetSelection;
    readonly ecsSecurityGroups: ec2.ISecurityGroup[];
    readonly albSecurityGroup: ec2.ISecurityGroup;
    readonly repositories: Record<string, EcrConstruct>;
    readonly commitHash: string;
    readonly isALBOpen: boolean;
    readonly hostedZoneId?: string;
    readonly domainName?: string;
}
export class EcsFargateAlbStack extends cdk.Stack {
  public readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  public readonly ecsServices: ecs.IFargateService[] = [];

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    if (props.hostedZoneId && !props.domainName) {
      throw new Error("If hostedZoneId is provided, domainName must also be provided for ALB SSL certificate creation.");
    }

    if (props.domainName && !props.hostedZoneId) {
      throw new Error("If domainName is provided, hostedZoneId must also be provided for ALB SSL certificate creation.");
    }

    // Create ACM for ALB SSL certificate if certificateArn is not provided
    let certificate;
    if (props.hostedZoneId && props.domainName) {
      certificate = new acm.Certificate(this, 'AlbCertificate', {
        domainName: props.domainName,
        validation: acm.CertificateValidation.fromDns(),
      });
      new cdk.CfnOutput(this, 'CertificateArn', {
        value: certificate.certificateArn,
        description: 'The ARN of the ACM certificate for ALB',
      });
    }
    // Create ALB Construct
    const alb = new AlbConstruct(this, 'Alb', {
      project: props.project,
      environment: props.environment,
      vpc: props.vpc,
      securityGroup: props.albSecurityGroup,
      isALBOpen: props.isALBOpen,
      certificate,
    });
    this.loadBalancer = alb.alb;

     // Update container definitions with ECR repository names
    Object.keys(props.repositories).forEach((key) => {
      const ecr = props.repositories[key];
      // Update task definition with ECR repository name
      props.config.ecsFargateConfig.createConfig?.taskDefinition?.forEach((taskDef) => {
        if (taskDef.containerDefinitions[key]) {
          taskDef.containerDefinitions[key].repositoryName = ecr.ecr.repositoryName;
          taskDef.containerDefinitions[key].imageTag = ecr.imageTag;
        }
      });
    });

    // Create ECS Fargate Construct
    const ecs = new EcsFargateConstruct(this, 'EcsFargate', {
      project: props.project,
      environment: props.environment,
      vpc: props.vpc,
      vpcSubnets: props.vpcSubnets,
      securityGroups: props.ecsSecurityGroups,
      containerEnvironment: {
        PORT: '8080',
      },
      config: props.config.ecsFargateConfig,
      logRetentionDays: cdk.aws_logs.RetentionDays.ONE_WEEK,
      snsAlarmTopic: undefined,
      albListener: alb.listener, // Connect ALB to ECS
    });
    this.ecsServices = ecs.services;

  }
}
