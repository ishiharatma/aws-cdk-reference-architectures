import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as scheduler_targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Environment } from '@common/parameters/environments';
import { CwLogsReportParams, defaultReportConfig } from 'lib/types';
import { EnvParams } from 'parameters/environments';

export interface WafLogReportingCwLogsReportStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
    /**
     * Log group name of the standalone sample Web ACL created by
     * `WafLogReportingSampleWafStack`. Used only when
     * `params.cwLogsReport.existingLogGroupName` is not set.
     */
    readonly sampleLogGroupName: string;
}

const PYTHON_LAMBDA_DIR = path.join(__dirname, '../../src/lambda');

/**
 * Stack 2 – Pattern 1: CloudWatch Logs Insights + Lambda + SNS
 *
 * A scheduled Lambda function runs CloudWatch Logs Insights queries directly
 * against the WAF log group (no subscription filter / real-time hop is
 * needed for a daily digest) to build a report of Block/Count activity for
 * the trailing period, then publishes the formatted report to SNS.
 *
 * Architecture:
 *   EventBridge Scheduler (daily cron)
 *     -> Lambda (runs several CloudWatch Logs Insights queries, formats report)
 *     -> SNS Topic -> Email
 *
 * Report target selection:
 *   - `params.cwLogsReport.existingLogGroupName` set  -> reports on that
 *     existing WAF log group (no dependency on Stack 1).
 *   - unset (default)                                  -> reports on the
 *     standalone sample Web ACL's log group from Stack 1.
 *
 * Trade-offs vs Pattern 2 (Athena, see AthenaReportStack):
 *   + No S3/Glue/Athena setup required; works directly against the live log
 *     group with no extra data pipeline.
 *   + Lower latency to first report (no need to wait for a Firehose buffer
 *     to flush) and no per-query-scanned-byte cost.
 *   - CloudWatch Logs Insights cannot unnest JSON arrays, so counting every
 *     COUNT-mode rule match per request (`nonTerminatingMatchingRules`) is
 *     only approximate here (first match only) — see `query_count_mode_rules`
 *     in the Lambda source.
 *   - Query results are capped (10,000 records) and queries scan the full
 *     log volume in the period each run, which becomes slow/costly at very
 *     high request volumes or long retention.
 */
export class WafLogReportingCwLogsReportStack extends cdk.Stack {
    public readonly topic: sns.Topic;
    public readonly reportFunction: lambda.Function;

    constructor(scope: Construct, id: string, props: WafLogReportingCwLogsReportStackProps) {
        super(scope, id, props);

        const cwLogsParams: CwLogsReportParams = props.params.cwLogsReport ?? {};

        const notificationEmail = cwLogsParams.notificationEmail ?? defaultReportConfig.notificationEmail;
        const scheduleExpression = cwLogsParams.scheduleExpression ?? defaultReportConfig.scheduleExpression;
        const scheduleTimeZone = cwLogsParams.scheduleTimeZone ?? defaultReportConfig.scheduleTimeZone;
        const reportPeriodHours = cwLogsParams.reportPeriodHours ?? 24;
        const topN = cwLogsParams.topN ?? defaultReportConfig.topN;
        const anomalyThresholdPercent =
            cwLogsParams.anomalyThresholdPercent ?? defaultReportConfig.anomalyThresholdPercent;
        const locale = cwLogsParams.locale ?? defaultReportConfig.locale;
        const functionMemorySize = cwLogsParams.functionMemorySize ?? defaultReportConfig.functionMemorySize;
        const functionTimeout = cwLogsParams.functionTimeout ?? defaultReportConfig.functionTimeout;
        const functionLogRetention =
            cwLogsParams.functionLogRetention ?? defaultReportConfig.functionLogRetention;

        const targetLogGroupName = cwLogsParams.existingLogGroupName ?? props.sampleLogGroupName;

        // Import by name only (no cross-stack Fn::ImportValue): the sample
        // stack's log group name is a literal string, not a token, so this
        // avoids a hard CloudFormation export/import coupling between stacks.
        const targetLogGroup = logs.LogGroup.fromLogGroupName(this, 'TargetLogGroup', targetLogGroupName);

        // -----------------------------------------------------------------------
        // SNS Topic
        // -----------------------------------------------------------------------
        const snsManagedKey = kms.Alias.fromAliasName(this, 'SnsManagedKey', 'alias/aws/sns');

        this.topic = new sns.Topic(this, 'CwLogsReportTopic', {
            topicName: `${props.project}-${props.environment}-waf-cwlogs-report`,
            displayName: 'WAF daily report (CloudWatch Logs Insights)',
            enforceSSL: true,
            masterKey: snsManagedKey,
        });
        this.topic.addSubscription(new snsSubscriptions.EmailSubscription(notificationEmail));

        // -----------------------------------------------------------------------
        // Report Lambda
        // -----------------------------------------------------------------------
        this.reportFunction = new lambda.Function(this, 'CwLogsReportFunction', {
            functionName: `${props.project}-${props.environment}-waf-cwlogs-report`,
            description: 'Builds a daily WAF activity report from CloudWatch Logs Insights and publishes it to SNS',
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.lambda_handler',
            code: lambda.Code.fromAsset(path.join(PYTHON_LAMBDA_DIR, 'cwlogs-report')),
            memorySize: functionMemorySize,
            timeout: functionTimeout,
            environment: {
                LOG_GROUP_NAME: targetLogGroupName,
                TOPIC_ARN: this.topic.topicArn,
                REPORT_PERIOD_HOURS: String(reportPeriodHours),
                TOP_N: String(topN),
                ANOMALY_THRESHOLD_PERCENT: String(anomalyThresholdPercent),
                LOCALE: locale,
            },
            logGroup: new logs.LogGroup(this, 'CwLogsReportFunctionLogGroup', {
                retention: functionLogRetention,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
            loggingFormat: lambda.LoggingFormat.JSON,
            applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
        });

        // CloudWatch Logs Insights query actions do not support resource-level
        // scoping to individual log groups (they take a queryId, not a log
        // group ARN, once started); scope what we can via the log group ARN on
        // StartQuery and leave the rest as "*" as AWS documents.
        this.reportFunction.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['logs:StartQuery'],
                resources: [targetLogGroup.logGroupArn],
            }),
        );
        this.reportFunction.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['logs:GetQueryResults', 'logs:StopQuery'],
                resources: ['*'],
            }),
        );
        this.topic.grantPublish(this.reportFunction);

        // -----------------------------------------------------------------------
        // EventBridge Scheduler
        // -----------------------------------------------------------------------
        new scheduler.Schedule(this, 'CwLogsReportSchedule', {
            scheduleName: `${props.project}-${props.environment}-waf-cwlogs-report`,
            description: 'Triggers the daily WAF CloudWatch Logs Insights report',
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
        new cdk.CfnOutput(this, 'TargetLogGroupName', {
            value: targetLogGroupName,
            description: 'WAF CloudWatch Logs log group analyzed by the report',
        });
    }
}
