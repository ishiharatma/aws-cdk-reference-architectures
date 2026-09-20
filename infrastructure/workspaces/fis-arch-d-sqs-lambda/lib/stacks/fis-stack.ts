import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { FIS_CONFIG_PREFIX } from 'lib/stacks/app-stack';

export interface FisStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly consumerFunction: lambda.Function;
    readonly queue: sqs.IQueue;
    /** Shared bucket that distributes the active Lambda fault configuration. */
    readonly fisConfigBucket: s3.IBucket;
    readonly alarmEmail?: string;
}

/**
 * FIS Chaos Experiment Stack — Architecture D
 *
 * Provisions 3 business-relevant fault injection scenarios for the
 * SQS main queue → Lambda consumer → DynamoDB event-driven architecture.
 *
 * Design constraint: as of this writing, `aws:fis:inject-api-internal-error`
 * and `aws:fis:inject-api-throttle-error` only support `service: 'ec2'` or
 * `service: 'kinesis'` — SQS and DynamoDB are NOT supported service values
 * for those actions.
 *
 * An earlier version of this workspace used
 * `aws:lambda:put-function-concurrent-executions` to model consumer outage
 * by zeroing reserved concurrency. **That action ID does not exist** —
 * `aws fis list-actions` confirms Lambda-targeted actions are limited to
 * `aws:lambda:invocation-error`, `aws:lambda:invocation-add-delay`, and
 * `aws:lambda:invocation-http-integration-response` (the same family
 * Architecture B uses). CloudFormation failed the FIS template creation
 * outright with `Invalid actionId ... 404`.
 *
 * The scenarios below are redesigned on the `aws:lambda:function` action
 * family, injected through the AWS FIS Lambda extension (attached as a
 * layer in AppStack). The extension polls a shared S3 prefix
 * (`fisConfigBucket`) for the active fault config — the function code is
 * never modified.
 *
 *   D-1  Consumer Total Outage — short (5 min)
 *        `aws:lambda:invocation-error`, preventExecution=true, 100%, PT5M.
 *        Every invocation fails WITHOUT the handler running — functionally
 *        equivalent to "the consumer cannot process anything" from the
 *        queue's point of view. Because 5 min (300s) exceeds one
 *        visibility-timeout cycle (60s) but the queue keeps redelivering,
 *        this validates recovery: does the backlog drain cleanly once the
 *        fault clears, and do messages redeliver correctly within their
 *        visibility timeout?
 *
 *   D-2  Consumer Total Outage — long, DLQ-inducing (20 min)
 *        `aws:lambda:invocation-error`, preventExecution=true, 100%, PT20M.
 *        20 minutes (1200s) is far longer than visibilityTimeout (60s) x
 *        maxReceiveCount (3) = 180s, so every message stuck in the queue
 *        during the outage is guaranteed to exhaust its receive count and
 *        move to the DLQ. Validates DLQ routing, DLQ alarming/visibility,
 *        and the operational recovery process for replaying DLQ messages.
 *
 *   D-3  Consumer Throughput Collapse (10 min)
 *        `aws:lambda:invocation-add-delay`, startupDelayMilliseconds=20000,
 *        100%, PT10M. The consumer is not stopped — every invocation still
 *        runs and commits its writes — but a fixed 20 s startup delay is
 *        added, leaving only 10 s of the function's 30 s timeout for actual
 *        batch processing (comfortably enough for a handful of DynamoDB
 *        PutItem calls). Validates queue backlog growth and end-to-end
 *        latency under severe (but non-zero) throughput degradation — a
 *        more realistic "partial capacity loss" scenario than a hard
 *        outage.
 *
 * The extension polls rather than pushes, so faults take up to ~60 s to
 * ramp fully into effect after `start-experiment` — the same behaviour
 * documented for Architecture B.
 *
 * Each template shares one CloudWatch Alarm stop condition: it fires if the
 * SQS main queue's ApproximateNumberOfMessagesVisible exceeds 1000,
 * protecting against unbounded backlog growth during the experiment.
 */
export class FisStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: FisStackProps) {
        super(scope, id, props);

        const configArnPrefix = `arn:aws:s3:::${props.fisConfigBucket.bucketName}/${FIS_CONFIG_PREFIX}`;

        // --- SNS topic for alarm notifications ---

