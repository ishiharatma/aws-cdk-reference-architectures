import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface FisStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly apiFunction: lambda.Function;
    readonly table: dynamodb.ITable;
    readonly alarmEmail?: string;
}

/**
 * FIS Chaos Experiment Stack — Architecture B
 *
 * Provisions 4 business-relevant fault injection scenarios for the
 * CloudFront → API Gateway HTTP API → Lambda → DynamoDB architecture.
 *
 * Scenarios B-1 through B-3 target the Lambda execution role.
 * `aws:fis:inject-api-*` actions intercept AWS API calls made BY a role,
 * so targeting the Lambda execution role causes Lambda's outbound DynamoDB
 * calls to receive injected errors — the Lambda function code is unchanged.
 *
 *   B-1  DynamoDB Internal Error (all operations, 5 min)
 *        Every DynamoDB call (GetItem/PutItem/DeleteItem/Scan) returns InternalError.
 *        Validates Lambda error handling, retry/backoff logic, and API 500 propagation.
 *
 *   B-2  DynamoDB Write Throttle (write operations only, 5 min)
 *        PutItem and DeleteItem return ProvisionedThroughputExceededException.
 *        Reads (GetItem/Scan) remain healthy. Validates write-path circuit-breaker
 *        patterns and whether the application serves stale reads gracefully.
 *
 *   B-3  DynamoDB Read Throttle (read operations only, 5 min)
 *        GetItem and Scan return ProvisionedThroughputExceededException.
 *        Writes remain healthy. Validates read-path fallback (cached responses,
 *        read-only degradation) and 429 propagation to the client.
 *
 *   B-4  Lambda Concurrency Exhaustion (reserved concurrency = 0, 5 min)
 *        Sets the function's reserved concurrency to 0, causing all new invocations
 *        to receive TooManyRequestsException immediately. API Gateway maps this to
 *        502 and CloudFront should serve a custom error page.
 *
 * Each template includes a CloudWatch Alarm stop condition that automatically
 * halts the experiment if the Lambda error count exceeds the safety threshold.
 */
export class FisStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: FisStackProps) {
        super(scope, id, props);

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
        // Fires if Lambda returns >= 10 errors in a single 1-minute window.
        // All 4 experiment templates share this stop condition.

