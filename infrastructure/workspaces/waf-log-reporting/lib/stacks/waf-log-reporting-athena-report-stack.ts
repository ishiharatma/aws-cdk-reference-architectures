import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logs_destinations from 'aws-cdk-lib/aws-logs-destinations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as scheduler_targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Environment } from '@common/parameters/environments';
import { AthenaReportParams, defaultAthenaReportConfig, defaultReportConfig } from 'lib/types';
import { EnvParams } from 'parameters/environments';

export interface WafLogReportingAthenaReportStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
    /**
     * Log group name of the standalone sample Web ACL created by
     * `WafLogReportingSampleWafStack`. Used only when
     * `params.athenaReport.existingSource` is not set.
     */
    readonly sampleLogGroupName: string;
}

/**
 * WAF log JSON schema, shared by both the Hive-style (Firehose sample) and
 * native AWS-WAF-S3 (existing source) Glue tables.
 * See: https://docs.aws.amazon.com/waf/latest/developerguide/logging-fields.html
 */
const WAF_LOG_COLUMNS: glue.CfnTable.ColumnProperty[] = [
    { name: 'timestamp', type: 'bigint' },
    { name: 'formatversion', type: 'int' },
    { name: 'webaclid', type: 'string' },
    { name: 'terminatingruleid', type: 'string' },
    { name: 'terminatingruletype', type: 'string' },
    { name: 'action', type: 'string' },
    { name: 'httpsourcename', type: 'string' },
    { name: 'httpsourceid', type: 'string' },
    {
        name: 'rulegrouplist',
        type: 'array<struct<rulegroupid:string,terminatingrule:struct<ruleid:string,action:string,rulematchdetails:string>,nonterminatingmatchingrules:array<struct<ruleid:string,action:string>>,excludedrules:string>>',
    },
    { name: 'ratebasedrulelist', type: 'array<struct<ratebasedruleid:string,limitkey:string,maxrateallowed:int>>' },
    {
        name: 'nonterminatingmatchingrules',
        type: 'array<struct<ruleid:string,action:string,rulematchdetails:array<struct<conditiontype:string,location:string,matcheddata:array<string>>>>>',
    },
    {
        name: 'httprequest',
        type: 'struct<clientip:string,country:string,headers:array<struct<name:string,value:string>>,uri:string,args:string,httpversion:string,httpmethod:string,requestid:string>',
    },
    { name: 'labels', type: 'array<struct<name:string>>' },
    { name: 'responsecodesent', type: 'string' },
];

const PYTHON_LAMBDA_DIR = path.join(__dirname, '../../src/lambda');

/**
 * Stack 3 – Pattern 2: Amazon Athena + Lambda + SNS
 *
 * A scheduled Lambda function runs SQL queries against a Glue Data Catalog
 * table (Athena partition projection, no crawler needed) built over the WAF
 * logs in S3, then publishes the formatted report to SNS.
 *
 * Architecture (sample source, default):
 *   Sample Web ACL's CloudWatch Logs log group (Stack 1)
 *     -> Subscription Filter -> Kinesis Data Firehose -> S3 (Hive-style prefix)
 *     -> Glue Table (partition projection over year/month/day)
 *   EventBridge Scheduler (daily cron)
 *     -> Lambda (runs several Athena SQL queries, formats report)
 *     -> SNS Topic -> Email
 *
 * Architecture (existing source, `params.athenaReport.existingSource` set):
 *   Existing S3 bucket already receiving WAF logs (native AWS WAF S3 logging
 *   destination, or your own Firehose pipeline)
 *     -> Glue Table (partition projection; native AWS WAF layout uses a
 *        single `day` date-projection column since it is not Hive-style)
 *   EventBridge Scheduler -> Lambda -> SNS Topic -> Email (same as above)
 *
 * Trade-offs vs Pattern 1 (CloudWatch Logs Insights, see CwLogsReportStack):
 *   + SQL can `CROSS JOIN UNNEST(nonterminatingmatchingrules)` to count every
 *     COUNT-mode rule match per request exactly, not just the first one.
 *   + Scales cost-effectively to large log volumes / long retention: each
 *     query only scans the partitions (days) it needs, and S3 storage is
 *     far cheaper than CloudWatch Logs ingestion+storage at high volume.
 *   - More moving parts to provision (S3, Glue Catalog, Athena workgroup,
 *     and — in sample mode — a Firehose delivery stream).
 *   - Data latency: Firehose buffers before flushing to S3, and Athena query
 *     start-up adds a few seconds versus querying CloudWatch Logs directly.
 */
export class WafLogReportingAthenaReportStack extends cdk.Stack {
    public readonly topic: sns.Topic;
    public readonly reportFunction: lambda.Function;
    public readonly databaseName: string;
    public readonly tableName = 'waf_logs';

