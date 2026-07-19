import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import {
    FirehoseS3Params,
    LogGroupArchiveParams,
    LifecycleArchiveParams,
    defaultFirehoseS3Config,
    defaultLogGroupArchiveConfig,
    defaultLifecycleConfig,
} from 'lib/types';
import { EnvParams } from 'parameters/environments';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface CloudwatchLogsS3ArchiveLifecycleStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
}

/**
 * Stack 2 – CloudWatch Logs → S3 Archive with Tiered Lifecycle Rules
 *
 * Extends the basic archive pattern with comprehensive S3 lifecycle rules
 * that move objects through progressively cheaper storage classes over time,
 * enabling long-term log retention at minimal cost.
 *
 * Architecture:
 *   CloudWatch Log Group
 *     → Subscription Filter (IAM role: CWL → Firehose)
 *     → Kinesis Data Firehose (buffer + gzip compression)
 *     → S3 Bucket (SSE-S3, versioning, tiered lifecycle)
 *         Standard (0d)
 *         → Standard-IA (30d)
 *         → Glacier Instant Retrieval (90d)
 *         → Glacier Deep Archive (365d)
 *         → Expire (2555d / 7 years)
 */
export class CloudwatchLogsS3ArchiveLifecycleStack extends cdk.Stack {
    public readonly logGroup: logs.LogGroup;
    public readonly archiveBucket: s3.Bucket;
    public readonly deliveryStream: firehose.DeliveryStream;

    constructor(scope: Construct, id: string, props: CloudwatchLogsS3ArchiveLifecycleStackProps) {
        super(scope, id, props);

        const logGroupParams: LogGroupArchiveParams = props.params.logGroup;
        const firehoseParams: FirehoseS3Params = props.params.firehose;
        const lifecycleParams: LifecycleArchiveParams = props.params.lifecycle ?? {};

        const moveToIaAfterDays =
            lifecycleParams.moveToIaAfterDays ?? defaultLifecycleConfig.moveToIaAfterDays;
        const moveToGlacierAfterDays =
            lifecycleParams.moveToGlacierAfterDays ?? defaultLifecycleConfig.moveToGlacierAfterDays;
        const moveToDeepArchiveAfterDays =
            lifecycleParams.moveToDeepArchiveAfterDays ?? defaultLifecycleConfig.moveToDeepArchiveAfterDays;
        const expireAfterDays =
            lifecycleParams.expireAfterDays ?? defaultLifecycleConfig.expireAfterDays;
        const noncurrentVersionExpirationDays =
            lifecycleParams.noncurrentVersionExpirationDays ??
            defaultLifecycleConfig.noncurrentVersionExpirationDays;
        const noncurrentVersionsToRetain =
            lifecycleParams.noncurrentVersionsToRetain ??
            defaultLifecycleConfig.noncurrentVersionsToRetain;

        // -----------------------------------------------------------------------
        // CloudWatch Log Group
        // -----------------------------------------------------------------------
        this.logGroup = new logs.LogGroup(this, 'ArchiveLogGroup', {
            logGroupName: logGroupParams.logGroupNameSuffix
                ? `/${props.project}/${props.environment}/${logGroupParams.logGroupNameSuffix}-lifecycle`
                : undefined,
            retention: logGroupParams.retention ?? defaultLogGroupArchiveConfig.retention,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });

        // -----------------------------------------------------------------------
        // S3 Archive Bucket with Tiered Lifecycle Rules
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

        // Standard → Standard-IA
        this.archiveBucket.addLifecycleRule({
            id: `MoveToIAAfter${moveToIaAfterDays}Days`,
            enabled: true,
            transitions: [
                {
                    storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                    transitionAfter: cdk.Duration.days(moveToIaAfterDays),
                },
            ],
        });

        // Standard-IA → Glacier Instant Retrieval
        this.archiveBucket.addLifecycleRule({
            id: `MoveToGlacierAfter${moveToGlacierAfterDays}Days`,
            enabled: true,
            transitions: [
                {
                    storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
                    transitionAfter: cdk.Duration.days(moveToGlacierAfterDays),
                },
            ],
        });

        // Glacier Instant Retrieval → Deep Archive
        this.archiveBucket.addLifecycleRule({
            id: `MoveToDeepArchiveAfter${moveToDeepArchiveAfterDays}Days`,
            enabled: true,
            transitions: [
                {
                    storageClass: s3.StorageClass.DEEP_ARCHIVE,
                    transitionAfter: cdk.Duration.days(moveToDeepArchiveAfterDays),
                },
            ],
        });

        // Expire current objects after the configured retention period
        if (expireAfterDays > 0) {
            this.archiveBucket.addLifecycleRule({
                id: `ExpireCurrentObjectsAfter${expireAfterDays}Days`,
                enabled: true,
                expiration: cdk.Duration.days(expireAfterDays),
            });
        }

        // Non-current version transition to IA after 30 days
        this.archiveBucket.addLifecycleRule({
            id: 'NoncurrentVersionTransitionToIAAfter30Days',
            enabled: true,
            noncurrentVersionTransitions: [
                {
                    storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                    transitionAfter: cdk.Duration.days(30),
                },
            ],
        });

        // Expire non-current versions
        this.archiveBucket.addLifecycleRule({
            id: `ExpireNonCurrentVersionsAfter${noncurrentVersionExpirationDays}Days`,
            enabled: true,
            noncurrentVersionExpiration: cdk.Duration.days(noncurrentVersionExpirationDays),
            noncurrentVersionsToRetain: noncurrentVersionsToRetain,
        });

        // Abort incomplete multipart uploads to avoid orphaned storage costs
        this.archiveBucket.addLifecycleRule({
            id: 'AbortIncompleteMultipartUploadsAfter7Days',
            enabled: true,
            abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
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
        new cdk.CfnOutput(this, 'LifecycleSummary', {
            value: `IA:${moveToIaAfterDays}d → Glacier:${moveToGlacierAfterDays}d → DeepArchive:${moveToDeepArchiveAfterDays}d → Expire:${expireAfterDays}d`,
            description: 'Summary of the S3 lifecycle transition rules',
        });
    }
}
