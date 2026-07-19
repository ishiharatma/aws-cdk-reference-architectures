import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { CloudwatchLogsS3ArchiveBasicStack } from 'lib/stacks/cloudwatch-logs-s3-archive-basic-stack';
import { CloudwatchLogsS3ArchiveLifecycleStack } from 'lib/stacks/cloudwatch-logs-s3-archive-lifecycle-stack';
import { CloudwatchLogsS3ArchiveExistingStack } from 'lib/stacks/cloudwatch-logs-s3-archive-existing-stack';
import { CloudwatchLogsS3ArchiveExportStack } from 'lib/stacks/cloudwatch-logs-s3-archive-export-stack';
import { CloudwatchLogsS3ArchiveLambdaStack } from 'lib/stacks/cloudwatch-logs-s3-archive-lambda-stack';

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
 * Instantiates five stacks that demonstrate different archiving patterns:
 *
 *   Stack 1 (Basic)     – Pattern A: Firehose, new log group, minimal lifecycle
 *   Stack 2 (Lifecycle) – Pattern A: Firehose, new log group, tiered lifecycle
 *   Stack 3 (Existing)  – Pattern A: Firehose, attach to pre-existing log group
 *   Stack 4 (Export)    – Pattern B: Scheduled export task via Lambda + EventBridge
 *   Stack 5 (Lambda)    – Pattern C: Subscription filter → Lambda → S3 direct write
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

        // Stack 1: Pattern A – Basic archive (new log group, minimal setup)
        new CloudwatchLogsS3ArchiveBasicStack(
            this,
            `${pascalCase(props.project)}${pascalCase('cloudwatch-logs-s3-archive-basic')}`,
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-cwl-s3-archive-basic`,
                description: 'Stack 1 (Pattern A): Basic CloudWatch Logs to S3 archive via Firehose',
            },
        );

        // Stack 2: Pattern A – Archive with tiered lifecycle rules
        new CloudwatchLogsS3ArchiveLifecycleStack(
            this,
            `${pascalCase(props.project)}${pascalCase('cloudwatch-logs-s3-archive-lifecycle')}`,
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-cwl-s3-archive-lifecycle`,
                description: 'Stack 2 (Pattern A): CloudWatch Logs to S3 archive with tiered lifecycle rules',
            },
        );

        // Stack 3: Pattern A – Archive for an existing log group
        new CloudwatchLogsS3ArchiveExistingStack(
            this,
            `${pascalCase(props.project)}${pascalCase('cloudwatch-logs-s3-archive-existing')}`,
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-cwl-s3-archive-existing`,
                description: 'Stack 3 (Pattern A): Archive an existing CloudWatch Log Group to S3 via Firehose',
            },
        );

        // Stack 4: Pattern B – Scheduled export task
        new CloudwatchLogsS3ArchiveExportStack(
            this,
            `${pascalCase(props.project)}${pascalCase('cloudwatch-logs-s3-archive-export')}`,
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-cwl-s3-archive-export`,
                description: 'Stack 4 (Pattern B): Scheduled CloudWatch Logs export task to S3 via Lambda + EventBridge',
            },
        );

        // Stack 5: Pattern C – Lambda direct write
        new CloudwatchLogsS3ArchiveLambdaStack(
            this,
            `${pascalCase(props.project)}${pascalCase('cloudwatch-logs-s3-archive-lambda')}`,
            {
                ...commonStackProps,
                stackName: `${props.project}-${props.environment}-cwl-s3-archive-lambda`,
                description: 'Stack 5 (Pattern C): CloudWatch Logs subscription filter to Lambda to S3 direct write',
            },
        );
    }
}
