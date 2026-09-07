import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface FisStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly ecsCluster: ecs.ICluster;
    readonly ecsService: ecs.FargateService;
    readonly alb: elbv2.ApplicationLoadBalancer;
    readonly auroraCluster: rds.DatabaseCluster;
    readonly alarmEmail?: string;
}

/**
 * FIS Chaos Experiment Stack
 *
 * Provisions 4 business-relevant fault injection scenarios for the
 * CloudFront → Internal ALB → ECS Fargate → Aurora PostgreSQL architecture:
 *
 *   A-1  Aurora DB Failover
 *        Trigger a real writer→reader promotion. Verifies connection pool
 *        recovery, retry logic, and the application's RDS reconnect behaviour.
 *
 *   A-2  ECS All-Tasks Stop
 *        Terminates every running ECS task simultaneously. Verifies ALB 503
 *        handling, CloudFront error-page fallback, and ECS service recovery
 *        speed (new tasks should be healthy within the deployment-timeout window).
 *
 *   A-3  ECS → DB Network Blackhole (egress port 5432)
 *        Blocks TCP port 5432 egress from ECS tasks without stopping them.
 *        Verifies query-timeout settings, circuit-breaker patterns, and graceful
 *        degradation when the database is network-unreachable.
 *
 *   A-4  ALB → ECS Network Blackhole (ingress port 80)
 *        Blocks TCP port 80 ingress to ECS tasks. ALB health checks will fail
 *        and the load balancer will deregister all targets. Verifies ALB
 *        unhealthy-host detection speed and CloudFront fallback activation.
 *
 * Each template includes a CloudWatch Alarm stop condition that automatically
 * halts the experiment if the ALB 5xx error rate exceeds the safety threshold.
 */
export class FisStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: FisStackProps) {
        super(scope, id, props);

        // --- SNS topic for alarm notifications ---

        const alarmTopic = new sns.Topic(this, 'FisAlarmTopic', {
            topicName: `${props.project}-${props.environment}-fis-alarms`,
        });
        if (props.alarmEmail) {
            alarmTopic.addSubscription(new snsSubscriptions.EmailSubscription(props.alarmEmail));
        }

        // --- CloudWatch Log Group for FIS experiment logs ---

