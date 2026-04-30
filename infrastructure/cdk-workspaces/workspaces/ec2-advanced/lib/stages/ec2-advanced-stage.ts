import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from "parameters/environments";
import { BaseStack } from "lib/stacks/base-stack";
import { Ec2SingleStack } from "lib/stacks/ec2-single-stack";
import { Ec2AutoRecoveryStack } from "lib/stacks/ec2-auto-recovery-stack";
import { Ec2AsgSingleStack } from "lib/stacks/ec2-asg-single-stack";
import { Ec2AsgMultiStack } from "lib/stacks/ec2-asg-multi-stack";

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
    readonly allowedIpsforAlb?: string[];
}

export class Ec2AdvancedStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    const commonEnv = {
      account: props.params.accountId,
      region: props.params.region || props.env?.region,
    };
    const commonStackProps = {
      project: props.project,
      environment: props.environment,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
    };

    // Shared VPC stack
    const baseStack = new BaseStack(this, `${pascalCase(props.project)}Base`, {
      ...commonStackProps,
      env: commonEnv,
      config: props.params.vpcConfig,
    });

    // Pattern 1: EC2 Single
    const ec2SingleStack = new Ec2SingleStack(this, `${pascalCase(props.project)}Single`, {
      ...commonStackProps,
      env: commonEnv,
      vpc: baseStack.vpc,
      ec2Config: props.params.ec2Config,
      notificationTopic: baseStack.notificationTopic,
    });
    ec2SingleStack.addDependency(baseStack);

    // Pattern 2: EC2 Auto-Recovery
    const ec2AutoRecoveryStack = new Ec2AutoRecoveryStack(this, `${pascalCase(props.project)}AutoRecovery`, {
      ...commonStackProps,
      env: commonEnv,
      vpc: baseStack.vpc,
      ec2Config: props.params.ec2Config,
      notificationTopic: baseStack.notificationTopic,
    });
    ec2AutoRecoveryStack.addDependency(baseStack);

    // Pattern 3a: EC2 ASG (always 1 instance) + ALB
    const ec2AsgSingleStack = new Ec2AsgSingleStack(this, `${pascalCase(props.project)}AsgSingle`, {
      ...commonStackProps,
      env: commonEnv,
      vpc: baseStack.vpc,
      ec2Config: props.params.ec2Config,
      useAlb: true,
      ports: props.params.ports,
      allowedIpsforAlb: props.allowedIpsforAlb ?? props.params.allowedIpsforAlb,
      notificationTopic: baseStack.notificationTopic,
    });
    ec2AsgSingleStack.addDependency(baseStack);

    // Pattern 3b: EC2 ASG (always 1 instance) without ALB — SSM-only access
    const ec2AsgSingleNoAlbStack = new Ec2AsgSingleStack(this, `${pascalCase(props.project)}AsgSingleNoAlb`, {
      ...commonStackProps,
      env: commonEnv,
      vpc: baseStack.vpc,
      ec2Config: props.params.ec2Config,
      useAlb: false,
      notificationTopic: baseStack.notificationTopic,
    });
    ec2AsgSingleNoAlbStack.addDependency(baseStack);

    // Pattern 4: EC2 ASG (always 2 instances, multi-AZ) + ALB
    const ec2AsgMultiStack = new Ec2AsgMultiStack(this, `${pascalCase(props.project)}AsgMulti`, {
      ...commonStackProps,
      env: commonEnv,
      vpc: baseStack.vpc,
      ec2Config: props.params.ec2Config,
      ports: props.params.ports,
      allowedIpsforAlb: props.allowedIpsforAlb ?? props.params.allowedIpsforAlb,
      notificationTopic: baseStack.notificationTopic,
    });
    ec2AsgMultiStack.addDependency(baseStack);
  }
}

