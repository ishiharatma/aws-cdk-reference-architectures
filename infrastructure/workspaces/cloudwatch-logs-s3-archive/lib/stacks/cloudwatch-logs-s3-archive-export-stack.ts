import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import {
    ExportTaskParams,
    defaultExportTaskConfig,
} from 'lib/types';
import { EnvParams } from 'parameters/environments';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

export interface CloudwatchLogsS3ArchiveExportStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
}

/**
 * Stack 4 – Pattern B: Scheduled Export Task (CloudWatch Logs → S3)
 *
 * Uses the CloudWatch Logs `CreateExportTask` API to batch-export logs to S3
 * on a configurable schedule (default: daily).  An EventBridge rule triggers
 * a Lambda function that calls `CreateExportTask` for the previous day's logs.
 *
 * Architecture:
 *   EventBridge Rule (schedule)
 *     → Lambda (CreateExportTask)
 *     → CloudWatch Logs Export API
 *     → S3 Bucket (with bucket policy for CWL service principal)
 *
 * Trade-offs vs Pattern A (Firehose):
 *   + No Firehose cost; simpler if near-real-time delivery is not needed
 *   + Lower cost for infrequent, large-volume exports
 *   - Not real-time; exports are scheduled (up to 12 hours delay)
 *   - Only one export task can run per account at a time
 *   - Maximum 1 export task per second API rate limit
 */
export class CloudwatchLogsS3ArchiveExportStack extends cdk.Stack {
    public readonly logGroup: logs.LogGroup;
    public readonly archiveBucket: s3.Bucket;
    public readonly exportFunction: lambda.Function;

    constructor(scope: Construct, id: string, props: CloudwatchLogsS3ArchiveExportStackProps) {
        super(scope, id, props);

        const exportParams: ExportTaskParams = props.params.exportTask ?? {};

        const scheduleExpression =
            exportParams.scheduleExpression ?? defaultExportTaskConfig.scheduleExpression;
        const s3Prefix = exportParams.s3Prefix ?? defaultExportTaskConfig.s3Prefix;
        const retention = exportParams.retention ?? defaultExportTaskConfig.retention;
        const memorySize = exportParams.memorySize ?? defaultExportTaskConfig.memorySize;
        const timeout = exportParams.timeout ?? defaultExportTaskConfig.timeout;
        const logGroupNameSuffix =
            exportParams.logGroupNameSuffix ?? defaultExportTaskConfig.logGroupNameSuffix;

        // -----------------------------------------------------------------------
        // CloudWatch Log Group (source)
        // -----------------------------------------------------------------------
        this.logGroup = new logs.LogGroup(this, 'ArchiveLogGroup', {
            logGroupName: `/${props.project}/${props.environment}/${logGroupNameSuffix}`,
            retention,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });

        // -----------------------------------------------------------------------
        // S3 Archive Bucket
        // The bucket policy must allow logs.amazonaws.com to:
        //   1. GetBucketAcl  (CloudWatch Logs checks ACL before exporting)
        //   2. PutObject     (actual log data delivery)
        // -----------------------------------------------------------------------
        this.archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
            autoDeleteObjects: props.isAutoDeleteObject,
            enforceSSL: true,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        this.archiveBucket.addLifecycleRule({
            id: 'AbortIncompleteMultipartUploadsAfter7Days',
            enabled: true,
            abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        });
        this.archiveBucket.addLifecycleRule({
            id: 'ExpireNonCurrentVersionsAfter90Days',
            enabled: true,
            noncurrentVersionExpiration: cdk.Duration.days(90),
            noncurrentVersionsToRetain: 3,
        });

        // Allow CWL to check bucket ACL before starting an export
        this.archiveBucket.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal('logs.amazonaws.com')],
                actions: ['s3:GetBucketAcl'],
                resources: [this.archiveBucket.bucketArn],
                conditions: {
                    ArnLike: {
                        'aws:SourceArn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
                    },
                },
            }),
        );

        // Allow CWL to write exported log files with full-control ACL
        this.archiveBucket.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal('logs.amazonaws.com')],
                actions: ['s3:PutObject'],
                resources: [this.archiveBucket.arnForObjects('*')],
                conditions: {
                    StringEquals: {
                        's3:x-amz-acl': 'bucket-owner-full-control',
                    },
                    ArnLike: {
                        'aws:SourceArn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
                    },
                },
            }),
        );

        // -----------------------------------------------------------------------
        // Lambda – calls CreateExportTask for the previous day
        // -----------------------------------------------------------------------
        this.exportFunction = new lambda.Function(this, 'ExportTaskFunction', {
            functionName: `${props.project}-${props.environment}-cwl-export-task`,
            description: 'Schedules a CloudWatch Logs export task to S3',
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.lambda_handler',
            code: lambda.Code.fromAsset(
                path.join(__dirname, '../../src/lambda/export-task'),
            ),
            memorySize,
            timeout,
            environment: {
                LOG_GROUP_NAME: this.logGroup.logGroupName,
                S3_BUCKET_NAME: this.archiveBucket.bucketName,
                S3_PREFIX: s3Prefix,
            },
            logGroup: new logs.LogGroup(this, 'ExportTaskFunctionLogGroup', {
                retention: logs.RetentionDays.ONE_WEEK,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
        });

        // Grant Lambda permission to create and describe export tasks for this log group
        this.exportFunction.addToRolePolicy(
            new iam.PolicyStatement({
                actions: [
                    'logs:CreateExportTask',
                    'logs:DescribeExportTasks',
                ],
                resources: ['*'],
            }),
        );

        // -----------------------------------------------------------------------
        // EventBridge Rule – triggers Lambda on the configured schedule
        // -----------------------------------------------------------------------
        const exportRule = new events.Rule(this, 'ExportScheduleRule', {
            ruleName: `${props.project}-${props.environment}-cwl-export-schedule`,
            description: 'Triggers CloudWatch Logs export task to S3 on schedule',
            schedule: events.Schedule.expression(scheduleExpression),
        });
        exportRule.addTarget(new targets.LambdaFunction(this.exportFunction));

        // -----------------------------------------------------------------------
        // Stack Outputs
        // -----------------------------------------------------------------------
        new cdk.CfnOutput(this, 'LogGroupName', {
            value: this.logGroup.logGroupName,
            description: 'Name of the CloudWatch Log Group being exported',
        });
        new cdk.CfnOutput(this, 'ExportFunctionName', {
            value: this.exportFunction.functionName,
            description: 'Name of the export task Lambda function',
        });
        new cdk.CfnOutput(this, 'ArchiveBucketName', {
            value: this.archiveBucket.bucketName,
            description: 'Name of the S3 Archive Bucket',
        });
        new cdk.CfnOutput(this, 'ScheduleExpression', {
            value: scheduleExpression,
            description: 'EventBridge schedule expression for the export task',
        });
    }
}
