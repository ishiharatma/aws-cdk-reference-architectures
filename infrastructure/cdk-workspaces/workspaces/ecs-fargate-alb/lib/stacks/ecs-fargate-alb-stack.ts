import * as cdk from "aws-cdk-lib";
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as ecs from "aws-cdk-lib/aws-ecs";
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
}
export class EcsFargateAlbStack extends cdk.Stack {
  public readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  public readonly ecsServices: ecs.IFargateService[] = [];

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Create ALB Construct
    const alb = new AlbConstruct(this, 'Alb', {
      project: props.project,
      environment: props.environment,
      vpc: props.vpc,
      securityGroup: props.albSecurityGroup,
      isALBOpen: props.isALBOpen,
    });
    this.loadBalancer = alb.alb;
/*
    // Create ECR Construct
    // Bootstrap mode: Build and push initial Docker image from CDK
    // After initial deployment, CI/CD pipeline handles image deployment
    const isBootstrapMode = process.env.CDK_ECR_BOOTSTRAP === 'true';

    if (isBootstrapMode) {
      console.log('🚀 Bootstrap mode enabled: CDK will build and push Docker images');
    } else {
      console.log('📦 Normal mode: Expecting images to be pushed by CI/CD pipeline');
    }

    const commitHash = process.env.COMMIT_HASH || 'latest';
    const repositories: Record<string, EcrConstruct> = {};

    // Validate ECR configuration before creating resources
    const ecrKeys = Object.keys(props.config.ecrConfig);
    const taskDefinitions = props.config.ecsFargateConfig.createConfig?.taskDefinition ?? [];
    
    // Validate all container definitions exist
    taskDefinitions.forEach((taskDef) => {
      ecrKeys.forEach((key) => {
        if (!taskDef.containerDefinitions.hasOwnProperty(key)) {
          throw new Error(
            `Container definition for ECR key '${key}' not found in task definition. ` +
            `Available containers: ${Object.keys(taskDef.containerDefinitions).join(', ')}`
          );
        }
      });
    });

    // Create ECR repositories and update container definitions
    Object.keys(props.config.ecrConfig).forEach((key) => {
      const ecr = new EcrConstruct(this, `Ecr${pascalCase(key)}`, {
        project: props.project,
        environment: props.environment,
        ecrConfig: props.config.ecrConfig[key],
        isImageSourceBuild: isBootstrapMode,
        tag: commitHash,
      });
      repositories[key] = ecr;
      // Update task definition with ECR repository name
      taskDefinitions.forEach((taskDef) => {
        taskDef.containerDefinitions[key].repositoryName = ecr.ecr.repositoryName;
      });
    });
*/
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