    constructor(scope: Construct, id: string, props: WafLogReportingAthenaReportStackProps) {
        super(scope, id, props);

        const athenaParams: AthenaReportParams = props.params.athenaReport ?? {};

        const notificationEmail = athenaParams.notificationEmail ?? defaultReportConfig.notificationEmail;
        const scheduleExpression = athenaParams.scheduleExpression ?? defaultReportConfig.scheduleExpression;
        const scheduleTimeZone = athenaParams.scheduleTimeZone ?? defaultReportConfig.scheduleTimeZone;
        const topN = athenaParams.topN ?? defaultReportConfig.topN;
        const anomalyThresholdPercent =
            athenaParams.anomalyThresholdPercent ?? defaultReportConfig.anomalyThresholdPercent;
        const locale = athenaParams.locale ?? defaultReportConfig.locale;
        const functionMemorySize = athenaParams.functionMemorySize ?? defaultReportConfig.functionMemorySize;
        const functionTimeout = athenaParams.functionTimeout ?? defaultReportConfig.functionTimeout;
        const functionLogRetention =
            athenaParams.functionLogRetention ?? defaultReportConfig.functionLogRetention;
        const queryResultsExpirationDays =
            athenaParams.queryResultsExpirationDays ?? defaultAthenaReportConfig.queryResultsExpirationDays;

        const removalPolicy = props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

        // -----------------------------------------------------------------------
        // Glue Data Catalog Database (shared by both source modes)
        // -----------------------------------------------------------------------
        this.databaseName = `${props.project}_${props.environment}_waf_log_reporting`.replace(/-/g, '_');
        new glue.CfnDatabase(this, 'WafLogsDatabase', {
            catalogId: this.account,
            databaseInput: { name: this.databaseName },
        });

        let logsBucket: s3.IBucket;
        let tableLocation: string;
        let tableParameters: Record<string, string>;
        let partitionKeys: glue.CfnTable.ColumnProperty[];
        // Tells the report Lambda which partition column(s) to filter on:
        // 'hive' -> year/month/day string columns; 'native' -> a single `day`
        // date column (the AWS-WAF-native S3 logging layout).
        let partitionScheme: 'hive' | 'native' = 'hive';

        if (athenaParams.existingSource) {
            // -------------------------------------------------------------------
            // Existing source: point the Glue table directly at logs already in S3
            // -------------------------------------------------------------------
            const existing = athenaParams.existingSource;
            logsBucket = s3.Bucket.fromBucketName(this, 'ExistingWafLogsBucket', existing.bucketName);

            const accountId = existing.accountId ?? this.account;
            const region = existing.region ?? this.region;
            const hiveStyle = existing.hiveStylePartitioning ?? false;

            if (hiveStyle) {
                const keyPrefix = existing.keyPrefix ?? 'waf-logs/';
                tableLocation = `s3://${logsBucket.bucketName}/${keyPrefix}`;
                partitionKeys = [
                    { name: 'year', type: 'string' },
                    { name: 'month', type: 'string' },
                    { name: 'day', type: 'string' },
                ];
                tableParameters = {
                    classification: 'json',
                    'projection.enabled': 'true',
                    'projection.year.type': 'integer',
                    'projection.year.range': '2024,2035',
                    'projection.month.type': 'integer',
                    'projection.month.range': '1,12',
                    'projection.month.digits': '2',
                    'projection.day.type': 'integer',
                    'projection.day.range': '1,31',
                    'projection.day.digits': '2',
                    'storage.location.template': `${tableLocation}year=\${year}/month=\${month}/day=\${day}/`,
                };
            } else {
                // Native AWS WAF S3 logging destination layout:
                //   AWSLogs/<account-id>/WAFLogs/<region>/<web-acl-name>/yyyy/MM/dd/HH/...
                if (!existing.webAclName) {
                    throw new Error(
                        'params.athenaReport.existingSource.webAclName is required when keyPrefix/' +
                            'hiveStylePartitioning are not set (used to derive the native AWS WAF S3 log path).',
                    );
                }
                const keyPrefix =
                    existing.keyPrefix ?? `AWSLogs/${accountId}/WAFLogs/${region}/${existing.webAclName}/`;
                tableLocation = `s3://${logsBucket.bucketName}/${keyPrefix}`;
                partitionKeys = [{ name: 'day', type: 'date' }];
                partitionScheme = 'native';
                tableParameters = {
                    classification: 'json',
                    'projection.enabled': 'true',
                    'projection.day.type': 'date',
                    'projection.day.range': '2024/01/01,NOW',
                    'projection.day.format': 'yyyy/MM/dd',
                    'projection.day.interval': '1',
                    'projection.day.interval.unit': 'DAYS',
                    // Files live one level deeper (.../day/HH/*.log.gz); Athena
                    // lists all objects recursively under a partition location.
                    'storage.location.template': `${tableLocation}\${day}/`,
                };
            }
        } else {
            // -------------------------------------------------------------------
            // Sample source: subscribe a Firehose to the sample Web ACL's log
            // group and land it in a new S3 bucket with a Hive-style prefix.
            // -------------------------------------------------------------------
            const firehoseBufferingInterval =
                athenaParams.firehoseBufferingInterval ?? defaultAthenaReportConfig.firehoseBufferingInterval;
            const firehoseBufferingSize =
                athenaParams.firehoseBufferingSize ?? defaultAthenaReportConfig.firehoseBufferingSize;

            const sampleWafLogsBucket = new s3.Bucket(this, 'WafLogsBucket', {
                removalPolicy,
                autoDeleteObjects: props.isAutoDeleteObject,
                enforceSSL: true,
                encryption: s3.BucketEncryption.S3_MANAGED,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                lifecycleRules: [
                    {
                        id: 'AbortIncompleteMultipartUploadsAfter7Days',
                        enabled: true,
                        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
                    },
                ],
            });
            logsBucket = sampleWafLogsBucket;

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
                                resources: [sampleWafLogsBucket.bucketArn, sampleWafLogsBucket.arnForObjects('*')],
                            }),
                        ],
                    }),
                },
            });

            const s3Destination = new firehose.S3Bucket(sampleWafLogsBucket, {
                dataOutputPrefix: 'waf-logs/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
                errorOutputPrefix: 'waf-logs-errors/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/',
                bufferingInterval: firehoseBufferingInterval,
                bufferingSize: firehoseBufferingSize,
                role: firehoseRole,
                compression: firehose.Compression.GZIP,
            });

            const deliveryStream = new firehose.DeliveryStream(this, 'WafLogsDeliveryStream', {
                deliveryStreamName: `${props.project}-${props.environment}-waf-log-reporting`,
                destination: s3Destination,
                encryption: firehose.StreamEncryption.awsOwnedKey(),
            });

            const sampleLogGroup = logs.LogGroup.fromLogGroupName(this, 'SampleLogGroup', props.sampleLogGroupName);

            const cwlToFirehoseRole = new iam.Role(this, 'CwlToFirehoseRole', {
                assumedBy: new iam.ServicePrincipal('logs.amazonaws.com', {
                    conditions: { StringLike: { 'aws:SourceArn': sampleLogGroup.logGroupArn } },
                }),
            });

            new logs.SubscriptionFilter(this, 'WafLogsSubscriptionFilter', {
                logGroup: sampleLogGroup,
                destination: new logs_destinations.FirehoseDestination(deliveryStream, { role: cwlToFirehoseRole }),
                filterPattern: logs.FilterPattern.allEvents(),
            });

            tableLocation = `s3://${sampleWafLogsBucket.bucketName}/waf-logs/`;
            partitionKeys = [
                { name: 'year', type: 'string' },
                { name: 'month', type: 'string' },
                { name: 'day', type: 'string' },
            ];
            tableParameters = {
                classification: 'json',
                'projection.enabled': 'true',
                'projection.year.type': 'integer',
                'projection.year.range': '2024,2035',
                'projection.month.type': 'integer',
                'projection.month.range': '1,12',
                'projection.month.digits': '2',
                'projection.day.type': 'integer',
                'projection.day.range': '1,31',
                'projection.day.digits': '2',
                'storage.location.template': `${tableLocation}year=\${year}/month=\${month}/day=\${day}/`,
            };
        }

        // -----------------------------------------------------------------------
        // Glue Table
        // -----------------------------------------------------------------------
        const table = new glue.CfnTable(this, 'WafLogsTable', {
            catalogId: this.account,
            databaseName: this.databaseName,
            tableInput: {
                name: this.tableName,
                tableType: 'EXTERNAL_TABLE',
                parameters: tableParameters,
                partitionKeys,
                storageDescriptor: {
                    location: tableLocation,
                    inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
                    outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
                    serdeInfo: {
                        serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
                        parameters: { 'case.insensitive': 'true' },
                    },
                    columns: WAF_LOG_COLUMNS,
                },
            },
        });

        // -----------------------------------------------------------------------
        // Athena Workgroup + query-results bucket
        // -----------------------------------------------------------------------
        const queryResultsBucket = new s3.Bucket(this, 'AthenaQueryResultsBucket', {
            removalPolicy,
            autoDeleteObjects: props.isAutoDeleteObject,
            enforceSSL: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            lifecycleRules: [
                {
                    id: 'ExpireQueryResults',
                    enabled: true,
                    expiration: cdk.Duration.days(queryResultsExpirationDays),
                },
            ],
        });

        const workgroupName = `${props.project}-${props.environment}-waf-log-reporting`;
        new athena.CfnWorkGroup(this, 'WafLogReportingWorkGroup', {
            name: workgroupName,
            description: 'Workgroup used by the daily WAF Athena report Lambda',
            workGroupConfiguration: {
                resultConfiguration: { outputLocation: `s3://${queryResultsBucket.bucketName}/athena-results/` },
                enforceWorkGroupConfiguration: true,
                publishCloudWatchMetricsEnabled: true,
            },
        });

        // -----------------------------------------------------------------------
        // SNS Topic
        // -----------------------------------------------------------------------
        const snsManagedKey = kms.Alias.fromAliasName(this, 'SnsManagedKey', 'alias/aws/sns');

        this.topic = new sns.Topic(this, 'AthenaReportTopic', {
            topicName: `${props.project}-${props.environment}-waf-athena-report`,
            displayName: 'WAF daily report (Athena)',
            enforceSSL: true,
            masterKey: snsManagedKey,
        });
        this.topic.addSubscription(new snsSubscriptions.EmailSubscription(notificationEmail));

        // -----------------------------------------------------------------------
        // Report Lambda
        // -----------------------------------------------------------------------
        this.reportFunction = new lambda.Function(this, 'AthenaReportFunction', {
            functionName: `${props.project}-${props.environment}-waf-athena-report`,
            description: 'Builds a daily WAF activity report from Athena and publishes it to SNS',
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.lambda_handler',
            code: lambda.Code.fromAsset(path.join(PYTHON_LAMBDA_DIR, 'athena-report')),
            memorySize: functionMemorySize,
            timeout: functionTimeout,
            environment: {
                ATHENA_DATABASE: this.databaseName,
                ATHENA_TABLE: this.tableName,
                ATHENA_WORKGROUP: workgroupName,
                PARTITION_SCHEME: partitionScheme,
                TOPIC_ARN: this.topic.topicArn,
                TOP_N: String(topN),
                ANOMALY_THRESHOLD_PERCENT: String(anomalyThresholdPercent),
                LOCALE: locale,
            },
            logGroup: new logs.LogGroup(this, 'AthenaReportFunctionLogGroup', {
                retention: functionLogRetention,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
            loggingFormat: lambda.LoggingFormat.JSON,
            applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
        });

        this.reportFunction.addToRolePolicy(
            new iam.PolicyStatement({
                actions: [
                    'athena:StartQueryExecution',
                    'athena:GetQueryExecution',
                    'athena:GetQueryResults',
                    'athena:StopQueryExecution',
                ],
                resources: [
                    `arn:${this.partition}:athena:${this.region}:${this.account}:workgroup/${workgroupName}`,
                ],
            }),
        );
        this.reportFunction.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['glue:GetTable', 'glue:GetDatabase', 'glue:GetPartitions'],
                resources: [
                    `arn:${this.partition}:glue:${this.region}:${this.account}:catalog`,
                    `arn:${this.partition}:glue:${this.region}:${this.account}:database/${this.databaseName}`,
                    `arn:${this.partition}:glue:${this.region}:${this.account}:table/${this.databaseName}/${this.tableName}`,
                ],
            }),
        );
        logsBucket.grantRead(this.reportFunction);
        queryResultsBucket.grantReadWrite(this.reportFunction);
        this.topic.grantPublish(this.reportFunction);

        // Ensure the table exists before the Lambda (referenced only via env
        // vars, but this keeps `cdk deploy` ordering sane for first deploys).
        this.reportFunction.node.addDependency(table);

        // -----------------------------------------------------------------------
        // EventBridge Scheduler
        // -----------------------------------------------------------------------
        new scheduler.Schedule(this, 'AthenaReportSchedule', {
            scheduleName: `${props.project}-${props.environment}-waf-athena-report`,
            description: 'Triggers the daily WAF Athena report',
            schedule: scheduler.ScheduleExpression.expression(scheduleExpression, scheduleTimeZone),
            target: new scheduler_targets.LambdaInvoke(this.reportFunction),
        });

        // -----------------------------------------------------------------------
        // Stack Outputs
        // -----------------------------------------------------------------------
        new cdk.CfnOutput(this, 'ReportTopicArn', {
            value: this.topic.topicArn,
            description: 'ARN of the SNS topic the daily report is published to',
        });
        new cdk.CfnOutput(this, 'GlueDatabaseName', {
            value: this.databaseName,
            description: 'Glue Data Catalog database name',
        });
        new cdk.CfnOutput(this, 'GlueTableName', {
            value: this.tableName,
            description: 'Glue table name over the WAF logs',
        });
        new cdk.CfnOutput(this, 'AthenaWorkgroupName', {
            value: workgroupName,
            description: 'Athena workgroup used by the report Lambda',
        });
    }
}
