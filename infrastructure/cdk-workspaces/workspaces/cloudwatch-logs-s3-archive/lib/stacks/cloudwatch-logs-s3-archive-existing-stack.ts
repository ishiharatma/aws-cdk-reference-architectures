import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import {
    FirehoseS3Params,
    ExistingLogGroupParams,
    defaultFirehoseS3Config,
    defaultLogGroupArchiveConfig,
} from 'lib/types';
import { EnvParams } from 'parameters/environments';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface CloudwatchLogsS3ArchiveExistingStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
}

/**
 * Stack 3 – Archive an Existing CloudWatch Log Group to S3
 *
 * Attaches a Subscription Filter to a pre-existing CloudWatch Log Group
 * (identified by name in parameters) without modifying the log group itself.
 * Use this pattern when you want to add S3 archiving to a log group that is
 * managed by another stack or service (e.g., a Lambda function's log group).
 *
 * Architecture:
 *   Existing CloudWatch Log Group (imported by name)
 *     → Subscription Filter (IAM role: CWL → Firehose)
 *     → Kinesis Data Firehose (buffer + gzip compression)
 *     → S3 Bucket (SSE-S3, versioning enabled)
 *
 * Note: A log group can have only one subscription filter destination at a time.
 * If the existing log group already has a subscription filter, deployment will
 * fail. Remove the existing filter first.
 */
export class CloudwatchLogsS3ArchiveExistingStack extends cdk.Stack {
    public readonly archiveBucket: s3.Bucket;
    public readonly deliveryStream: firehose.DeliveryStream;

    constructor(scope: Construct, id: string, props: CloudwatchLogsS3ArchiveExistingStackProps) {
        super(scope, id, props);

        const existingLogGroupParams: ExistingLogGroupParams = props.params.existingLogGroup;
        const firehoseParams: FirehoseS3Params = props.params.firehose;

        // -----------------------------------------------------------------------
        // Import the existing CloudWatch Log Group (no modifications)
        // -----------------------------------------------------------------------
        const existingLogGroup = logs.LogGroup.fromLogGroupName(
            this,
            'ImportedLogGroup',
            existingLogGroupParams.logGroupName,
        );

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

        // Abort incomplete multipart uploads
        this.archiveBucket.addLifecycleRule({
            id: 'AbortIncompleteMultipartUploadsAfter7Days',
            enabled: true,
            abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        });

        // Expire non-current versions
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
        // The SourceArn condition scopes the trust to the specific log group ARN
        // for tighter security when targeting an existing managed log group.
        // -----------------------------------------------------------------------
        const cwlToFirehoseRole = new iam.Role(this, 'CwlToFirehoseRole', {
            assumedBy: new iam.ServicePrincipal('logs.amazonaws.com', {
                conditions: {
                    StringLike: {
                        'aws:SourceArn': existingLogGroup.logGroupArn,
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
        // Subscription Filter: Existing CloudWatch Log Group → Firehose
        // -----------------------------------------------------------------------
        new logs.CfnSubscriptionFilter(this, 'CwlSubscriptionFilter', {
            logGroupName: existingLogGroup.logGroupName,
            filterPattern:
                existingLogGroupParams.filterPattern ?? defaultLogGroupArchiveConfig.filterPattern,
            destinationArn: this.deliveryStream.deliveryStreamArn,
            roleArn: cwlToFirehoseRole.roleArn,
        });

        // -----------------------------------------------------------------------
        // Stack Outputs
        // -----------------------------------------------------------------------
        new cdk.CfnOutput(this, 'ImportedLogGroupName', {
            value: existingLogGroup.logGroupName,
            description: 'Name of the imported (existing) CloudWatch Log Group',
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
