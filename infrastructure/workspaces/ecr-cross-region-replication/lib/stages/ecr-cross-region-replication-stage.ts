import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { EcrCrrOsakaStack } from 'lib/stacks/ecr-crr-osaka-stack';
import { EcrCrrTokyoStack } from 'lib/stacks/ecr-crr-tokyo-stack';

/** Props for {@link EcrCrossRegionReplicationStage}. */
export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

/**
 * ECR Cross-Region Replication Stage
 *
 * Instantiates two stacks in two different regions:
 *
 *   Stack 1 (Osaka) – Destination ECR repository (ap-northeast-3), deployed
 *                      first so it exists — with its own lifecycle policy —
 *                      before replication is enabled.
 *   Stack 2 (Tokyo)  – Source ECR repository (ap-northeast-1) + the registry-
 *                      wide replication configuration targeting Osaka.
 */
export class EcrCrossRegionReplicationStage extends cdk.Stage {
    constructor(scope: Construct, id: string, props: StageProps) {
        super(scope, id, props);

        const destinationRegion = props.params.ecrCrr.destinationRegion ?? 'ap-northeast-3';

        const osakaStack = new EcrCrrOsakaStack(this, pascalCase(`${props.project}EcrCrrOsaka`), {
            project: props.project,
            environment: props.environment,
            params: props.params,
            env: { account: props.env?.account, region: destinationRegion },
            terminationProtection: props.terminationProtection,
            stackName: `${props.project}-${props.environment}-ecr-crr-osaka`,
            description: 'Stack 1: Destination ECR repository (Osaka / ap-northeast-3) with its own lifecycle policy',
        });

        const tokyoStack = new EcrCrrTokyoStack(this, pascalCase(`${props.project}EcrCrrTokyo`), {
            project: props.project,
            environment: props.environment,
            params: props.params,
            env: props.env,
            terminationProtection: props.terminationProtection,
            stackName: `${props.project}-${props.environment}-ecr-crr-tokyo`,
            description: 'Stack 2: Source ECR repository (Tokyo / ap-northeast-1) + cross-region replication to Osaka',
        });
        tokyoStack.addDependency(osakaStack);
    }
}
