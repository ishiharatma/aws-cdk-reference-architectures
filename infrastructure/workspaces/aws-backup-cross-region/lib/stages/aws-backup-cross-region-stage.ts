import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { AwsBackupCrrOsakaStack } from 'lib/stacks/aws-backup-crr-osaka-stack';
import { AwsBackupCrrTokyoStack } from 'lib/stacks/aws-backup-crr-tokyo-stack';
import { SampleAppStack } from 'lib/stacks/sample-app-stack';

/** Props for {@link AwsBackupCrossRegionStage}. */
export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

/**
 * AWS Backup Cross-Region Stage
 *
 * Instantiates three stacks:
 *
 *   Stack 1 (Osaka)     – Secondary Backup Vault (ap-northeast-3), deployed first so it
 *                          exists before the Tokyo backup plan's copy action targets it.
 *   Stack 2 (SampleApp) – A minimal standalone stack (Tokyo) tagged for backup, standing in
 *                          for "some other team's CloudFormation stack" that AWS Backup
 *                          protects as a single AWS::CloudFormation::Stack recovery point.
 *   Stack 3 (Tokyo)     – Sample VPC/EC2/RDS/S3 workload + primary Backup Vault, Backup
 *                          Plan, and tag-based Backup Selection with a copy action to Osaka.
 */
export class AwsBackupCrossRegionStage extends cdk.Stage {
    constructor(scope: Construct, id: string, props: StageProps) {
        super(scope, id, props);

        const destinationRegion = props.params.awsBackupCrr.destinationRegion ?? 'ap-northeast-3';
        const destinationVaultName = `${props.project}-${props.environment}-backup-osaka`;

        const osakaStack = new AwsBackupCrrOsakaStack(this, pascalCase(`${props.project}AwsBackupCrrOsaka`), {
            project: props.project,
            environment: props.environment,
            params: props.params,
            vaultName: destinationVaultName,
            env: { account: props.env?.account, region: destinationRegion },
            terminationProtection: props.terminationProtection,
            stackName: `${props.project}-${props.environment}-backup-crr-osaka`,
            description: 'Stack 1: Secondary Backup Vault (Osaka / ap-northeast-3) receiving copied recovery points',
        });

        new SampleAppStack(this, pascalCase(`${props.project}AwsBackupSampleApp`), {
            project: props.project,
            environment: props.environment,
            params: props.params,
            isAutoDeleteObject: props.isAutoDeleteObject,
            env: props.env,
            terminationProtection: props.terminationProtection,
            stackName: `${props.project}-${props.environment}-backup-sample-app`,
            description:
                'Stack 2: Minimal standalone stack (Tokyo) tagged for backup, standing in for a CloudFormation-stack backup target',
        });

        const tokyoStack = new AwsBackupCrrTokyoStack(this, pascalCase(`${props.project}AwsBackupCrrTokyo`), {
            project: props.project,
            environment: props.environment,
            params: props.params,
            isAutoDeleteObject: props.isAutoDeleteObject,
            destinationRegion,
            destinationVaultName,
            env: props.env,
            terminationProtection: props.terminationProtection,
            stackName: `${props.project}-${props.environment}-backup-crr-tokyo`,
            description:
                'Stack 3: Sample VPC/EC2/RDS/S3 workload + primary Backup Vault/Plan/Selection with cross-region copy to Osaka',
        });
        tokyoStack.addDependency(osakaStack);
    }
}
