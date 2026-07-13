import * as cdk from "aws-cdk-lib";
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from "constructs";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EcsFargateConfig } from '@common/types';
import { EnvParams } from "parameters/environments";

import { EcrConstruct } from '@common/constructs/ecr';

export interface StackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly config: EnvParams;
    readonly isBootstrapMode: boolean;
    readonly commitHash: string;
}
export class EcrStack extends cdk.Stack {
  public readonly repositories: Record<string, EcrConstruct> = {}

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Create ECR Construct
    if (props.isBootstrapMode) {
      console.log('🚀 Bootstrap mode enabled: CDK will build and push Docker images');
    } else {
      console.log('📦 Normal mode: Expecting images to be pushed by CI/CD pipeline');
    }
    const isBootstrapMode = props.isBootstrapMode;
    const commitHash = props.commitHash;
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
        imageTag: commitHash,
      });
      this.repositories[key] = ecr;
      /*
      // Update task definition with ECR repository name
      taskDefinitions.forEach((taskDef) => {
        taskDef.containerDefinitions[key].repositoryName = ecr.ecr.repositoryName;
      });
      */
    });
  }
}
