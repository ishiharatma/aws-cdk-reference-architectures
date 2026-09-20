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
 * Stage orchestrating all three FIS chaos scenario H stacks:
 *   1. BaseStack  — 2-AZ VPC + Aurora PostgreSQL Serverless v2 (writer + reader) — same as Architecture G
 *   2. AppStack   — EC2 ASG (2 AZs, zonal-shift-enabled) + internet-facing Network Load Balancer
 *   3. FisStack   — FIS IAM role, CloudWatch stop-condition alarm, 1 experiment template (H-1)
 *
 * Deploy order: Base → App → FIS (CDK infers order from cross-stack resource references).
 *
 * Architecture H answers the question Architecture G's G-2 scenario raised: G-2 showed that
 * Auto Scaling's default self-healing re-launches a replacement instance into the very same
 * AZ that a network partition just isolated it from, because AZ-avoidance only triggers on a
 * launch *failure*, not a post-launch health-check failure. H deploys the same NLB/ASG/Aurora
 * base as G, but with `AvailabilityZoneImpairmentPolicy` (ARC zonal shift integration) enabled
 * on the ASG, and deploy-verifies that an operator-triggered zonal shift actually changes that
 * outcome.
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
            stackName: `${pj}-${env}-h-base`,
            description: `[${env}] FIS chaos H — 2-AZ VPC + Aurora PostgreSQL Multi-AZ`,
            project: pj,
            environment: env,
            isAutoDeleteObject: props.isAutoDeleteObject,
            vpcConfig: props.params.vpcConfig,
        });

        const appStack = new AppStack(this, pascalCase(`${pj}App`), {
            ...stackProps,
            stackName: `${pj}-${env}-h-app`,
            description: `[${env}] FIS chaos H — EC2 Auto Scaling Group (2 AZs, zonal-shift-enabled) + Network Load Balancer`,
            project: pj,
            environment: env,
            isAutoDeleteObject: props.isAutoDeleteObject,
            vpc: baseStack.vpc,
            auroraCluster: baseStack.auroraCluster,
            auroraSecret: baseStack.auroraSecret,
            impairedZoneHealthCheckBehavior: props.params.impairedZoneHealthCheckBehavior,
        });

        const fisStack = new FisStack(this, pascalCase(`${pj}Fis`), {
            ...stackProps,
            stackName: `${pj}-${env}-h-fis`,
            description: `[${env}] FIS chaos H — experiment template (H-1)`,
            project: pj,
            environment: env,
            targetGroup: appStack.targetGroup,
            azSubnetArns: baseStack.azSubnetArns,
            alarmEmail: props.params.alarmEmail,
        });

        void fisStack;
    }
}
