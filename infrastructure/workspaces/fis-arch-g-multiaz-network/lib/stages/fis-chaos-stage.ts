import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { BaseStack } from 'lib/stacks/base-stack';
import { AppStack } from 'lib/stacks/app-stack';
import { FisStack } from 'lib/stacks/fis-stack';

export interface FisChaosStageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

/**
 * Stage orchestrating all three FIS chaos scenario G stacks:
 *   1. BaseStack  — 2-AZ VPC + Aurora PostgreSQL Serverless v2 (writer + reader)
 *   2. AppStack   — EC2 ASG (2 AZs) + internet-facing Network Load Balancer
 *   3. FisStack   — FIS IAM role, CloudWatch stop-condition alarm, 4 experiment templates (G-1..G-4)
 *
 * Deploy order: Base → App → FIS (CDK infers order from cross-stack resource references).
 */
export class FisChaosStage extends cdk.Stage {
    constructor(scope: Construct, id: string, props: FisChaosStageProps) {
        super(scope, id, props);

        const stackProps: cdk.StackProps = {
            env: props.env,
            terminationProtection: props.terminationProtection,
        };

        const pj = props.project;
        const env = props.environment;

        const baseStack = new BaseStack(this, pascalCase(`${pj}Base`), {
            ...stackProps,
            stackName: `${pj}-${env}-g-base`,
            description: `[${env}] FIS chaos G — 2-AZ VPC + Aurora PostgreSQL Multi-AZ`,
            project: pj,
            environment: env,
            isAutoDeleteObject: props.isAutoDeleteObject,
            vpcConfig: props.params.vpcConfig,
        });

        const appStack = new AppStack(this, pascalCase(`${pj}App`), {
            ...stackProps,
            stackName: `${pj}-${env}-g-app`,
            description: `[${env}] FIS chaos G — EC2 Auto Scaling Group (2 AZs) + Network Load Balancer`,
            project: pj,
            environment: env,
            isAutoDeleteObject: props.isAutoDeleteObject,
            vpc: baseStack.vpc,
            auroraCluster: baseStack.auroraCluster,
            auroraSecret: baseStack.auroraSecret,
        });

        const fisStack = new FisStack(this, pascalCase(`${pj}Fis`), {
            ...stackProps,
            stackName: `${pj}-${env}-g-fis`,
            description: `[${env}] FIS chaos G — experiment templates (G-1 through G-4)`,
            project: pj,
            environment: env,
            targetGroup: appStack.targetGroup,
            auroraCluster: baseStack.auroraCluster,
            azSubnetArns: baseStack.azSubnetArns,
            alarmEmail: props.params.alarmEmail,
        });

        void fisStack;
    }
}
