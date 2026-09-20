import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { FIS_CONFIG_PREFIX } from 'lib/stacks/app-stack';

export interface FisStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly reserveInventoryFn: lambda.Function;
    readonly processPaymentFn: lambda.Function;
    readonly confirmOrderFn: lambda.Function;
    readonly stateMachine: sfn.StateMachine;
    /** Shared bucket that distributes the active Lambda fault configuration. */
    readonly fisConfigBucket: s3.IBucket;
    readonly alarmEmail?: string;
}

/**
 * FIS Chaos Experiment Stack — Architecture F
 *
 * AWS FIS has no action that targets AWS Step Functions directly (there is
 * no `aws:states:*` action in the FIS action catalogue). To exercise the
 * Saga's Retry/Catch/compensation behavior under a real fault, this stack
 * instead targets the three FORWARD-path Lambda functions with
 * `aws:lambda:invocation-error`, injected through the AWS FIS Lambda
 * extension (attached as a layer to those 3 functions in AppStack).
 * `preventExecution=true` at 100% makes every invocation of the targeted
 * function fail immediately — functionally identical, from the state
 * machine's point of view, to that Lambda being completely down, and the
 * function code itself is never modified.
 *
 * An earlier version of this workspace used
 * `aws:lambda:put-function-concurrent-executions` to reach the same effect
 * by zeroing reserved concurrency for the fault duration. **That action ID
 * does not exist** — `aws fis list-actions` confirms Lambda-targeted FIS
 * actions are limited to the `aws:lambda:function` family. CloudFormation
 * failed FIS template creation outright with `Invalid actionId ... 404`.
 * The scenarios and their validation intent are unchanged by this fix; only
 * the fault-injection mechanism is different.
 *
 *   F-1  ProcessPayment Lambda outage (5 min)
 *        Forward step 2 becomes fully uninvokable. Validates that Retry
 *        exhausts, Catch fires, and the ReleaseInventory compensation runs
 *        before the execution ends in a Fail state.
 *
 *   F-2  ReserveInventory Lambda outage (5 min)
 *        Forward step 1 (the very first step) becomes fully uninvokable.
 *        Validates the "fail fast, no compensation needed" path, since no
 *        resource was ever reserved.
 *
 *   F-3  ConfirmOrder Lambda outage (5 min)
 *        Forward step 3 (final step) becomes fully uninvokable after
 *        payment has already been processed. Validates the two-stage
 *        compensation — RefundPayment then ReleaseInventory — runs in the
 *        correct order before the execution ends in a Fail state.
 *
 * The extension polls rather than pushes, so faults take up to ~60 s to
 * ramp fully into effect after `start-experiment` — the same behaviour
 * documented for Architecture B.
 *
 * All three templates share one CloudWatch Alarm stop condition based on
 * the state machine's ExecutionsFailed metric, which halts the experiment
 * automatically if failed Saga executions exceed the safety threshold.
 */
export class FisStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: FisStackProps) {
        super(scope, id, props);

        const configArnPrefix = `arn:aws:s3:::${props.fisConfigBucket.bucketName}/${FIS_CONFIG_PREFIX}`;

        // --- SNS topic for alarm notifications ---

        const alarmTopic = new sns.Topic(this, 'FisAlarmTopic', {
            topicName: `${props.project}-${props.environment}-fis-f-alarms`,
        });
        if (props.alarmEmail) {
            alarmTopic.addSubscription(new snsSubscriptions.EmailSubscription(props.alarmEmail));
        }

        // --- CloudWatch Log Group for FIS experiment logs ---