        const alarmTopic = new sns.Topic(this, 'FisAlarmTopic', {
            topicName: `${props.project}-${props.environment}-fis-d-alarms`,
        });
        if (props.alarmEmail) {
            alarmTopic.addSubscription(new snsSubscriptions.EmailSubscription(props.alarmEmail));
        }

        // --- CloudWatch Log Group for FIS experiment logs ---

        const fisLogGroup = new logs.LogGroup(this, 'FisLogGroup', {
            logGroupName: `/fis/${props.project}-${props.environment}-d`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // --- Stop condition: SQS backlog depth alarm ---
        // Fires if the main queue's visible message count exceeds 1000.
        // All 3 experiment templates share this stop condition — it protects
        // against an unbounded backlog if an experiment runs longer than intended.

        const queueBacklogAlarm = new cw.Alarm(this, 'QueueBacklogAlarm', {
            alarmName: `${props.project}-${props.environment}-fis-d-stop-queue-backlog`,
            alarmDescription:
                'FIS stop condition — SQS main queue visible message backlog exceeds safety threshold',
            metric: props.queue.metricApproximateNumberOfMessagesVisible({
                period: cdk.Duration.minutes(1),
                statistic: 'Maximum',
            }),
            threshold: 1000,
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        queueBacklogAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

        // --- FIS IAM Role ---
        // FIS assumes this role when running experiments. The aws:lambda:function
        // actions need to (a) write the fault config into the shared S3 prefix,
        // (b) inspect the target function, and (c) resolve targets by tag.

        const fisRole = new iam.Role(this, 'FisRole', {
            roleName: `${props.project}-${props.environment}-fis-d-role`,
            assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
            inlinePolicies: {
                FisChaosPolicyD: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            sid: 'WriteLambdaFaultConfig',
                            actions: ['s3:PutObject', 's3:DeleteObject'],
                            resources: [`${configArnPrefix}/*`],
                        }),
                        new iam.PolicyStatement({
                            sid: 'InspectTargetFunction',
                            actions: ['lambda:GetFunction'],
                            resources: ['*'],
                        }),
                        new iam.PolicyStatement({
                            sid: 'ResolveTargetsByTag',
                            actions: ['tag:GetResources'],
                            resources: ['*'],
                        }),
                        // CloudWatch stop conditions
                        new iam.PolicyStatement({
                            actions: ['cloudwatch:DescribeAlarms'],
                            resources: [queueBacklogAlarm.alarmArn],
                        }),
                        // FIS experiment logging to CloudWatch
                        new iam.PolicyStatement({
                            actions: [
                                'logs:CreateLogDelivery',
                                'logs:PutLogEvents',
                                'logs:GetLogDelivery',
                                'logs:UpdateLogDelivery',
                                'logs:DeleteLogDelivery',
                                'logs:ListLogDeliveries',
                                'logs:PutResourcePolicy',
                                'logs:DescribeResourcePolicies',
                                'logs:DescribeLogGroups',
                            ],
                            resources: ['*'],
                        }),
                    ],
                }),
            },
        });

        // cloudWatchLogsConfiguration is typed as `any` in the CDK L1 construct, so CDK does
        // not apply camelCase→PascalCase serialization. LogGroupArn must be PascalCase here.
        const fisLogConfig: fis.CfnExperimentTemplate.ExperimentTemplateLogConfigurationProperty = {
            cloudWatchLogsConfiguration: {
                LogGroupArn: fisLogGroup.logGroupArn,
            },
            logSchemaVersion: 2,
        };

        const stopConditions: fis.CfnExperimentTemplate.ExperimentTemplateStopConditionProperty[] =
            [
                {
                    source: 'aws:cloudwatch:alarm',
                    value: queueBacklogAlarm.alarmArn,
                },
            ];

        const consumerTarget: Record<
            string,
            fis.CfnExperimentTemplate.ExperimentTemplateTargetProperty
        > = {
            ConsumerFunction: {
                resourceType: 'aws:lambda:function',
                resourceArns: [props.consumerFunction.functionArn],
                selectionMode: 'ALL',
            },
        };

        // --- Scenario D-1: Consumer Total Outage — short (5 min) ---
        // Every invocation fails without the handler running. Messages already in
        // flight redeliver once their visibility timeout (60s) elapses and simply
        // queue up. Validates clean recovery and backlog drain once the fault
        // clears, and confirms redelivery within the visibility timeout window
        // rather than message loss.

        new fis.CfnExperimentTemplate(this, 'ScenarioD1ConsumerOutageShort', {
            description:
                '[D-1] Consumer Total Outage — short (5 min): every invocation of the SQS ' +
                'consumer Lambda fails without the handler running. Validates message ' +
                'redelivery within the visibility timeout and clean recovery once the fault clears.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: consumerTarget,
            actions: {
                InjectConsumerOutage: {
                    actionId: 'aws:lambda:invocation-error',
                    parameters: {
                        duration: 'PT5M',
                        invocationPercentage: '100',
                        preventExecution: 'true',
                    },
                    targets: {
                        Functions: 'ConsumerFunction',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-D1-consumer-outage-short`,
                Scenario: 'D-1',
                Architecture: 'SQS-Lambda-DynamoDB',
            },
        });

        // --- Scenario D-2: Consumer Total Outage — long, DLQ-inducing (20 min) ---
        // Same fault as D-1, held for 20 minutes — far longer than
        // visibilityTimeout (60s) x maxReceiveCount (3) = 180s, so every message
        // that arrives during the outage is guaranteed to exhaust its receive count
        // and move to the DLQ. Validates DLQ routing, DLQ depth alarming, and the
        // operational process for inspecting/replaying dead-lettered messages.

        new fis.CfnExperimentTemplate(this, 'ScenarioD2ConsumerOutageLong', {
            description:
                '[D-2] Consumer Total Outage — long, DLQ-inducing (20 min): every invocation ' +
                'of the SQS consumer Lambda fails without the handler running, for 20 minutes, ' +
                'well beyond visibilityTimeout(60s) x maxReceiveCount(3) = 180s. ' +
                'Deliberately drives messages to the DLQ to validate DLQ routing and replay procedures.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: consumerTarget,
            actions: {
                InjectConsumerOutage: {
                    actionId: 'aws:lambda:invocation-error',
                    parameters: {
                        duration: 'PT20M',
                        invocationPercentage: '100',
                        preventExecution: 'true',
                    },
                    targets: {
                        Functions: 'ConsumerFunction',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-D2-consumer-outage-long-dlq`,
                Scenario: 'D-2',
                Architecture: 'SQS-Lambda-DynamoDB',
            },
        });

        // --- Scenario D-3: Consumer Throughput Collapse (10 min) ---
        // The consumer is not stopped — every invocation still runs and commits its
        // writes — but a fixed 20 s startup delay is injected, leaving only 10 s of
        // the function's 30 s timeout for actual batch processing. Validates queue
        // backlog growth and end-to-end latency under severe (but non-zero)
        // throughput degradation, a more realistic "partial capacity loss" scenario
        // (e.g. a bad deploy, downstream slowness) than a hard outage.

        new fis.CfnExperimentTemplate(this, 'ScenarioD3ConsumerThroughputCollapse', {
            description:
                '[D-3] Consumer Throughput Collapse (10 min): a fixed 20 s startup delay is ' +
                'added to every invocation of the SQS consumer Lambda, leaving only 10 s of its ' +
                '30 s timeout for actual processing. Validates queue backlog growth and latency ' +
                'under severe, non-zero throughput degradation.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: consumerTarget,
            actions: {
                InjectConsumerDelay: {
                    actionId: 'aws:lambda:invocation-add-delay',
                    parameters: {
                        duration: 'PT10M',
                        invocationPercentage: '100',
                        startupDelayMilliseconds: '20000',
                    },
                    targets: {
                        Functions: 'ConsumerFunction',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-D3-consumer-throughput-collapse`,
                Scenario: 'D-3',
                Architecture: 'SQS-Lambda-DynamoDB',
            },
        });

        // --- Outputs ---

        new cdk.CfnOutput(this, 'FisRoleArn', {
            value: fisRole.roleArn,
            description: 'FIS IAM role ARN',
        });
        new cdk.CfnOutput(this, 'FisLogGroupName', {
            value: fisLogGroup.logGroupName,
            description: 'CloudWatch log group for FIS experiment results',
        });
        new cdk.CfnOutput(this, 'QueueBacklogStopAlarmArn', {
            value: queueBacklogAlarm.alarmArn,
            description: 'SQS backlog stop-condition alarm ARN',
        });
    }
}
