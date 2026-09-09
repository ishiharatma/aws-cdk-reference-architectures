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
 * Stage orchestrating all three FIS chaos scenario D stacks:
 *   1. BaseStack  — DynamoDB table + SQS main queue + DLQ
 *   2. AppStack   — Consumer Lambda (SQS event source) + Producer Lambda (Function URL)
 *   3. FisStack   — FIS IAM role, CloudWatch stop-condition alarm, 3 experiment templates (D-1..D-3)
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
            stackName: `${pj}-${env}-d-base`,
            description: `[${env}] FIS chaos D — DynamoDB + SQS (main queue + DLQ)`,
            project: pj,
            environment: env,
            isAutoDeleteObject: props.isAutoDeleteObject,
        });

        const appStack = new AppStack(this, pascalCase(`${pj}App`), {
            ...stackProps,
            stackName: `${pj}-${env}-d-app`,
            description: `[${env}] FIS chaos D — SQS-triggered consumer Lambda + producer Lambda (Function URL)`,
            project: pj,
            environment: env,
            isAutoDeleteObject: props.isAutoDeleteObject,
            table: baseStack.table,
            queue: baseStack.queue,
        });

        const fisStack = new FisStack(this, pascalCase(`${pj}Fis`), {
            ...stackProps,
            stackName: `${pj}-${env}-d-fis`,
            description: `[${env}] FIS chaos D — experiment templates (D-1 through D-3)`,
            project: pj,
            environment: env,
            consumerFunction: appStack.consumerFunction,
            queue: baseStack.queue,
            alarmEmail: props.params.alarmEmail,
        });

        void fisStack;
    }
}
