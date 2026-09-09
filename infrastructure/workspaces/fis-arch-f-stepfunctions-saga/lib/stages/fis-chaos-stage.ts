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
 * Stage orchestrating all three FIS chaos scenario F stacks:
 *   1. BaseStack  — DynamoDB orders table
 *   2. AppStack   — 5 Lambda functions + Step Functions Saga state machine
 *   3. FisStack   — FIS IAM role, CloudWatch stop-condition alarm, 3 experiment templates (F-1..F-3)
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
            stackName: `${pj}-${env}-f-base`,
            description: `[${env}] FIS chaos F — DynamoDB orders table`,
            project: pj,
            environment: env,
            isAutoDeleteObject: props.isAutoDeleteObject,
        });

        const appStack = new AppStack(this, pascalCase(`${pj}App`), {
            ...stackProps,
            stackName: `${pj}-${env}-f-app`,
            description: `[${env}] FIS chaos F — Lambda Saga steps + Step Functions state machine`,
            project: pj,
            environment: env,
            isAutoDeleteObject: props.isAutoDeleteObject,
            table: baseStack.table,
        });

        const fisStack = new FisStack(this, pascalCase(`${pj}Fis`), {
            ...stackProps,
            stackName: `${pj}-${env}-f-fis`,
            description: `[${env}] FIS chaos F — experiment templates (F-1 through F-3)`,
            project: pj,
            environment: env,
            reserveInventoryFn: appStack.reserveInventoryFn,
            processPaymentFn: appStack.processPaymentFn,
            confirmOrderFn: appStack.confirmOrderFn,
            stateMachine: appStack.stateMachine,
            alarmEmail: props.params.alarmEmail,
        });

        void fisStack;
    }
}
