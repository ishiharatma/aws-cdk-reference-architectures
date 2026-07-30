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
import * as logs_destinations from 'aws-cdk-lib/aws-logs-destinations';

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
    public readonly logGroups: logs.LogGroup[] = [];
    public readonly archiveBucket: s3.Bucket;
    public readonly deliveryStream: firehose.DeliveryStream;

    constructor(scope: Construct, id: string, props: CloudwatchLogsS3ArchiveBasicStackProps) {
        super(scope, id, props);

        const logGroupParams: LogGroupArchiveParams = props.params.logGroup;
        const firehoseParams: FirehoseS3Params = props.params.firehose;

        // -----------------------------------------------------------------------
        // CloudWatch Log Group
        // -----------------------------------------------------------------------
        const createLogGroups:number = 5;
        for (let i = 1; i <= createLogGroups; i++) {
            const logGroup = new logs.LogGroup(this, `LogGroup${i}`, {
                logGroupName: logGroupParams.logGroupNameSuffix
                    ? `/${props.project}/${props.environment}/basic-${logGroupParams.logGroupNameSuffix}-${i}`
                    : undefined,
                retention: logGroupParams.retention ?? defaultLogGroupArchiveConfig.retention,
                removalPolicy: props.isAutoDeleteObject
                    ? cdk.RemovalPolicy.DESTROY
                    : cdk.RemovalPolicy.RETAIN,
            });
            this.logGroups.push(logGroup);
        }

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
        // Dynamic partitioning: CWL delivers gzip-compressed JSON envelopes
        // ({owner, logGroup, logStream, logEvents:[...]}); DecompressionProcessor
        // unzips this envelope, which already has `owner`/`logGroup` at the top
        // level, so MetadataExtractionProcessor can read them directly to extract
        // partition keys. AppendDelimiterToRecordProcessor adds a newline so
        // records aren't concatenated without separation in the S3 object.
        // This lets the 5 shared log groups land under distinct S3 prefixes
        // instead of being interleaved in the same object.
        //
        // Note: CloudWatchLogProcessor (message extraction) is deliberately NOT
        // used here — it strips `owner`/`logGroup` from the record (keeping only
        // the raw `message` content), which breaks the MetadataExtractionProcessor
        // jq queries below with DynamicPartitioning.MetadataExtractionFailed.
        // As a result, each S3 record is the full CWL envelope (with a nested
        // `logEvents` array of possibly multiple events), not one flattened
        // line per log event.
        // -----------------------------------------------------------------------
        // The prefix must reference the `owner`/`logGroup` partition keys produced
        // by the MetadataExtractionProcessor below, so it is fixed here rather than
        // taken from `firehoseParams.dataOutputPrefix` (shared with the
        // non-partitioned stacks, where it is just a timestamp prefix).
        const dynamicPartitioningDataOutputPrefix =
            'AWSLogs/!{partitionKeyFromQuery:owner}/CWLogGroup/!{partitionKeyFromQuery:logGroup}/!{timestamp:yyyy/MM/dd/HH}/';

        // Dynamic partitioning requires bufferingSize >= 64 MiB and bufferingInterval
        // >= 60s. `firehoseParams` is shared with stacks that don't partition (e.g.
        // dev/test use 1 MiB), so clamp up rather than failing synth.
        const requestedBufferingSize =
            firehoseParams.bufferingSize ?? defaultFirehoseS3Config.bufferingSize;
        const bufferingSize =
            requestedBufferingSize.toMebibytes() < 64 ? cdk.Size.mebibytes(64) : requestedBufferingSize;

        const requestedBufferingInterval =
            firehoseParams.bufferingInterval ?? defaultFirehoseS3Config.bufferingInterval;
        const bufferingInterval =
            requestedBufferingInterval.toSeconds() < 60
                ? cdk.Duration.seconds(60)
                : requestedBufferingInterval;

        const s3Destination = new firehose.S3Bucket(this.archiveBucket, {
            dataOutputPrefix: dynamicPartitioningDataOutputPrefix,
            errorOutputPrefix:
                firehoseParams.errorOutputPrefix ?? defaultFirehoseS3Config.errorOutputPrefix,
            timeZone: firehoseParams.timeZone ?? defaultFirehoseS3Config.timeZone,
            bufferingInterval,
            bufferingSize,
            role: firehoseRole,
            compression: firehose.Compression.GZIP,
            dynamicPartitioning: {
                enabled: true,
            },
            processors: [
                new firehose.DecompressionProcessor({
                    compressionFormat: firehose.DecompressionProcessorCompressionFormat.GZIP,
                }),
                // CWL periodically sends CONTROL_MESSAGE health-check records to verify
                // the destination is reachable; these have `owner`/`logGroup` set to "",
                // which fails dynamic partitioning ("partitionKeys values must not be
                // null or empty") unless a fallback value is supplied here.
                firehose.MetadataExtractionProcessor.jq16({
                    owner: '(if (.owner // "") == "" then "controlmessages" else .owner end)',
                    logGroup:
                        '(if (.logGroup // "") == "" then "controlmessages" else (.logGroup | ltrimstr("/")) end)',
                }),
                new firehose.AppendDelimiterToRecordProcessor(),
            ],
        });

        this.deliveryStream = new firehose.DeliveryStream(this, 'ArchiveDeliveryStream', {
            destination: s3Destination,
            encryption: firehose.StreamEncryption.awsOwnedKey(),
        });

        // -----------------------------------------------------------------------
        // IAM Role: CloudWatch Logs → Firehose
        // SourceArn condition restricts trust to log groups in this account/region.
        // Only the trust policy is defined here; FirehoseDestination.bind() grants
        // firehose:PutRecord/PutRecordBatch on this role via grantPutRecords().
        // -----------------------------------------------------------------------
        const cwlToFirehoseRole = new iam.Role(this, 'CwlToFirehoseRole', {
            assumedBy: new iam.ServicePrincipal('logs.amazonaws.com', {
                conditions: {
                    StringLike: {
                        'aws:SourceArn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
                    },
                },
            }),
        });

        // -----------------------------------------------------------------------
        // Subscription Filter: CloudWatch Logs → Firehose
        // FirehoseDestination.bind() wires cwlToFirehoseRole in as the roleArn
        // passed to the underlying CfnSubscriptionFilter.
        // -----------------------------------------------------------------------
        const filterPattern = logGroupParams.filterPattern ?? defaultLogGroupArchiveConfig.filterPattern;
        this.logGroups.forEach((logGroup, index) => {
            new logs.SubscriptionFilter(this, `CwlSubscriptionFilter${index + 1}`, {
                logGroup: logGroup,
                destination: new logs_destinations.FirehoseDestination(this.deliveryStream, {
                    role: cwlToFirehoseRole,
                }),
                filterPattern: filterPattern
                    ? logs.FilterPattern.literal(filterPattern)
                    : logs.FilterPattern.allEvents(),
            });
        });

        // -----------------------------------------------------------------------
        // Stack Outputs
        // -----------------------------------------------------------------------
        new cdk.CfnOutput(this, 'LogGroupNames', {
            value: this.logGroups.map((lg) => lg.logGroupName).join(', '),
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
