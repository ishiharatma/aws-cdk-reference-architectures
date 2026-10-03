import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as path from 'path';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface ProbeStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly vpc: ec2.IVpc;
    readonly dbSecurityGroup: ec2.SecurityGroup;
    readonly dbSecret: rds.DatabaseSecret;
    readonly instanceEndpoint: string;
    readonly clusterEndpoint: string;
    readonly alarmEmail?: string;
}

/**
 * Failover probe: a VPC Lambda that opens a fresh PostgreSQL connection to both the Multi-AZ
 * instance endpoint and the Multi-AZ cluster writer endpoint once per second, publishes a
 * ProbeFailure EMF metric per target, and reports every outage window it saw.
 *
 * Start it (async-safe, up to 15 min) just before `aws fis start-experiment`, then read the
 * returned outage windows — that is the measured client-visible downtime of each topology.
 */
export class ProbeStack extends cdk.Stack {
    public readonly instanceAlarm: cw.Alarm;
    public readonly clusterAlarm: cw.Alarm;
    public readonly probeFunction: lambdaNodejs.NodejsFunction;

    constructor(scope: Construct, id: string, props: ProbeStackProps) {
        super(scope, id, props);

        const probeSg = new ec2.SecurityGroup(this, 'ProbeSecurityGroup', {
            vpc: props.vpc,
            securityGroupName: `${props.project}-${props.environment}-probe-sg`,
            description: 'Failover probe Lambda',
            allowAllOutbound: true,
        });
        // Defined as an L1 rule owned by THIS stack: addIngressRule() on the imported DB SG would
        // place the rule in BaseStack and create a BaseStack <-> ProbeStack dependency cycle.
        new ec2.CfnSecurityGroupIngress(this, 'DbIngressFromProbe', {
            groupId: props.dbSecurityGroup.securityGroupId,
            sourceSecurityGroupId: probeSg.securityGroupId,
            ipProtocol: 'tcp',
            fromPort: 5432,
            toPort: 5432,
            description: 'PostgreSQL from the probe Lambda',
        });

        this.probeFunction = new lambdaNodejs.NodejsFunction(this, 'ProbeFunction', {
            functionName: `${props.project}-${props.environment}-db-probe`,
            entry: path.join(__dirname, '../../src/probe/index.ts'),
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_24_X,
            architecture: lambda.Architecture.ARM_64,
            memorySize: 256,
            timeout: cdk.Duration.minutes(15),
            vpc: props.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroups: [probeSg],
            logGroup: new logs.LogGroup(this, 'ProbeLogGroup', {
                logGroupName: `/aws/lambda/${props.project}-${props.environment}-db-probe`,
                retention: logs.RetentionDays.ONE_WEEK,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
            environment: {
                SECRET_ARN: props.dbSecret.secretArn,
                INSTANCE_ENDPOINT: props.instanceEndpoint,
                CLUSTER_ENDPOINT: props.clusterEndpoint,
            },
            bundling: {
                target: 'node24',
                // The Node.js managed runtime ships the AWS SDK v3.
                externalModules: ['@aws-sdk/*'],
            },
        });
        props.dbSecret.grantRead(this.probeFunction);

        // Stop conditions: the probe must see failures in most of its ticks for 5 consecutive
        // minutes (a failover that has not recovered by then is not a normal failover).
        // Missing data (probe not running) is NOT_BREACHING so the alarm never blocks a start.
        const makeAlarm = (target: 'instance' | 'cluster'): cw.Alarm =>
            new cw.Alarm(this, `${target === 'instance' ? 'Instance' : 'Cluster'}ProbeAlarm`, {
                alarmName: `${props.project}-${props.environment}-fis-stop-${target}-probe`,
                alarmDescription: `FIS stop condition — ${target} endpoint failed to recover from the injected failover`,
                metric: new cw.Metric({
                    namespace: 'FisRdsProbe',
                    metricName: 'ProbeFailure',
                    dimensionsMap: { Target: target },
                    statistic: 'Sum',
                    period: cdk.Duration.minutes(1),
                }),
                threshold: 15,
                evaluationPeriods: 5,
                datapointsToAlarm: 5,
                comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                treatMissingData: cw.TreatMissingData.NOT_BREACHING,
            });
        this.instanceAlarm = makeAlarm('instance');
        this.clusterAlarm = makeAlarm('cluster');

        // Notifications live in this stack (next to the alarms) so FisStack only depends on alarm ARNs.
        const alarmTopic = new sns.Topic(this, 'FisAlarmTopic', {
            topicName: `${props.project}-${props.environment}-fis-alarms`,
        });
        if (props.alarmEmail) {
            alarmTopic.addSubscription(new snsSubscriptions.EmailSubscription(props.alarmEmail));
        }
        this.instanceAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
        this.clusterAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

        new cdk.CfnOutput(this, 'ProbeFunctionName', {
            value: this.probeFunction.functionName,
            description: 'Failover probe Lambda — invoke with {"durationSeconds":420}',
        });
    }
}