        const fisLogGroup = new logs.LogGroup(this, 'FisLogGroup', {
            logGroupName: `/fis/${props.project}-${props.environment}-f`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // --- Stop condition: Saga executions-failed alarm ---
        // Fires if the state machine records >= 5 failed executions in a single
        // 1-minute window. All 3 experiment templates share this stop condition.

        const sagaFailedAlarm = new cw.Alarm(this, 'SagaExecutionsFailedAlarm', {
            alarmName: `${props.project}-${props.environment}-fis-f-stop-executions-failed`,
            alarmDescription:
                'FIS stop condition — Step Functions Saga ExecutionsFailed exceeds safety threshold',
            metric: props.stateMachine.metricFailed({
                period: cdk.Duration.minutes(1),
                statistic: 'Sum',
            }),
            threshold: 5,
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        sagaFailedAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

        // --- FIS IAM Role ---
        // FIS assumes this role when running experiments. The aws:lambda:function
        // actions need to (a) write the fault config into the shared S3 prefix,
        // (b) inspect the target function, and (c) resolve targets by tag.

        const fisRole = new iam.Role(this, 'FisRole', {
            roleName: `${props.project}-${props.environment}-fis-f-role`,
            assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
            inlinePolicies: {
                FisChaosPolicyF: new iam.PolicyDocument({
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
                            resources: [sagaFailedAlarm.alarmArn],
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
                    value: sagaFailedAlarm.alarmArn,
                },
            ];

        // --- Scenario F-1: ProcessPayment Lambda outage ---
        // Every invocation of ProcessPayment (Saga forward step 2) fails
        // immediately, without the handler running. Once the task's Retry
        // policy (2 attempts, 2s/4s backoff) is exhausted, Catch routes to the
        // ReleaseInventory compensating transaction, then Fail.

        new fis.CfnExperimentTemplate(this, 'ScenarioF1ProcessPaymentOutage', {
            description:
                '[F-1] ProcessPayment Lambda outage (5 min): ' +
                'every invocation fails without the handler running. ' +
                'Validates Retry exhaustion and the ReleaseInventory compensating transaction.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                ProcessPaymentFunction: {
                    resourceType: 'aws:lambda:function',
                    resourceArns: [props.processPaymentFn.functionArn],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                InjectPaymentOutage: {
                    actionId: 'aws:lambda:invocation-error',
                    parameters: {
                        duration: 'PT5M',
                        invocationPercentage: '100',
                        preventExecution: 'true',
                    },
                    targets: {
                        Functions: 'ProcessPaymentFunction',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-F1-process-payment-outage`,
                Scenario: 'F-1',
                Architecture: 'StepFunctions-Lambda-Saga',
            },
        });

        // --- Scenario F-2: ReserveInventory Lambda outage ---
        // Every invocation of ReserveInventory (Saga forward step 1) fails
        // immediately. Because this is the very first step, no resource has
        // been reserved yet — once Retry is exhausted, Catch routes straight
        // to Fail with no compensating transaction required.

        new fis.CfnExperimentTemplate(this, 'ScenarioF2ReserveInventoryOutage', {
            description:
                '[F-2] ReserveInventory Lambda outage (5 min): ' +
                'every invocation fails without the handler running. ' +
                'Validates the fail-fast path (no compensation needed) when the Saga fails ' +
                'at its very first step.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                ReserveInventoryFunction: {
                    resourceType: 'aws:lambda:function',
                    resourceArns: [props.reserveInventoryFn.functionArn],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                InjectReserveOutage: {
                    actionId: 'aws:lambda:invocation-error',
                    parameters: {
                        duration: 'PT5M',
                        invocationPercentage: '100',
                        preventExecution: 'true',
                    },
                    targets: {
                        Functions: 'ReserveInventoryFunction',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-F2-reserve-inventory-outage`,
                Scenario: 'F-2',
                Architecture: 'StepFunctions-Lambda-Saga',
            },
        });

        // --- Scenario F-3: ConfirmOrder Lambda outage ---
        // Every invocation of ConfirmOrder (Saga forward step 3, final) fails
        // immediately — this happens *after* payment has already been
        // processed. Once Retry is exhausted, Catch must run the two-stage
        // compensation in the correct order: RefundPayment first, then
        // ReleaseInventory, before Fail.

        new fis.CfnExperimentTemplate(this, 'ScenarioF3ConfirmOrderOutage', {
            description:
                '[F-3] ConfirmOrder Lambda outage (5 min): ' +
                'every invocation fails without the handler running, after payment has already ' +
                'been processed. Validates the two-stage compensation ' +
                '(RefundPayment, then ReleaseInventory) runs in the correct order.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                ConfirmOrderFunction: {
                    resourceType: 'aws:lambda:function',
                    resourceArns: [props.confirmOrderFn.functionArn],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                InjectConfirmOutage: {
                    actionId: 'aws:lambda:invocation-error',
                    parameters: {
                        duration: 'PT5M',
                        invocationPercentage: '100',
                        preventExecution: 'true',
                    },
                    targets: {
                        Functions: 'ConfirmOrderFunction',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-F3-confirm-order-outage`,
                Scenario: 'F-3',
                Architecture: 'StepFunctions-Lambda-Saga',
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
        new cdk.CfnOutput(this, 'SagaFailedStopAlarmArn', {
            value: sagaFailedAlarm.alarmArn,
            description: 'Step Functions ExecutionsFailed stop-condition alarm ARN',
        });
    }
}
