import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface FisStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly multiAzInstance: rds.DatabaseInstance;
    readonly multiAzClusterArn: string;
    readonly instanceAlarm: cw.Alarm;
    readonly clusterAlarm: cw.Alarm;
}

/**
 * FIS Chaos Experiment Stack — Architecture I (RDS Multi-AZ instance vs. Multi-AZ DB cluster)
 *
 *   I-1  Multi-AZ DB instance: forced failover (aws:rds:reboot-db-instances, forceFailover=true)
 *        Primary is rebooted and the standby in the other AZ is promoted; the instance
 *        endpoint's DNS record flips. Measures the client-visible downtime of the
 *        "1 primary + 1 unreadable standby" topology.
 *
 *   I-2  Multi-AZ DB cluster: failover (aws:rds:failover-db-cluster)
 *        A readable standby is promoted to writer. Measures the client-visible downtime of the
 *        "1 writer + 2 readable standbys" topology, to compare against I-1.
 *
 *   I-3  Multi-AZ DB instance: reboot WITHOUT failover (forceFailover=false)
 *        A plain reboot of the primary — the standby is not used, so this is the full-outage
 *        control group that shows what the failover in I-1 saves you.
 *
 * Each template is guarded by a CloudWatch Alarm stop condition built on the probe Lambda's
 * ProbeFailure metric for the endpoint under test.
 */
export class FisStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: FisStackProps) {
        super(scope, id, props);

        const fisLogGroup = new logs.LogGroup(this, 'FisLogGroup', {
            logGroupName: `/fis/${props.project}-${props.environment}`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const fisRole = new iam.Role(this, 'FisRole', {
            roleName: `${props.project}-${props.environment}-fis-role`,
            assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
            inlinePolicies: {
                FisChaosPolicy: new iam.PolicyDocument({
                    statements: [
                        // I-1 / I-3: reboot (with or without failover) the Multi-AZ instance
                        new iam.PolicyStatement({
                            actions: ['rds:RebootDBInstance', 'rds:DescribeDBInstances'],
                            resources: [props.multiAzInstance.instanceArn],
                        }),
                        // I-2: Multi-AZ DB cluster failover
                        new iam.PolicyStatement({
                            actions: ['rds:FailoverDBCluster', 'rds:DescribeDBClusters'],
                            resources: [props.multiAzClusterArn],
                        }),
                        new iam.PolicyStatement({
                            actions: ['tag:GetResources'],
                            resources: ['*'],
                        }),
                        new iam.PolicyStatement({
                            actions: ['cloudwatch:DescribeAlarms'],
                            resources: [props.instanceAlarm.alarmArn, props.clusterAlarm.alarmArn],
                        }),
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

        const instanceStop = [
            { source: 'aws:cloudwatch:alarm', value: props.instanceAlarm.alarmArn },
        ];
        const clusterStop = [
            { source: 'aws:cloudwatch:alarm', value: props.clusterAlarm.alarmArn },
        ];

        const instanceTarget = {
            MultiAzInstance: {
                resourceType: 'aws:rds:db',
                resourceArns: [props.multiAzInstance.instanceArn],
                selectionMode: 'ALL',
            },
        };

        new fis.CfnExperimentTemplate(this, 'ScenarioI1InstanceFailover', {
            description:
                '[I-1] Multi-AZ DB instance forced failover: reboots the primary with forceFailover=true. ' +
                'Measures client-visible downtime of the 1-primary + 1-standby topology.',
            roleArn: fisRole.roleArn,
            stopConditions: instanceStop,
            targets: instanceTarget,
            actions: {
                RebootWithFailover: {
                    actionId: 'aws:rds:reboot-db-instances',
                    parameters: { forceFailover: 'true' },
                    targets: { DBInstances: 'MultiAzInstance' },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-I1-instance-failover`,
                Scenario: 'I-1',
                Architecture: 'RDS-MultiAZ-Instance-vs-Cluster',
            },
        });

        new fis.CfnExperimentTemplate(this, 'ScenarioI2ClusterFailover', {
            description:
                '[I-2] Multi-AZ DB cluster failover: promotes a readable standby to writer. ' +
                'Measures client-visible downtime of the 1-writer + 2-readable-standby topology.',
            roleArn: fisRole.roleArn,
            stopConditions: clusterStop,
            targets: {
                MultiAzCluster: {
                    resourceType: 'aws:rds:cluster',
                    resourceArns: [props.multiAzClusterArn],
                    selectionMode: 'ALL',
                },
            },
            actions: {
                FailoverCluster: {
                    actionId: 'aws:rds:failover-db-cluster',
                    targets: { Clusters: 'MultiAzCluster' },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-I2-cluster-failover`,
                Scenario: 'I-2',
                Architecture: 'RDS-MultiAZ-Instance-vs-Cluster',
            },
        });

        new fis.CfnExperimentTemplate(this, 'ScenarioI3InstanceRebootNoFailover', {
            description:
                '[I-3] Multi-AZ DB instance reboot WITHOUT failover: control group that shows the ' +
                'outage a plain reboot causes when the standby is not used.',
            roleArn: fisRole.roleArn,
            stopConditions: instanceStop,
            targets: instanceTarget,
            actions: {
                RebootNoFailover: {
                    actionId: 'aws:rds:reboot-db-instances',
                    parameters: { forceFailover: 'false' },
                    targets: { DBInstances: 'MultiAzInstance' },
                },
            },
            logConfiguration: fisLogConfig,
            tags: {
                Name: `${props.project}-${props.environment}-I3-instance-reboot`,
                Scenario: 'I-3',
                Architecture: 'RDS-MultiAZ-Instance-vs-Cluster',
            },
        });

        new cdk.CfnOutput(this, 'FisRoleArn', {
            value: fisRole.roleArn,
            description: 'FIS IAM role ARN',
        });
        new cdk.CfnOutput(this, 'FisLogGroupName', {
            value: fisLogGroup.logGroupName,
            description: 'CloudWatch log group for FIS experiment results',
        });
    }
}
