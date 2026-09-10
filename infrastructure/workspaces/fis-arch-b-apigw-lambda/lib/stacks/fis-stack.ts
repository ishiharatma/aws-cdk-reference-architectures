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
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { FIS_CONFIG_PREFIX } from 'lib/stacks/app-stack';

export interface FisStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly apiFunction: lambda.Function;
    /** Shared bucket that distributes the active Lambda fault configuration. */
    readonly fisConfigBucket: s3.IBucket;
    readonly alarmEmail?: string;
}

/**
 * FIS Chaos Experiment Stack — Architecture B
 *
 * Four fault injection scenarios for the
 * CloudFront → API Gateway HTTP API → Lambda → DynamoDB architecture.
 *
 * All four use the `aws:lambda:function` FIS actions, which inject faults into
 * function invocations through the AWS FIS Lambda extension (attached as a layer
 * in AppStack). The function code is never modified. FIS publishes the active
 * fault configuration to `fisConfigBucket`; the extension polls it (expect a
 * ramp-up of up to ~60 s before every invocation is affected).
 *
 *   B-1  Invocation Error — hard outage (5 min)
 *        `aws:lambda:invocation-error` with preventExecution=true, 100%.
 *        Every invocation returns an error WITHOUT running the handler.
 *        API Gateway surfaces 500; validates CloudFront error handling and
 *        client retry behaviour during a total function outage.
 *
 *   B-2  Invocation Latency — +10 s added delay (5 min)
 *        `aws:lambda:invocation-add-delay` with startupDelayMilliseconds=10000, 100%.
 *        Pushes end-to-end latency past normal SLOs while staying under the
 *        29 s function / 30 s API Gateway timeout. Validates timeout budgets,
 *        client-side deadlines, and latency alarms.
 *
 *   B-3  Partial Invocation Error — 50% error rate, handler still runs (5 min)
 *        `aws:lambda:invocation-error` with preventExecution=false, 50%.
 *        Half of invocations fail AFTER executing (side effects may occur).
 *        Validates idempotency, partial-failure handling and retry amplification.
 *
 *   B-4  Overridden HTTP Integration Response — forced 500 body (5 min)
 *        `aws:lambda:invocation-http-integration-response` returns a synthetic
 *        500 / application-json response to API Gateway without running the
 *        handler. Validates API Gateway → CloudFront error-page behaviour for a
 *        well-formed-but-failing upstream response.
 *
 * Every template carries a CloudWatch Alarm stop condition that halts the
 * experiment automatically if the Lambda error count exceeds the safety
 * threshold.
 */
export class FisStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: FisStackProps) {
        super(scope, id, props);

        const fnArn = props.apiFunction.functionArn;
        const configArnPrefix = `arn:aws:s3:::${props.fisConfigBucket.bucketName}/${FIS_CONFIG_PREFIX}`;

        // --- SNS topic for alarm notifications ---

        const alarmTopic = new sns.Topic(this, 'FisAlarmTopic', {
            topicName: `${props.project}-${props.environment}-fis-b-alarms`,
        });
        if (props.alarmEmail) {
            alarmTopic.addSubscription(new snsSubscriptions.EmailSubscription(props.alarmEmail));
        }

        // --- CloudWatch Log Group for FIS experiment logs ---

