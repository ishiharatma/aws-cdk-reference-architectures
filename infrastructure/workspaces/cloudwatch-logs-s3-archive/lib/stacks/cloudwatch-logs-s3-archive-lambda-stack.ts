import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import {
    LambdaArchiveParams,
    defaultLambdaArchiveConfig,
} from 'lib/types';
import { EnvParams } from 'parameters/environments';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logDestinations from 'aws-cdk-lib/aws-logs-destinations';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface CloudwatchLogsS3ArchiveLambdaStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
}

/**
 * Stack 5 – Pattern C: Direct write via Lambda (CloudWatch Logs → Lambda → S3)
 *
 * A CloudWatch Logs subscription filter invokes a Lambda function for every
 * batch of log events.  The Lambda decodes the gzip+base64 payload and writes
 * each batch as a JSON file to S3.
 *
 * Architecture:
 *   CloudWatch Log Group
 *     → Subscription Filter (Lambda destination; CDK manages the invoke permission)
 *     → Lambda (decode gzip+base64, write JSON to S3)
 *     → S3 Bucket
 *
 * Trade-offs vs Pattern A (Firehose):
 *   + Full control over the output format and file naming
 *   + Can apply custom filtering/transformation logic in Lambda code
 *   - Higher cost per invocation for high-volume log groups
 *   - Lambda timeout limits batch size (keep timeout ≥ CWL flush interval)
 *   - Must manage Lambda concurrency to avoid throttling
 */
export class CloudwatchLogsS3ArchiveLambdaStack extends cdk.Stack {
    public readonly logGroup: logs.LogGroup;
    public readonly archiveBucket: s3.Bucket;
    public readonly archiveFunction: lambda.Function;

    constructor(scope: Construct, id: string, props: CloudwatchLogsS3ArchiveLambdaStackProps) {
        super(scope, id, props);

        const lambdaParams: LambdaArchiveParams = props.params.lambdaArchive ?? {};

        const s3Prefix = lambdaParams.s3Prefix ?? defaultLambdaArchiveConfig.s3Prefix;
        const retention = lambdaParams.retention ?? defaultLambdaArchiveConfig.retention;
        const filterPattern = lambdaParams.filterPattern ?? defaultLambdaArchiveConfig.filterPattern;
        const memorySize = lambdaParams.memorySize ?? defaultLambdaArchiveConfig.memorySize;
        const timeout = lambdaParams.timeout ?? defaultLambdaArchiveConfig.timeout;
        const logGroupNameSuffix =
            lambdaParams.logGroupNameSuffix ?? defaultLambdaArchiveConfig.logGroupNameSuffix;

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

        // -----------------------------------------------------------------------
        // Lambda – decodes CWL payload and writes JSON to S3
        // -----------------------------------------------------------------------
        this.archiveFunction = new lambda.Function(this, 'ArchiveFunction', {
            functionName: `${props.project}-${props.environment}-cwl-to-s3`,
            description: 'Receives CloudWatch Logs events and writes them to S3',
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.lambda_handler',
            code: lambda.Code.fromAsset(
                path.join(__dirname, '../../src/lambda/cwl-to-s3'),
            ),
            memorySize,
            timeout,
            environment: {
                S3_BUCKET_NAME: this.archiveBucket.bucketName,
                S3_PREFIX: s3Prefix,
            },
            logGroup: new logs.LogGroup(this, 'ArchiveFunctionLogGroup', {
                retention: logs.RetentionDays.ONE_WEEK,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
        });

        // Grant Lambda write access to the archive bucket
        this.archiveBucket.grantWrite(this.archiveFunction);

        // -----------------------------------------------------------------------
        // Subscription Filter – CloudWatch Logs → Lambda
        // LambdaDestination automatically adds the required Lambda::Permission
        // that allows logs.amazonaws.com to invoke the function.
        // -----------------------------------------------------------------------
        const cwlFilterPattern = filterPattern
            ? logs.FilterPattern.literal(filterPattern)
            : logs.FilterPattern.allEvents();

        new logs.SubscriptionFilter(this, 'CwlSubscriptionFilter', {
            logGroup: this.logGroup,
            destination: new logDestinations.LambdaDestination(this.archiveFunction),
            filterPattern: cwlFilterPattern,
        });

        // -----------------------------------------------------------------------
        // Stack Outputs
        // -----------------------------------------------------------------------
        new cdk.CfnOutput(this, 'LogGroupName', {
            value: this.logGroup.logGroupName,
            description: 'Name of the CloudWatch Log Group being archived',
        });
        new cdk.CfnOutput(this, 'ArchiveFunctionName', {
            value: this.archiveFunction.functionName,
            description: 'Name of the archive Lambda function',
        });
        new cdk.CfnOutput(this, 'ArchiveBucketName', {
            value: this.archiveBucket.bucketName,
            description: 'Name of the S3 Archive Bucket',
        });
    }
}
