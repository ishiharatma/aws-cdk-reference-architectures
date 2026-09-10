import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface FisStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly asg: autoscaling.AutoScalingGroup;
    readonly alb: elbv2.ApplicationLoadBalancer;
    readonly auroraCluster: rds.DatabaseCluster;
    readonly alarmEmail?: string;
}

/**
 * FIS Chaos Experiment Stack — Architecture C
 *
 * Four business-relevant fault injection scenarios for the
 * CloudFront → Internal ALB → EC2 Auto Scaling Group → Aurora PostgreSQL architecture:
 *
 *   C-1  EC2 Instance Termination (50%)
 *        Terminates half of the ASG instances. Verifies ASG self-healing (instance
 *        replacement), ALB target draining, and CloudFront fallback activation timing.
 *
 *   C-2  EC2 CPU Stress (all instances, 5 min)
 *        Injects 100% CPU load via SSM AWSFIS-Run-CPU-Stress. Verifies whether the
 *        ASG scale-out policy triggers under sustained CPU pressure and how quickly
 *        new instances pass ALB health checks after scale-out completes.
 *
 *   C-3  Aurora DB Failover
 *        Promotes a reader to writer. Verifies EC2 application connection-pool retry
 *        logic and reconnect behaviour during the ~30 s failover window.
 *
 *   C-4  EC2 → DB Network Blackhole (TCP egress port 5432, 5 min)
 *        Blocks PostgreSQL egress from all EC2 instances via SSM AWSFIS-Run-Network-Blackhole-Port.
 *        Verifies query-timeout configuration, circuit-breaker activation, and ALB
 *        health-check response when the database is network-unreachable from the instance.
 *
 * All templates share a CloudWatch Alarm stop condition that halts the experiment
 * automatically if ALB 5xx errors exceed the safety threshold.
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

        // --- CloudWatch Log Group ---

        const fisLogGroup = new logs.LogGroup(this, 'FisLogGroup', {
            logGroupName: `/fis/${props.project}-${props.environment}`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // --- Stop condition: ALB 5xx error count ---
        // Fires if the experiment causes > 50 target errors in any 1-minute window.
        // All 4 templates share this stop condition.

        const albErrorAlarm = new cw.Alarm(this, 'AlbTargetErrorAlarm', {
            alarmName: `${props.project}-${props.environment}-fis-stop-alb-5xx`,
            alarmDescription: 'FIS stop condition — ALB 5xx target errors exceed safety threshold',
            metric: props.alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
                period: cdk.Duration.minutes(1),
                statistic: 'Sum',
            }),
            threshold: 50,
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        albErrorAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

        const stopConditions: fis.CfnExperimentTemplate.ExperimentTemplateStopConditionProperty[] =
            [
                {
                    source: 'aws:cloudwatch:alarm',
                    value: albErrorAlarm.alarmArn,
                },
            ];

        // --- FIS IAM Role ---

        const fisRole = new iam.Role(this, 'FisRole', {
            roleName: `${props.project}-${props.environment}-fis-role`,
            assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
            inlinePolicies: {
                FisChaosPolicy: new iam.PolicyDocument({
                    statements: [
                        // C-1: terminate EC2 instances tagged fis-target:app-instance
                        new iam.PolicyStatement({
                            actions: ['ec2:TerminateInstances'],
                            resources: [
                                `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:instance/*`,
                            ],
                            conditions: {
                                StringEquals: {
                                    'aws:ResourceTag/fis-target': 'app-instance',
                                },
                            },
                        }),
                        new iam.PolicyStatement({
                            actions: ['ec2:DescribeInstances'],
                            resources: ['*'],
                        }),
                        // C-2 and C-4: SSM command execution on tagged EC2 instances
                        // sendCommand resource requires both the instance and the document ARN
                        new iam.PolicyStatement({
                            actions: ['ssm:SendCommand'],
                            resources: [
                                `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:instance/*`,
                            ],
                            conditions: {
                                StringEquals: {
                                    'aws:ResourceTag/fis-target': 'app-instance',
                                },
                            },
                        }),
                        new iam.PolicyStatement({
                            actions: ['ssm:SendCommand'],
                            resources: [
                                // AWS managed FIS SSM documents (no account ID in ARN)
                                `arn:aws:ssm:${cdk.Aws.REGION}::document/AWSFIS-Run-CPU-Stress`,
                                `arn:aws:ssm:${cdk.Aws.REGION}::document/AWSFIS-Run-Network-Blackhole-Port`,
                            ],
                        }),
                        new iam.PolicyStatement({
                            actions: [
                                // aws:ssm:send-command polls status with ssm:ListCommands —
                                // without it the action fails mid-run with
                                // "Not enough privileges to perform the required action".
                                'ssm:ListCommands',
                                'ssm:CancelCommand',
                                'ssm:GetCommandInvocation',
                                'ssm:ListCommandInvocations',
                                'ssm:GetDocument',
                                'ssm:DescribeDocument',
                            ],
                            resources: ['*'],
                        }),
                        // C-3: Aurora failover
                        new iam.PolicyStatement({
                            actions: [
                                'rds:FailoverDBCluster',
                                'rds:DescribeDBClusters',
                            ],
                            resources: [props.auroraCluster.clusterArn],
                        }),
                        // Tag-based target resolution (C-1 / C-2 / C-4 select instances by tag)
                        new iam.PolicyStatement({
                            actions: ['tag:GetResources'],
                            resources: ['*'],
                        }),
                        // CloudWatch stop conditions
                        new iam.PolicyStatement({
                            actions: ['cloudwatch:DescribeAlarms'],
                            resources: [albErrorAlarm.alarmArn],
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

        // cloudWatchLogsConfiguration is typed as `any` in the CDK L1 construct —
        // CDK does not apply camelCase→PascalCase; LogGroupArn must be PascalCase here.
        const fisLogConfig: fis.CfnExperimentTemplate.ExperimentTemplateLogConfigurationProperty =
            {
                cloudWatchLogsConfiguration: {
                    LogGroupArn: fisLogGroup.logGroupArn,
                },
                logSchemaVersion: 2,
            };

        // --- Scenario C-1: EC2 Instance Termination (50%) ---
        // Terminates half of the tagged ASG instances. The ASG self-healing loop
        // launches replacements; ALB deregisters terminated instances and re-registers
        // new ones after they pass health checks. Tests recovery speed and CloudFront
        // fallback during the partial-capacity window.

        new fis.CfnExperimentTemplate(this, 'ScenarioC1TerminateInstances', {
            description:
                '[C-1] EC2 Instance Termination (50%): Terminates half of ASG instances. ' +
                'Validates ASG self-healing, ALB target draining, and CloudFront fallback timing.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                AppInstances: {
                    resourceType: 'aws:ec2:instance',
                    resourceTags: {
                        'fis-target': 'app-instance',
                    },
                    selectionMode: 'PERCENT(50)',
                },
            },
            actions: {
                TerminateInstances: {
                    actionId: 'aws:ec2:terminate-instances',
                    targets: {
                        Instances: 'AppInstances',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-C1-ec2-terminate`,
                Scenario: 'C-1',
                Architecture: 'CloudFront-ALB-EC2ASG-Aurora',
            },
        });

        // --- Scenario C-2: EC2 CPU Stress (all instances, 5 min) ---
        // Injects 100% CPU load on every instance via SSM AWSFIS-Run-CPU-Stress.
        // Tests whether the ASG scale-out policy (CPU > threshold) fires under sustained
        // pressure, and how quickly new instances pass ALB health checks after scale-out.

        new fis.CfnExperimentTemplate(this, 'ScenarioC2CpuStress', {
            description:
                '[C-2] EC2 CPU Stress (100%, 5 min): Injects sustained CPU load via SSM. ' +
                'Validates ASG scale-out policy activation and health-check speed on new instances.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                AppInstances: {
                    resourceType: 'aws:ec2:instance',
                    resourceTags: {
                        'fis-target': 'app-instance',
                    },
                    selectionMode: 'ALL',
                },
            },
            actions: {
                InjectCpuStress: {
                    actionId: 'aws:ssm:send-command',
                    parameters: {
                        documentArn: `arn:aws:ssm:${cdk.Aws.REGION}::document/AWSFIS-Run-CPU-Stress`,
                        // CPU:0 = stress all available vCPUs; duration matches the experiment window
                        documentParameters: JSON.stringify({
                            CPU: '0',
                            DurationSeconds: '300',
                            InstallDependencies: 'True',
                        }),
                        duration: 'PT5M',
                    },
                    targets: {
                        Instances: 'AppInstances',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-C2-cpu-stress`,
                Scenario: 'C-2',
                Architecture: 'CloudFront-ALB-EC2ASG-Aurora',
            },
        });

        // --- Scenario C-3: Aurora DB Failover ---
        // Promotes the reader to writer (~30 s interruption). Tests EC2 application
        // connection-pool reconnect behaviour, query-retry logic, and whether the
        // 5xx alarm fires and recovers within the expected SLO window.

        new fis.CfnExperimentTemplate(this, 'ScenarioC3AuroraFailover', {
            description:
                '[C-3] Aurora DB Failover: Triggers a writer→reader promotion. ' +
                'Validates EC2 app connection-pool retry and reconnect during ~30 s interruption.',
            roleArn: fisRole.roleArn,
            stopConditions,
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
                Name: `${props.project}-${props.environment}-C3-aurora-failover`,
                Scenario: 'C-3',
                Architecture: 'CloudFront-ALB-EC2ASG-Aurora',
            },
        });

        // --- Scenario C-4: EC2 → DB Network Blackhole (TCP egress port 5432, 5 min) ---
        // Blocks all outbound PostgreSQL traffic from EC2 instances via SSM
        // AWSFIS-Run-Network-Blackhole-Port. Aurora is unreachable from the instances.
        // Tests query-timeout settings, circuit-breaker activation, and ALB health-check
        // response when database connectivity is completely severed.

        new fis.CfnExperimentTemplate(this, 'ScenarioC4DbNetworkBlackhole', {
            description:
                '[C-4] EC2→DB Network Blackhole (TCP egress 5432, 5 min): Blocks PostgreSQL egress via SSM. ' +
                'Validates query-timeout config, circuit-breaker activation, and ALB health-check during DB loss.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                AppInstances: {
                    resourceType: 'aws:ec2:instance',
                    resourceTags: {
                        'fis-target': 'app-instance',
                    },
                    selectionMode: 'ALL',
                },
            },
            actions: {
                BlackholeDbPort: {
                    actionId: 'aws:ssm:send-command',
                    parameters: {
                        documentArn: `arn:aws:ssm:${cdk.Aws.REGION}::document/AWSFIS-Run-Network-Blackhole-Port`,
                        documentParameters: JSON.stringify({
                            Protocol: 'tcp',
                            TrafficType: 'egress',
                            Port: '5432',
                            DurationSeconds: '300',
                            InstallDependencies: 'True',
                        }),
                        duration: 'PT5M',
                    },
                    targets: {
                        Instances: 'AppInstances',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-C4-db-network-blackhole`,
                Scenario: 'C-4',
                Architecture: 'CloudFront-ALB-EC2ASG-Aurora',
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
            value: albErrorAlarm.alarmArn,
            description: 'ALB 5xx stop-condition alarm ARN',
        });
    }
}
