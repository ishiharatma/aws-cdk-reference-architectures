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
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface FisStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly consumerFunction: lambda.Function;
    readonly queue: sqs.IQueue;
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
 * for those actions. The Lambda-extension-based `invocation-error` /
 * `invocation-add-delay` actions require an exact S3 layer/env-var setup
 * that could not be confirmed from primary sources, so they are avoided
 * here too. Every scenario below therefore uses the one FIS action proven
 * to work reliably against a Lambda target:
 * `aws:lambda:put-function-concurrent-executions`. Manipulating the
 * consumer's reserved concurrency is still a faithful way to chaos-test an
 * SQS+Lambda pipeline — it reproduces exactly the failure modes operators
 * care about (a stalled/degraded consumer), just via a supported control
 * point instead of an unsupported SQS-level fault injection.
 *
 *   D-1  Consumer Total Outage — short (reserved concurrency = 0, 5 min)
 *        The consumer cannot run at all for 5 minutes. Because 5 min (300s)
 *        exceeds one visibility-timeout cycle (60s) but the queue keeps
 *        redelivering, this validates recovery: does the backlog drain
 *        cleanly once concurrency is restored, and do messages redeliver
 *        correctly within their visibility timeout?
 *
 *   D-2  Consumer Total Outage — long, DLQ-inducing (reserved concurrency = 0, 20 min)
 *        20 minutes (1200s) is far longer than visibilityTimeout (60s) x
 *        maxReceiveCount (3) = 180s, so every message stuck in the queue
 *        during the outage is guaranteed to exhaust its receive count and
 *        move to the DLQ. Validates DLQ routing, DLQ alarming/visibility,
 *        and the operational recovery process for replaying DLQ messages.
 *
 *   D-3  Consumer Throughput Collapse (reserved concurrency = 1, 10 min)
 *        The consumer is not stopped, but throttled to a single concurrent
 *        execution. Validates queue backlog growth and latency behavior
 *        under severe (but non-zero) throughput degradation — a more
 *        realistic "partial capacity loss" scenario than a hard outage.
 *
 * Each template shares one CloudWatch Alarm stop condition: it fires if the
 * SQS main queue's ApproximateNumberOfMessagesVisible exceeds 1000,
 * protecting against unbounded backlog growth during the experiment.
 */
export class FisStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: FisStackProps) {
        super(scope, id, props);

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
        // FIS assumes this role when running experiments.

        const fisRole = new iam.Role(this, 'FisRole', {
            roleName: `${props.project}-${props.environment}-fis-d-role`,
            assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
            inlinePolicies: {
                FisChaosPolicyD: new iam.PolicyDocument({
                    statements: [
                        // Lambda concurrency manipulation (D-1, D-2, D-3)
                        new iam.PolicyStatement({
                            actions: [
                                'lambda:PutFunctionConcurrency',
                                'lambda:DeleteFunctionConcurrency',
                            ],
                            resources: [props.consumerFunction.functionArn],
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
        // Reserved concurrency set to 0 for 5 minutes. The consumer cannot execute at
        // all. Messages already in flight redeliver once their visibility timeout
        // (60s) elapses and simply queue up. Validates clean recovery and backlog
        // drain once concurrency is restored, and confirms redelivery within the
        // visibility timeout window rather than message loss.

        new fis.CfnExperimentTemplate(this, 'ScenarioD1ConsumerOutageShort', {
            description:
                '[D-1] Consumer Total Outage — short (5 min): ' +
                'Reserved concurrency set to 0 on the SQS consumer Lambda. ' +
                'Validates message redelivery within the visibility timeout and clean recovery once concurrency is restored.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: consumerTarget,
            actions: {
                SetConcurrencyZero: {
                    actionId: 'aws:lambda:put-function-concurrent-executions',
                    parameters: {
                        ConcurrentExecutions: '0',
                        duration: 'PT5M',
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
        // Reserved concurrency set to 0 for 20 minutes — far longer than
        // visibilityTimeout (60s) x maxReceiveCount (3) = 180s, so every message
        // that arrives during the outage is guaranteed to exhaust its receive count
        // and move to the DLQ. Validates DLQ routing, DLQ depth alarming, and the
        // operational process for inspecting/replaying dead-lettered messages.

        new fis.CfnExperimentTemplate(this, 'ScenarioD2ConsumerOutageLong', {
            description:
                '[D-2] Consumer Total Outage — long, DLQ-inducing (20 min): ' +
                'Reserved concurrency set to 0 on the SQS consumer Lambda for 20 minutes, ' +
                'well beyond visibilityTimeout(60s) x maxReceiveCount(3) = 180s. ' +
                'Deliberately drives messages to the DLQ to validate DLQ routing and replay procedures.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: consumerTarget,
            actions: {
                SetConcurrencyZero: {
                    actionId: 'aws:lambda:put-function-concurrent-executions',
                    parameters: {
                        ConcurrentExecutions: '0',
                        duration: 'PT20M',
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

        // --- Scenario D-3: Consumer Throughput Collapse (reserved concurrency = 1, 10 min) ---
        // The consumer is not stopped — only limited to a single concurrent execution
        // for 10 minutes. Validates queue backlog growth and end-to-end latency under
        // severe (but non-zero) throughput degradation, a more realistic "partial
        // capacity loss" scenario (e.g. a bad deploy, downstream slowness) than a
        // hard outage.

        new fis.CfnExperimentTemplate(this, 'ScenarioD3ConsumerThroughputCollapse', {
            description:
                '[D-3] Consumer Throughput Collapse (10 min): ' +
                'Reserved concurrency limited to 1 on the SQS consumer Lambda. ' +
                'Validates queue backlog growth and latency under severe, non-zero throughput degradation.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: consumerTarget,
            actions: {
                SetConcurrencyOne: {
                    actionId: 'aws:lambda:put-function-concurrent-executions',
                    parameters: {
                        ConcurrentExecutions: '1',
                        duration: 'PT10M',
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
