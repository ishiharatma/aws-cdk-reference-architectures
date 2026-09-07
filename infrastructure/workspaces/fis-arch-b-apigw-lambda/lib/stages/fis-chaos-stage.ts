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
 * Stage orchestrating all three FIS chaos scenario B stacks:
 *   1. BaseStack  — DynamoDB table
 *   2. AppStack   — Lambda + API Gateway HTTP API + CloudFront distribution
 *   3. FisStack   — FIS IAM role, CloudWatch stop-condition alarms, 4 experiment templates (B-1..B-4)
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
            stackName: `${pj}-${env}-b-base`,
            description: `[${env}] FIS chaos B — DynamoDB`,
            project: pj,
            environment: env,
            isAutoDeleteObject: props.isAutoDeleteObject,
        });

        const appStack = new AppStack(this, pascalCase(`${pj}App`), {
            ...stackProps,
            stackName: `${pj}-${env}-b-app`,
            description: `[${env}] FIS chaos B — Lambda + API Gateway HTTP API + CloudFront`,
            project: pj,
            environment: env,
            isAutoDeleteObject: props.isAutoDeleteObject,
            table: baseStack.table,
        });

        const fisStack = new FisStack(this, pascalCase(`${pj}Fis`), {
            ...stackProps,
            stackName: `${pj}-${env}-b-fis`,
            description: `[${env}] FIS chaos B — experiment templates (B-1 through B-4)`,
            project: pj,
            environment: env,
            apiFunction: appStack.apiFunction,
            table: baseStack.table,
            alarmEmail: props.params.alarmEmail,
        });

        void fisStack;
    }
}