        const lambdaErrorAlarm = new cw.Alarm(this, 'LambdaErrorAlarm', {
            alarmName: `${props.project}-${props.environment}-fis-b-stop-lambda-errors`,
            alarmDescription: 'FIS stop condition — Lambda error count exceeds safety threshold',
            metric: props.apiFunction.metricErrors({
                period: cdk.Duration.minutes(1),
                statistic: 'Sum',
            }),
            threshold: 10,
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        lambdaErrorAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

        // --- FIS IAM Role ---
        // FIS assumes this role when running experiments.

        const lambdaExecRoleArn = props.apiFunction.role!.roleArn;

        const fisRole = new iam.Role(this, 'FisRole', {
            roleName: `${props.project}-${props.environment}-fis-b-role`,
            assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
            inlinePolicies: {
                FisChaosPolicyB: new iam.PolicyDocument({
                    statements: [
                        // DynamoDB API error injection (B-1, B-2, B-3)
                        // FIS injects errors into calls made BY the target role.
                        new iam.PolicyStatement({
                            actions: [
                                'fis:InjectApiInternalError',
                                'fis:InjectApiThrottleError',
                            ],
                            resources: [lambdaExecRoleArn],
                        }),
                        // Lambda concurrency manipulation (B-4)
                        new iam.PolicyStatement({
                            actions: [
                                'lambda:PutFunctionConcurrency',
                                'lambda:DeleteFunctionConcurrency',
                            ],
                            resources: [props.apiFunction.functionArn],
                        }),
                        // CloudWatch stop conditions
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

        // --- Scenario B-1: DynamoDB Internal Error (all operations) ---
        // Every DynamoDB API call made by the Lambda execution role returns InternalError
        // for 5 minutes. Tests Lambda retry/backoff logic and API 500 propagation.

        new fis.CfnExperimentTemplate(this, 'ScenarioB1DynamoInternalError', {
            description:
                '[B-1] DynamoDB Internal Error — all operations (5 min): ' +
                'InternalError injected into every Lambda→DynamoDB call. ' +
                'Validates retry/backoff implementation and clean API 500 propagation.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                LambdaExecRole: {
                    resourceType: 'aws:iam:role',
                    resourceArns: [lambdaExecRoleArn],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                InjectDynamoInternalError: {
                    actionId: 'aws:fis:inject-api-internal-error',
                    parameters: {
                        service: 'dynamodb',
                        operations: 'GetItem,PutItem,DeleteItem,Scan',
                        percentage: '100',
                        duration: 'PT5M',
                    },
                    targets: {
                        Roles: 'LambdaExecRole',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-B1-dynamo-internal-error`,
                Scenario: 'B-1',
                Architecture: 'CloudFront-APIGW-Lambda-DynamoDB',
            },
        });

        // --- Scenario B-2: DynamoDB Write Throttle ---
        // PutItem and DeleteItem return ProvisionedThroughputExceededException for 5 minutes.
        // Read operations (GetItem / Scan) remain healthy. Tests write-path circuit-breaker
        // patterns and whether the application serves stale reads gracefully while writes fail.

        new fis.CfnExperimentTemplate(this, 'ScenarioB2DynamoWriteThrottle', {
            description:
                '[B-2] DynamoDB Write Throttle (5 min): ' +
                'ProvisionedThroughputExceededException injected into PutItem and DeleteItem. ' +
                'Reads remain healthy. Validates write-path circuit-breaker and graceful degradation.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                LambdaExecRole: {
                    resourceType: 'aws:iam:role',
                    resourceArns: [lambdaExecRoleArn],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                InjectDynamoWriteThrottle: {
                    actionId: 'aws:fis:inject-api-throttle-error',
                    parameters: {
                        service: 'dynamodb',
                        operations: 'PutItem,DeleteItem',
                        percentage: '100',
                        duration: 'PT5M',
                    },
                    targets: {
                        Roles: 'LambdaExecRole',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-B2-dynamo-write-throttle`,
                Scenario: 'B-2',
                Architecture: 'CloudFront-APIGW-Lambda-DynamoDB',
            },
        });

        // --- Scenario B-3: DynamoDB Read Throttle ---
        // GetItem and Scan return ProvisionedThroughputExceededException for 5 minutes.
        // Write operations (PutItem / DeleteItem) remain healthy. Tests whether the
        // application falls back to a cached response or read-only degraded mode,
        // and whether 429 is correctly surfaced to the client.

        new fis.CfnExperimentTemplate(this, 'ScenarioB3DynamoReadThrottle', {
            description:
                '[B-3] DynamoDB Read Throttle (5 min): ' +
                'ProvisionedThroughputExceededException injected into GetItem and Scan. ' +
                'Writes remain healthy. Validates read-path fallback and 429 propagation.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                LambdaExecRole: {
                    resourceType: 'aws:iam:role',
                    resourceArns: [lambdaExecRoleArn],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                InjectDynamoReadThrottle: {
                    actionId: 'aws:fis:inject-api-throttle-error',
                    parameters: {
                        service: 'dynamodb',
                        operations: 'GetItem,Scan',
                        percentage: '100',
                        duration: 'PT5M',
                    },
                    targets: {
                        Roles: 'LambdaExecRole',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-B3-dynamo-read-throttle`,
                Scenario: 'B-3',
                Architecture: 'CloudFront-APIGW-Lambda-DynamoDB',
            },
        });

        // --- Scenario B-4: Lambda Concurrency Exhaustion ---
        // Sets the function's reserved concurrency to 0 for 5 minutes. All new Lambda
        // invocations immediately receive TooManyRequestsException without executing.
        // API Gateway maps this to 429 (or 502 depending on integration config).
        // Tests whether API Gateway surfaces a clear error and whether CloudFront
        // activates a custom error page under sustained 4xx/5xx traffic.

        new fis.CfnExperimentTemplate(this, 'ScenarioB4LambdaConcurrencyZero', {
            description:
                '[B-4] Lambda Concurrency Exhaustion (5 min): ' +
                'Sets reserved concurrency to 0 — all invocations receive TooManyRequestsException. ' +
                'Validates API Gateway error mapping and CloudFront error-page fallback.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                ApiFunction: {
                    resourceType: 'aws:lambda:function',
                    resourceArns: [props.apiFunction.functionArn],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                SetConcurrencyZero: {
                    actionId: 'aws:lambda:put-function-concurrent-executions',
                    parameters: {
                        ConcurrentExecutions: '0',
                        duration: 'PT5M',
                    },
                    targets: {
                        Functions: 'ApiFunction',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-B4-lambda-concurrency-zero`,
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
