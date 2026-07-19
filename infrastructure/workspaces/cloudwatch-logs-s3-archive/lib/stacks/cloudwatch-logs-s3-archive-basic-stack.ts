import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import {
    FirehoseS3Params,
    LogGroupArchiveParams,
    defaultFirehoseS3Config,
    defaultLogGroupArchiveConfig,
} from 'lib/types';
import { EnvParams } from 'parameters/environments';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface CloudwatchLogsS3ArchiveBasicStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
}

/**
 * Stack 1 – Basic CloudWatch Logs → S3 Archive
 *
 * Creates a new CloudWatch Log Group and archives all log events to S3 in
 * near-real-time via Kinesis Data Firehose.  S3 has versioning and basic
 * housekeeping lifecycle rules (abort incomplete multipart uploads, expire
 * old non-current versions).
 *
 * Architecture:
 *   CloudWatch Log Group
 *     → Subscription Filter (IAM role: CWL → Firehose)
 *     → Kinesis Data Firehose (buffer + gzip compression)
 *     → S3 Bucket (SSE-S3, versioning enabled)
 */
export class CloudwatchLogsS3ArchiveBasicStack extends cdk.Stack {
    public readonly logGroup: logs.LogGroup;
    public readonly archiveBucket: s3.Bucket;
    public readonly deliveryStream: firehose.DeliveryStream;

    constructor(scope: Construct, id: string, props: CloudwatchLogsS3ArchiveBasicStackProps) {
        super(scope, id, props);

        const logGroupParams: LogGroupArchiveParams = props.params.logGroup;
        const firehoseParams: FirehoseS3Params = props.params.firehose;

        // -----------------------------------------------------------------------
        // CloudWatch Log Group
        // -----------------------------------------------------------------------
        this.logGroup = new logs.LogGroup(this, 'ArchiveLogGroup', {
            logGroupName: logGroupParams.logGroupNameSuffix
                ? `/${props.project}/${props.environment}/${logGroupParams.logGroupNameSuffix}`
                : undefined,
            retention: logGroupParams.retention ?? defaultLogGroupArchiveConfig.retention,
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

        // Abort incomplete multipart uploads to avoid orphaned storage costs
        this.archiveBucket.addLifecycleRule({
            id: 'AbortIncompleteMultipartUploadsAfter7Days',
            enabled: true,
            abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        });

        // Keep only 3 non-current versions to limit version accumulation
        this.archiveBucket.addLifecycleRule({
            id: 'ExpireNonCurrentVersionsAfter90Days',
            enabled: true,
            noncurrentVersionExpiration: cdk.Duration.days(90),
            noncurrentVersionsToRetain: 3,
        });

        // -----------------------------------------------------------------------
        // IAM Role: Firehose → S3
        // -----------------------------------------------------------------------
        const firehoseRole = new iam.Role(this, 'FirehoseRole', {
            assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
            inlinePolicies: {
                AllowPutToS3: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            actions: [
                                's3:AbortMultipartUpload',
                                's3:ListBucket',
                                's3:GetBucketLocation',
                                's3:GetObject',
                                's3:PutObject',
                                's3:ListBucketMultipartUploads',
                                's3:ListMultipartUploadParts',
                            ],
                            resources: [
                                this.archiveBucket.bucketArn,
                                this.archiveBucket.arnForObjects('*'),
                            ],
                        }),
                    ],
                }),
            },
        });

        // -----------------------------------------------------------------------
        // Kinesis Data Firehose → S3
        // -----------------------------------------------------------------------
        const s3Destination = new firehose.S3Bucket(this.archiveBucket, {
            dataOutputPrefix:
                firehoseParams.dataOutputPrefix ?? defaultFirehoseS3Config.dataOutputPrefix,
            errorOutputPrefix:
                firehoseParams.errorOutputPrefix ?? defaultFirehoseS3Config.errorOutputPrefix,
            timeZone: firehoseParams.timeZone ?? defaultFirehoseS3Config.timeZone,
            bufferingInterval:
                firehoseParams.bufferingInterval ?? defaultFirehoseS3Config.bufferingInterval,
            bufferingSize:
                firehoseParams.bufferingSize ?? defaultFirehoseS3Config.bufferingSize,
            role: firehoseRole,
            compression: firehose.Compression.GZIP,
        });

        this.deliveryStream = new firehose.DeliveryStream(this, 'ArchiveDeliveryStream', {
            destination: s3Destination,
            encryption: firehose.StreamEncryption.awsOwnedKey(),
        });

        // -----------------------------------------------------------------------
        // IAM Role: CloudWatch Logs → Firehose
        // SourceArn condition restricts trust to log groups in this account/region.
        // -----------------------------------------------------------------------
        const cwlToFirehoseRole = new iam.Role(this, 'CwlToFirehoseRole', {
            assumedBy: new iam.ServicePrincipal('logs.amazonaws.com', {
                conditions: {
                    StringLike: {
                        'aws:SourceArn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
                    },
                },
            }),
            inlinePolicies: {
                AllowPutToFirehose: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            actions: [
                                'firehose:PutRecord',
                                'firehose:PutRecordBatch',
                            ],
                            resources: [this.deliveryStream.deliveryStreamArn],
                        }),
                    ],
                }),
            },
        });

        // -----------------------------------------------------------------------
        // Subscription Filter: CloudWatch Logs → Firehose
        // CfnSubscriptionFilter is used here because we need to supply an explicit
        // IAM roleArn that grants CWL permission to deliver to Firehose.
        // -----------------------------------------------------------------------
        new logs.CfnSubscriptionFilter(this, 'CwlSubscriptionFilter', {
            logGroupName: this.logGroup.logGroupName,
            filterPattern: logGroupParams.filterPattern ?? defaultLogGroupArchiveConfig.filterPattern,
            destinationArn: this.deliveryStream.deliveryStreamArn,
            roleArn: cwlToFirehoseRole.roleArn,
        });

        // -----------------------------------------------------------------------
        // Stack Outputs
        // -----------------------------------------------------------------------
        new cdk.CfnOutput(this, 'LogGroupName', {
            value: this.logGroup.logGroupName,
            description: 'Name of the CloudWatch Log Group',
        });
        new cdk.CfnOutput(this, 'ArchiveDeliveryStreamName', {
            value: this.deliveryStream.deliveryStreamName,
            description: 'Name of the Firehose Delivery Stream',
        });
        new cdk.CfnOutput(this, 'ArchiveBucketName', {
            value: this.archiveBucket.bucketName,
            description: 'Name of the S3 Archive Bucket',
        });
    }
}
