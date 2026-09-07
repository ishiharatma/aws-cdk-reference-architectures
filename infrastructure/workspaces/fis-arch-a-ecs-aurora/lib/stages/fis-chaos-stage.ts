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
 * Stage orchestrating all three FIS chaos scenario stacks:
 *   1. BaseStack  — VPC + Aurora PostgreSQL Serverless v2 (1 writer + 1 reader)
 *   2. AppStack   — Internal ALB + ECS Fargate + CloudFront VPC Origin
 *   3. FisStack   — FIS IAM role, CloudWatch stop-condition alarms, 4 experiment templates
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
            stackName: `${pj}-${env}-base`,
            description: `[${env}] FIS chaos — VPC and Aurora PostgreSQL`,
            project: pj,
            environment: env,
            isAutoDeleteObject: props.isAutoDeleteObject,
            vpcConfig: props.params.vpcConfig,
        });

        const appStack = new AppStack(this, pascalCase(`${pj}App`), {
            ...stackProps,
            stackName: `${pj}-${env}-app`,
            description: `[${env}] FIS chaos — CloudFront VPC Origin + Internal ALB + ECS Fargate`,
            project: pj,
            environment: env,
            isAutoDeleteObject: props.isAutoDeleteObject,
            vpc: baseStack.vpc,
            dbSecurityGroup: baseStack.dbSecurityGroup,
            auroraCluster: baseStack.auroraCluster,
            auroraSecret: baseStack.auroraSecret,
            cloudfrontManagedPrefixList: props.params.cloudfrontManagedPrefixList,
        });

        const fisStack = new FisStack(this, pascalCase(`${pj}Fis`), {
            ...stackProps,
            stackName: `${pj}-${env}-fis`,
            description: `[${env}] FIS chaos — experiment templates (A-1 through A-4)`,
            project: pj,
            environment: env,
            ecsCluster: appStack.ecsCluster,
            ecsService: appStack.ecsService,
            alb: appStack.alb,
            auroraCluster: baseStack.auroraCluster,
            alarmEmail: props.params.alarmEmail,
        });

        // Suppress unused-variable lint warning — fisStack is created for its side effects
        void fisStack;
    }
}