        const fisLogGroup = new logs.LogGroup(this, 'FisLogGroup', {
            logGroupName: `/fis/${props.project}-${props.environment}`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // --- Stop condition: ALB 5xx error count alarm ---
        // Fires if the experiment causes more than 50 target errors in 1 minute.
        // All 4 experiment templates share this stop condition.

        const albTargetErrorAlarm = new cw.Alarm(this, 'AlbTargetErrorAlarm', {
            alarmName: `${props.project}-${props.environment}-fis-stop-alb-5xx`,
            alarmDescription: 'FIS stop condition — ALB target 5xx errors exceed safety threshold',
            metric: props.alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
                period: cdk.Duration.minutes(1),
                statistic: 'Sum',
            }),
            threshold: 50,
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        albTargetErrorAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

        // RDS failover-specific stop condition: writer instance unavailable for > 3 minutes
        const auroraConnectionAlarm = new cw.Alarm(this, 'AuroraConnectionAlarm', {
            alarmName: `${props.project}-${props.environment}-fis-stop-aurora-connections`,
            alarmDescription: 'FIS stop condition — Aurora DB connections drop to zero (unexpected total loss)',
            metric: new cw.Metric({
                namespace: 'AWS/RDS',
                metricName: 'DatabaseConnections',
                dimensionsMap: {
                    DBClusterIdentifier: props.auroraCluster.clusterIdentifier,
                },
                period: cdk.Duration.minutes(3),
                statistic: 'Sum',
            }),
            threshold: 0,
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        auroraConnectionAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

        // --- FIS IAM Role ---
        // FIS assumes this role when running experiments.

        const fisRole = new iam.Role(this, 'FisRole', {
            roleName: `${props.project}-${props.environment}-fis-role`,
            assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
            inlinePolicies: {
                FisChaosPolicy: new iam.PolicyDocument({
                    statements: [
                        // Aurora failover
                        new iam.PolicyStatement({
                            actions: [
                                'rds:FailoverDBCluster',
                                'rds:DescribeDBClusters',
                            ],
                            resources: [props.auroraCluster.clusterArn],
                        }),
                        // ECS task stop
                        new iam.PolicyStatement({
                            actions: [
                                'ecs:StopTask',
                                'ecs:DescribeTasks',
                                'ecs:ListTasks',
                            ],
                            resources: ['*'],
                            conditions: {
                                ArnLike: {
                                    'ecs:cluster': props.ecsCluster.clusterArn,
                                },
                            },
                        }),
                        // ECS network blackhole (requires SSM for sidecar agent)
                        new iam.PolicyStatement({
                            actions: [
                                'ecs:DescribeTasks',
                                'ecs:ListTasks',
                                'ec2:DescribeNetworkInterfaces',
                                'ssm:CancelCommand',
                                'ssm:GetCommandInvocation',
                                'ssm:ListCommandInvocations',
                                'ssm:SendCommand',
                            ],
                            resources: ['*'],
                        }),
                        // CloudWatch stop conditions
                        new iam.PolicyStatement({
                            actions: ['cloudwatch:DescribeAlarms'],
                            resources: [
                                albTargetErrorAlarm.alarmArn,
                                auroraConnectionAlarm.alarmArn,
                            ],
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

        const stopConditions: fis.CfnExperimentTemplate.ExperimentTemplateStopConditionProperty[] = [
            {
                source: 'aws:cloudwatch:alarm',
                value: albTargetErrorAlarm.alarmArn,
            },
        ];

        // --- Scenario A-1: Aurora DB Failover ---
        // Promotes a reader to writer. Tests connection-pool reconnect, retry logic,
        // and whether the application handles a ~30 second connection interruption.

        new fis.CfnExperimentTemplate(this, 'ScenarioA1AuroraFailover', {
            description:
                '[A-1] Aurora DB Failover: Triggers a writer→reader failover. ' +
                'Validates connection pool retry logic and application resilience during ~30s interruption.',
            roleArn: fisRole.roleArn,
            stopConditions: [
                {
                    source: 'aws:cloudwatch:alarm',
                    value: auroraConnectionAlarm.alarmArn,
                },
            ],
            targets: {
                AuroraCluster: {
                    resourceType: 'aws:rds:cluster',
                    resourceArns: [props.auroraCluster.clusterArn],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                FailoverAurora: {
                    actionId: 'aws:rds:failover-db-cluster',
                    targets: {
                        Clusters: 'AuroraCluster',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-A1-aurora-failover`,
                Scenario: 'A-1',
                Architecture: 'CloudFront-ALB-ECS-Aurora',
            },
        });

        // --- Scenario A-2: ECS All-Tasks Stop ---
        // Stops all running tasks in the cluster. ALB returns 503 until replacement
        // tasks are scheduled and pass health checks. Tests CloudFront fallback to
        // the S3 error page and ECS service recovery time.

        new fis.CfnExperimentTemplate(this, 'ScenarioA2EcsTaskStop', {
            description:
                '[A-2] ECS All-Tasks Stop: Terminates every running task. ' +
                'Validates ALB 503 detection, CloudFront S3 fallback, and ECS recovery time.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                AppTasks: {
                    resourceType: 'aws:ecs:task',
                    resourceTags: {
                        'fis-target': 'app-service',
                    },
                    filters: [
                        {
                            path: 'cluster.clusterArn',
                            values: [props.ecsCluster.clusterArn],
                        },
                    ],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                StopAllTasks: {
                    actionId: 'aws:ecs:stop-task',
                    targets: {
                        Tasks: 'AppTasks',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-A2-ecs-task-stop`,
                Scenario: 'A-2',
                Architecture: 'CloudFront-ALB-ECS-Aurora',
            },
        });

        // --- Scenario A-3: ECS → DB Network Blackhole (egress port 5432) ---
        // Blocks TCP 5432 egress from ECS tasks for 5 minutes. The application
        // cannot reach Aurora. Tests query-timeout configuration, circuit-breaker
        // activation, and graceful degradation (e.g., cached responses or read-only mode).

        new fis.CfnExperimentTemplate(this, 'ScenarioA3EcsDbBlackhole', {
            description:
                '[A-3] ECS→DB Network Blackhole (egress TCP 5432, 5 min): Blocks ECS tasks from reaching Aurora. ' +
                'Validates query-timeout settings, circuit-breaker patterns, and graceful degradation.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                AppTasks: {
                    resourceType: 'aws:ecs:task',
                    resourceTags: {
                        'fis-target': 'app-service',
                    },
                    filters: [
                        {
                            path: 'cluster.clusterArn',
                            values: [props.ecsCluster.clusterArn],
                        },
                    ],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                BlackholeDbPort: {
                    actionId: 'aws:ecs:network-blackhole-port',
                    parameters: {
                        port: '5432',
                        protocol: 'tcp',
                        trafficType: 'egress',
                        duration: 'PT5M',
                    },
                    targets: {
                        Tasks: 'AppTasks',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-A3-ecs-db-blackhole`,
                Scenario: 'A-3',
                Architecture: 'CloudFront-ALB-ECS-Aurora',
            },
        });

        // --- Scenario A-4: ALB → ECS Network Blackhole (ingress port 80) ---
        // Blocks TCP 80 ingress to ECS tasks for 5 minutes. ALB health checks fail
        // and all targets are deregistered, causing 503s. Tests ALB unhealthy-host
        // detection speed and CloudFront fallback to the S3 maintenance page.

        new fis.CfnExperimentTemplate(this, 'ScenarioA4AlbEcsBlackhole', {
            description:
                '[A-4] ALB→ECS Network Blackhole (ingress TCP 80, 5 min): Blocks HTTP ingress to ECS tasks. ' +
                'Validates ALB health-check detection speed and CloudFront S3 fallback activation timing.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                AppTasks: {
                    resourceType: 'aws:ecs:task',
                    resourceTags: {
                        'fis-target': 'app-service',
                    },
                    filters: [
                        {
                            path: 'cluster.clusterArn',
                            values: [props.ecsCluster.clusterArn],
                        },
                    ],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                BlackholeHttpIngress: {
                    actionId: 'aws:ecs:network-blackhole-port',
                    parameters: {
                        port: '80',
                        protocol: 'tcp',
                        trafficType: 'ingress',
                        duration: 'PT5M',
                    },
                    targets: {
                        Tasks: 'AppTasks',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-A4-alb-ecs-blackhole`,
                Scenario: 'A-4',
                Architecture: 'CloudFront-ALB-ECS-Aurora',
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
        new cdk.CfnOutput(this, 'AlbStopAlarmArn', {
            value: albTargetErrorAlarm.alarmArn,
            description: 'ALB 5xx stop-condition alarm ARN',
        });
    }
}