        const fisLogGroup = new logs.LogGroup(this, 'FisLogGroup', {
            logGroupName: `/fis/${props.project}-${props.environment}-b`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // --- Stop condition: Lambda error count alarm ---
        // Fires if Lambda returns >= 100 errors in a single 1-minute window.
        // The B scenarios deliberately drive errors, so the threshold is set well
        // above the expected experiment load; it exists to catch a runaway blast
        // radius, not the injected faults themselves.

        const lambdaErrorAlarm = new cw.Alarm(this, 'LambdaErrorAlarm', {
            alarmName: `${props.project}-${props.environment}-fis-b-stop-lambda-errors`,
            alarmDescription: 'FIS stop condition — Lambda error count exceeds safety threshold',
            metric: props.apiFunction.metricErrors({
                period: cdk.Duration.minutes(1),
                statistic: 'Sum',
            }),
            threshold: 100,
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        lambdaErrorAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

        // --- FIS IAM Role ---
        // FIS assumes this role when running experiments. The aws:lambda:function
        // actions need to (a) write the fault config into the shared S3 prefix,
        // (b) inspect the target function, and (c) resolve targets by tag.

        const fisRole = new iam.Role(this, 'FisRole', {
            roleName: `${props.project}-${props.environment}-fis-b-role`,
            assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
            inlinePolicies: {
                FisChaosPolicyB: new iam.PolicyDocument({
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
                        // CloudWatch stop condition
                        new iam.PolicyStatement({
                            actions: ['cloudwatch:DescribeAlarms'],
                            resources: [lambdaErrorAlarm.alarmArn],
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
                    value: lambdaErrorAlarm.alarmArn,
                },
            ];

        // Every scenario targets the same single function ARN.
        const functionTarget: Record<
            string,
            fis.CfnExperimentTemplate.ExperimentTemplateTargetProperty
        > = {
            ApiFunction: {
                resourceType: 'aws:lambda:function',
                resourceArns: [fnArn],
                selectionMode: 'ALL',
            },
        };

        // --- Scenario B-1: Invocation Error — hard outage ---

        new fis.CfnExperimentTemplate(this, 'ScenarioB1InvocationError', {
            description:
                '[B-1] Lambda Invocation Error — hard outage (5 min): every invocation returns ' +
                'an error without executing the handler. Validates API 500 propagation, ' +
                'CloudFront error handling, and client retry behaviour.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: functionTarget,
            actions: {
                InjectInvocationError: {
                    actionId: 'aws:lambda:invocation-error',
                    parameters: {
                        duration: 'PT5M',
                        invocationPercentage: '100',
                        preventExecution: 'true',
                    },
                    targets: {
                        Functions: 'ApiFunction',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-B1-invocation-error`,
                Scenario: 'B-1',
                Architecture: 'CloudFront-APIGW-Lambda-DynamoDB',
            },
        });

        // --- Scenario B-2: Invocation Latency — +10 s added delay ---

        new fis.CfnExperimentTemplate(this, 'ScenarioB2InvocationDelay', {
            description:
                '[B-2] Lambda Invocation Latency (+10 s, 5 min): a fixed 10 s delay is added ' +
                'to the start of every invocation, staying under the 29 s function / 30 s API ' +
                'Gateway timeout. Validates timeout budgets, client deadlines, and latency alarms.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: functionTarget,
            actions: {
                InjectInvocationDelay: {
                    actionId: 'aws:lambda:invocation-add-delay',
                    parameters: {
                        duration: 'PT5M',
                        invocationPercentage: '100',
                        startupDelayMilliseconds: '10000',
                    },
                    targets: {
                        Functions: 'ApiFunction',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-B2-invocation-delay`,
                Scenario: 'B-2',
                Architecture: 'CloudFront-APIGW-Lambda-DynamoDB',
            },
        });

        // --- Scenario B-3: Partial Invocation Error — 50%, handler still runs ---

        new fis.CfnExperimentTemplate(this, 'ScenarioB3PartialInvocationError', {
            description:
                '[B-3] Partial Lambda Invocation Error (50%, 5 min): half of invocations fail ' +
                'AFTER executing the handler, so side effects may already have occurred. ' +
                'Validates idempotency, partial-failure handling, and retry amplification.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: functionTarget,
            actions: {
                InjectPartialInvocationError: {
                    actionId: 'aws:lambda:invocation-error',
                    parameters: {
                        duration: 'PT5M',
                        invocationPercentage: '50',
                        preventExecution: 'false',
                    },
                    targets: {
                        Functions: 'ApiFunction',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-B3-partial-invocation-error`,
                Scenario: 'B-3',
                Architecture: 'CloudFront-APIGW-Lambda-DynamoDB',
            },
        });

        // --- Scenario B-4: Overridden HTTP Integration Response — forced 500 ---

        new fis.CfnExperimentTemplate(this, 'ScenarioB4HttpIntegrationResponse', {
            description:
                '[B-4] Overridden HTTP Integration Response (5 min): API Gateway receives a ' +
                'synthetic 500 application/json response without the handler running. ' +
                'Validates API Gateway → CloudFront error-page behaviour for a well-formed ' +
                'but failing upstream response.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: functionTarget,
            actions: {
                InjectHttpIntegrationResponse: {
                    actionId: 'aws:lambda:invocation-http-integration-response',
                    parameters: {
                        duration: 'PT5M',
                        invocationPercentage: '100',
                        preventExecution: 'true',
                        statusCode: '500',
                        contentTypeHeader: 'application/json',
                    },
                    targets: {
                        Functions: 'ApiFunction',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-B4-http-integration-response`,
                Scenario: 'B-4',
                Architecture: 'CloudFront-APIGW-Lambda-DynamoDB',
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
        new cdk.CfnOutput(this, 'LambdaStopAlarmArn', {
            value: lambdaErrorAlarm.alarmArn,
            description: 'Lambda error stop-condition alarm ARN',
        });
    }
}
