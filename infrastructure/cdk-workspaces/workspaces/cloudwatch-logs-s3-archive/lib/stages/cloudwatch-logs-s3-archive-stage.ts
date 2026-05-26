import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { CloudwatchLogsS3ArchiveBasicStack } from 'lib/stacks/cloudwatch-logs-s3-archive-basic-stack';
import { CloudwatchLogsS3ArchiveLifecycleStack } from 'lib/stacks/cloudwatch-logs-s3-archive-lifecycle-stack';
import { CloudwatchLogsS3ArchiveExistingStack } from 'lib/stacks/cloudwatch-logs-s3-archive-existing-stack';

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

/**
 * CloudWatch Logs → S3 Archive Stage
 *
 * Instantiates three stacks that demonstrate different archiving patterns:
 *   Stack 1 (Basic)     – New log group, minimal lifecycle rules
 *   Stack 2 (Lifecycle) – New log group, full tiered lifecycle rules
 *   Stack 3 (Existing)  – Attach archiving to a pre-existing log group
 */
export class CloudwatchLogsS3ArchiveStage extends cdk.Stage {
    constructor(scope: Construct, id: string, props: StageProps) {
        super(scope, id, props);

        const commonStackProps = {
            project: props.project,
            environment: props.environment,
            env: props.env,
            terminationProtection: props.terminationProtection,
            isAutoDeleteObject: props.isAutoDeleteObject,
            params: props.params,
        };

        // Stack 1: Basic archive (new log group, minimal setup)
        new CloudwatchLogsS3ArchiveBasicStack(
            this,
            `${pascalCase(props.project)}${pascalCase('cloudwatch-logs-s3-archive-basic')}`,
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-cwl-s3-archive-basic`,
                description: 'Stack 1: Basic CloudWatch Logs to S3 archive via Firehose',
            },
        );

        // Stack 2: Archive with tiered lifecycle rules
        new CloudwatchLogsS3ArchiveLifecycleStack(
            this,
            `${pascalCase(props.project)}${pascalCase('cloudwatch-logs-s3-archive-lifecycle')}`,
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-cwl-s3-archive-lifecycle`,
                description: 'Stack 2: CloudWatch Logs to S3 archive with tiered lifecycle rules',
            },
        );

        // Stack 3: Archive for an existing log group
        new CloudwatchLogsS3ArchiveExistingStack(
            this,
            `${pascalCase(props.project)}${pascalCase('cloudwatch-logs-s3-archive-existing')}`,
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-cwl-s3-archive-existing`,
                description: 'Stack 3: Archive an existing CloudWatch Log Group to S3 via Firehose',
            },
        );
    }
}
