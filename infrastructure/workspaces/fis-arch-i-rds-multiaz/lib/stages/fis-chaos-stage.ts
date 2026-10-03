import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { BaseStack } from 'lib/stacks/base-stack';
import { ProbeStack } from 'lib/stacks/probe-stack';
import { FisStack } from 'lib/stacks/fis-stack';

export interface FisChaosStageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

/**
 * Stage orchestrating the three FIS chaos scenario I stacks:
 *   1. BaseStack  — VPC + RDS Multi-AZ DB instance + RDS Multi-AZ DB cluster
 *   2. ProbeStack — failover probe Lambda + per-endpoint stop-condition alarms
 *   3. FisStack   — FIS IAM role + 3 experiment templates (I-1..I-3)
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
            stackName: `${pj}-${env}-i-base`,
            description: `[${env}] FIS chaos I — VPC + RDS Multi-AZ instance + Multi-AZ DB cluster`,
            project: pj,
            environment: env,
            isAutoDeleteObject: props.isAutoDeleteObject,
            vpcConfig: props.params.vpcConfig,
            dbInstanceClass: props.params.dbInstanceClass,
            clusterInstanceClass: props.params.clusterInstanceClass,
        });

        const probeStack = new ProbeStack(this, pascalCase(`${pj}Probe`), {
            ...stackProps,
            stackName: `${pj}-${env}-i-probe`,
            description: `[${env}] FIS chaos I — DB failover probe Lambda + stop-condition alarms`,
            project: pj,
            environment: env,
            vpc: baseStack.vpc,
            dbSecurityGroup: baseStack.dbSecurityGroup,
            dbSecret: baseStack.dbSecret,
            instanceEndpoint: baseStack.multiAzInstance.dbInstanceEndpointAddress,
            clusterEndpoint: baseStack.multiAzClusterEndpoint,
            alarmEmail: props.params.alarmEmail,
        });

        new FisStack(this, pascalCase(`${pj}Fis`), {
            ...stackProps,
            stackName: `${pj}-${env}-i-fis`,
            description: `[${env}] FIS chaos I — experiment templates (I-1 through I-3)`,
            project: pj,
            environment: env,
            multiAzInstance: baseStack.multiAzInstance,
            multiAzClusterArn: baseStack.multiAzClusterArn,
            instanceAlarm: probeStack.instanceAlarm,
            clusterAlarm: probeStack.clusterAlarm,
        });
    }
}
