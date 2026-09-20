import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface FisStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly targetGroup: elbv2.NetworkTargetGroup;
    /**
     * Private-with-egress subnet ARNs, one per AZ, ordered so index 0 is AZ-1.
     * H-1 targets `azSubnetArns[0]` with aws:network:disrupt-connectivity — the same
     * action and target Architecture G's G-2 scenario uses.
     */
    readonly azSubnetArns: string[];
    readonly alarmEmail?: string;
}

/**
 * FIS Chaos Experiment Stack — Architecture H
 *
 * One experiment template, reusing the exact fault Architecture G's G-2 scenario
 * uses (`aws:network:disrupt-connectivity`, `scope: all`, on the AZ-1 subnet) —
 * H is not a new fault, it is a test of whether a *response* changes the outcome
 * of an already-verified fault.
 *
 * G-2 established that Auto Scaling's default self-healing re-launches a
 * replacement instance into the very same AZ a network partition just isolated
 * it from: Auto Scaling's AZ-avoidance logic only engages on a launch *failure*
 * (no capacity, no free subnet IPs, ...), and a network partition doesn't cause
 * one — the instance boots fine, it's just unreachable afterward, which surfaces
 * as a target-group health-check failure the AZ-avoidance logic never sees.
 *
 * H's AppStack registers the ASG with ARC zonal shift
 * (`AvailabilityZoneImpairmentPolicy.ZonalShiftEnabled: true`). This experiment
 * template is meant to be run twice against the same fault, bracketed by a
 * manually-started zonal shift (`aws arc-zonal-shift start-zonal-shift`, see the
 * README):
 *
 *   H-1  AZ-1 Total Isolation (5 min) — WITHOUT an active zonal shift
 *        Reproduces G-2 exactly, as a control: the replacement instance lands
 *        back in AZ-1 and stays unreachable until the fault clears.
 *
 *   H-1  AZ-1 Total Isolation (5 min) — WITH an active zonal shift on AZ-1
 *        Same experiment template, same fault — the only variable is whether an
 *        operator declared AZ-1 impaired via ARC first. With
 *        `ImpairedZoneHealthCheckBehavior: ReplaceUnhealthy` (this workspace's
 *        default), Auto Scaling still replaces the unhealthy AZ-1 instance, but
 *        launches the replacement in AZ-2 instead — real capacity moves to the
 *        healthy AZ instead of being wasted on a doomed re-launch.
 *
 * The stop condition is the same NLB target-group UnHealthyHostCount alarm
 * Architecture G uses.
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
                        // H-1: aws:network:disrupt-connectivity. The action implements the
                        // disruption by swapping in a temporary Network ACL on the target
                        // subnet, then restoring the original association when the
                        // experiment ends. These NACL resources are created dynamically by
                        // the action itself, so their ARNs cannot be known ahead of time —
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

        // --- Scenario H-1: AZ-1 Total Isolation (5 min) ---
        // Identical fault to Architecture G's G-2: scope=all blocks ALL traffic
        // to/from the AZ-1 private subnet, including the NLB's health-check path.
        // Run this template once with no zonal shift active (reproduces G-2's
        // result as a control), and once with a zonal shift active on AZ-1
        // (started manually beforehand — see the README) to compare Auto
        // Scaling's replacement behavior.

        new fis.CfnExperimentTemplate(this, 'ScenarioH1AzTotalIsolation', {
            description:
                '[H-1] AZ-1 Total Isolation (5 min): Blocks ALL traffic to/from the AZ-1 subnet — ' +
                'the same fault as Architecture G G-2. Run with and without an active ARC zonal ' +
                'shift on AZ-1 to compare where Auto Scaling launches the replacement instance.',
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
                Name: `${props.project}-${props.environment}-H1-az-total-isolation`,
                Scenario: 'H-1',
                Architecture: 'NLB-EC2ASG-ZonalShift',
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
