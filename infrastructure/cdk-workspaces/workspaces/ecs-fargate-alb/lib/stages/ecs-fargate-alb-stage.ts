import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { BaseStack } from "lib/stacks/base-stack";
import { EcrStack } from "lib/stacks/ecr-stack";
import { EcsFargateAlbStack } from "lib/stacks/ecs-fargate-alb-stack";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from "parameters/environments";
import { containerDefinition } from "@common/types";

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
    readonly allowedIpsforAlb?: string[];
}

export class EcsFargateAlbStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);
    const baseStack = new BaseStack(this, `${pascalCase(props.project)}Base`, {
      project: props.project,
      environment: props.environment,
      env: {
        account: props.params.accountId,
        region: props.params.region || props.env?.region,
      },
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      config: props.params.vpcConfig,
      hostedZoneId: props.params.hostedZoneId,
      allowedIpsforAlb: props.allowedIpsforAlb,
      ports: props.params.ecsFargateConfig.createConfig?.taskDefinition.flatMap(element =>
        Object.values(element.containerDefinitions)
          .filter((containerDef: containerDefinition) => containerDef.port)
          .map((containerDef: containerDefinition) => containerDef.port)
      ) || [],
    });

    // Bootstrap mode: Build and push initial Docker image from CDK
    // After initial deployment, CI/CD pipeline handles image deployment
    const isBootstrapMode = process.env.CDK_ECR_BOOTSTRAP === 'true';
    const commitHash = process.env.COMMIT_HASH || 'latest';

    const ecrStack = new EcrStack(this, `${pascalCase(props.project)}Ecr`, {
      project: props.project,
      environment: props.environment,
      env: {
        account: props.params.accountId,
        region: props.params.region || props.env?.region,
      },
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      config: props.params,
      isBootstrapMode: isBootstrapMode,
      commitHash: commitHash,
    });
    ecrStack.addDependency(baseStack);

    const ecsFargateStack = new EcsFargateAlbStack(this, `${pascalCase(props.project)}EcsFargateAlb`, {
      project: props.project,
      environment: props.environment,
      env: {
        account: props.params.accountId,
        region: props.params.region || props.env?.region,
      },
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      config: props.params,
      vpc: baseStack.vpc.vpc,
      vpcSubnets: baseStack.vpc.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }),
      ecsSecurityGroups: [baseStack.ecsSecurityGroup],
      albSecurityGroup: baseStack.albSecurityGroup,
      repositories: ecrStack.repositories,
      commitHash: commitHash,
      isALBOpen: props.allowedIpsforAlb && props.allowedIpsforAlb.length > 0 ? false : true,
      hostedZoneId: props.params.hostedZoneId,
    });
    ecsFargateStack.addDependency(baseStack);
    ecsFargateStack.addDependency(ecrStack);

  }
}
