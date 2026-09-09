import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface FisStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly targetGroup: elbv2.NetworkTargetGroup;
    readonly auroraCluster: rds.DatabaseCluster;
    /**
     * Private-with-egress subnet ARNs, one per AZ, ordered so index 0 is AZ-1.
     * G-1 and G-2 target `azSubnetArns[0]` with aws:network:disrupt-connectivity.
     */
    readonly azSubnetArns: string[];
    readonly alarmEmail?: string;
}

/**
 * FIS Chaos Experiment Stack — Architecture G
 *
 * Four business-relevant fault injection scenarios for the internet-facing
 * NLB → EC2 Auto Scaling Group (2 AZs) → Aurora PostgreSQL Multi-AZ
 * architecture. G-1 and G-2 are built on `aws:network:disrupt-connectivity`,
 * the only FIS-native action that simulates an Availability Zone network
 * failure — no other workspace in this repository uses it.
 *
 *   G-1  AZ-1 Cross-AZ Traffic Disruption (5 min)
 *        aws:network:disrupt-connectivity, scope=availability-zone, on the
 *        AZ-1 private subnet only. Blocks AZ-1 → AZ-2 VPC-internal traffic
 *        (and AZ-1 → Aurora reader if the reader is in AZ-2) while leaving
 *        AZ-1's own NLB-to-instance and internet paths intact. Verifies
 *        that the app has no undeclared cross-AZ dependency and that NLB
 *        cross-zone load balancing does not route AZ-2 clients through a
 *        now-unreachable AZ-1 target.
 *
 *   G-2  AZ-1 Total Isolation (5 min)
 *        aws:network:disrupt-connectivity, scope=all, on the AZ-1 private
 *        subnet only. Cuts ALL traffic to/from AZ-1's private subnet,
 *        including the NLB health check path. Verifies NLB unhealthy-target
 *        detection speed and automatic failover of 100% of traffic to AZ-2.
 *
 *   G-3  Aurora Multi-AZ Failover
 *        aws:rds:failover-db-cluster — promotes the reader to writer.
 *        Verifies DB-layer writer/reader promotion behind the network layer.
 *
 *   G-4  AZ-scoped EC2 Instance Termination (50%)
 *        aws:ec2:terminate-instances, selectionMode=PERCENT(50), on
 *        fis-target:app-instance. With the ASG evenly split across 2 AZs,
 *        a 50% selection approximates "terminate one AZ's instances".
 *        Verifies ASG self-healing and NLB target deregistration/
 *        re-registration speed.
 *
 * All templates share a CloudWatch Alarm stop condition on the NLB target
 * group's UnHealthyHostCount (NLB has no per-target HTTP status-code
 * metrics the way an ALB does).
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

        // --- Stop condition: NLB target group UnHealthyHostCount ---
        // Fires if 2 or more targets are unhealthy for 1 evaluation period.
        // NLB does not expose HTTP status-code metrics (unlike ALB), so
        // unhealthy-host count is the safety signal shared by all 4 templates.

        const unhealthyHostAlarm = new cw.Alarm(this, 'NlbUnhealthyHostAlarm', {
            alarmName: `${props.project}-${props.environment}-fis-stop-unhealthy-hosts`,
            alarmDescription:
                'FIS stop condition — NLB target group unhealthy host count exceeds safety threshold',
            metric: props.targetGroup.metrics.unHealthyHostCount({
                period: cdk.Duration.minutes(1),
                statistic: 'Maximum',
            }),
            threshold: 2,
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        unhealthyHostAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

        const stopConditions: fis.CfnExperimentTemplate.ExperimentTemplateStopConditionProperty[] =
            [
                {
                    source: 'aws:cloudwatch:alarm',
                    value: unhealthyHostAlarm.alarmArn,
                },
            ];

        // --- FIS IAM Role ---

        const az1SubnetArn = props.azSubnetArns[0];

        const fisRole = new iam.Role(this, 'FisRole', {
            roleName: `${props.project}-${props.environment}-fis-role`,
            assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
            inlinePolicies: {
                FisChaosPolicy: new iam.PolicyDocument({
                    statements: [
                        // G-4: terminate EC2 instances tagged fis-target:app-instance
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
                        // G-1/G-2: aws:network:disrupt-connectivity. The action
                        // implements the disruption by swapping in a temporary
                        // Network ACL on the target subnet, then restoring the
                        // original association when the experiment ends. These
                        // NACL resources are created dynamically by the action
                        // itself, so their ARNs cannot be known ahead of time —
                        // hence the wildcard resource (suppressed as IAM5 below).
                        new iam.PolicyStatement({
                            actions: [
                                'ec2:DescribeSubnets',
                                'ec2:DescribeNetworkAcls',
                                'ec2:CreateNetworkAcl',
                                'ec2:CreateNetworkAclEntry',
                                'ec2:DeleteNetworkAcl',
                                'ec2:DeleteNetworkAclEntry',
                                'ec2:ReplaceNetworkAclAssociation',
                                'ec2:CreateTags',
                                'ec2:DescribeTags',
                            ],
                            resources: ['*'],
                        }),
                        // G-3: Aurora failover
                        new iam.PolicyStatement({
                            actions: ['rds:FailoverDBCluster', 'rds:DescribeDBClusters'],
                            resources: [props.auroraCluster.clusterArn],
                        }),
                        // CloudWatch stop conditions
                        new iam.PolicyStatement({
                            actions: ['cloudwatch:DescribeAlarms'],
                            resources: [unhealthyHostAlarm.alarmArn],
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

        // --- Scenario G-1: AZ-1 Cross-AZ Traffic Disruption (5 min) ---
        // scope=availability-zone blocks only AZ-1 → other-AZ VPC-internal
        // traffic (e.g. AZ-1 instance → AZ-2 Aurora reader / AZ-2 instance).
        // AZ-1's own NLB health-check and internet paths remain intact, so
        // this isolates cross-AZ dependency failures from AZ-local ones.

        new fis.CfnExperimentTemplate(this, 'ScenarioG1CrossAzDisruption', {
            description:
                '[G-1] AZ-1 Cross-AZ Traffic Disruption (5 min): Blocks AZ-1→other-AZ VPC-internal ' +
                'traffic only. Validates absence of undeclared cross-AZ dependencies and NLB cross-zone routing.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                Az1Subnet: {
                    resourceType: 'aws:ec2:subnet',
                    resourceArns: [az1SubnetArn],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                DisruptCrossAzTraffic: {
                    actionId: 'aws:network:disrupt-connectivity',
                    parameters: {
                        scope: 'availability-zone',
                        duration: 'PT5M',
                    },
                    targets: {
                        Subnets: 'Az1Subnet',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-G1-az-cross-traffic-disruption`,
                Scenario: 'G-1',
                Architecture: 'NLB-EC2ASG-Aurora-MultiAZ',
            },
        });

        // --- Scenario G-2: AZ-1 Total Isolation (5 min) ---
        // scope=all blocks ALL traffic to/from the AZ-1 private subnet,
        // including the NLB's health-check path to AZ-1 instances. Simulates
        // a full AZ network failure and measures NLB failover-to-AZ-2 speed.

        new fis.CfnExperimentTemplate(this, 'ScenarioG2AzTotalIsolation', {
            description:
                '[G-2] AZ-1 Total Isolation (5 min): Blocks ALL traffic to/from the AZ-1 subnet. ' +
                'Validates NLB unhealthy-target detection speed and automatic failover to AZ-2.',
            roleArn: fisRole.roleArn,
            stopConditions,
            targets: {
                Az1Subnet: {
                    resourceType: 'aws:ec2:subnet',
                    resourceArns: [az1SubnetArn],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                DisruptAllTraffic: {
                    actionId: 'aws:network:disrupt-connectivity',
                    parameters: {
                        scope: 'all',
                        duration: 'PT5M',
                    },
                    targets: {
                        Subnets: 'Az1Subnet',
                    },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-G2-az-total-isolation`,
                Scenario: 'G-2',
                Architecture: 'NLB-EC2ASG-Aurora-MultiAZ',
            },
        });

        // --- Scenario G-3: Aurora Multi-AZ Failover ---
        // Promotes the reader to writer (~30 s interruption). Verifies the
        // DB layer's own failover behaviour independent of the network-layer
        // disruptions in G-1/G-2.

        new fis.CfnExperimentTemplate(this, 'ScenarioG3AuroraFailover', {
            description:
                '[G-3] Aurora Multi-AZ Failover: Triggers a writer→reader promotion. ' +
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
                Name: `${props.project}-${props.environment}-G3-aurora-failover`,
                Scenario: 'G-3',
                Architecture: 'NLB-EC2ASG-Aurora-MultiAZ',
            },
        });

        // --- Scenario G-4: AZ-scoped EC2 Instance Termination (50%) ---
        // The ASG is split evenly across 2 AZs, so a 50% tag-based selection
        // approximates "terminate every instance in one AZ" without requiring
        // AZ-level tag filtering (FIS resourceTags targeting has no AZ
        // condition). Verifies ASG self-healing and NLB target
        // deregistration/re-registration speed.

        new fis.CfnExperimentTemplate(this, 'ScenarioG4TerminateInstances', {
            description:
                '[G-4] AZ-scoped EC2 Instance Termination (~50%, tag-based): Terminates half of the ' +
                'ASG instances, approximating one AZ. Validates ASG self-healing and NLB target churn.',
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
                Name: `${props.project}-${props.environment}-G4-ec2-terminate`,
                Scenario: 'G-4',
                Architecture: 'NLB-EC2ASG-Aurora-MultiAZ',
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
        new cdk.CfnOutput(this, 'UnhealthyHostStopAlarmArn', {
            value: unhealthyHostAlarm.alarmArn,
            description: 'NLB target group unhealthy-host stop-condition alarm ARN',
        });
    }
}
