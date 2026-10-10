import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { VpcConstruct } from '@common/constructs/vpc/vpc';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface RdsMultiazVsReadReplicaStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * RDS Multi-AZ versus a read replica, side by side on the same database.
 *
 *   primary   Multi-AZ DB instance: a synchronous standby in a second AZ that nobody can read; fails over by itself
 *   replica   read replica of the primary: asynchronous, readable, not part of the failover, promotable by hand
 *
 * A probe Lambda in the VPC connects to both endpoints, which is how the differences are shown rather than asserted.
 */
export class RdsMultiazVsReadReplicaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RdsMultiazVsReadReplicaStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const namePrefix = `${project}-${environment}-rdscmp`;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.SNAPSHOT;

    const vpcConstruct = new VpcConstruct(this, 'Vpc', {
      project,
      environment,
      config: params.vpcConfig,
      prefix: [project, environment].join('/'),
    });
    const vpc = vpcConstruct.vpc;

    // ---------------------------------------------------------------------------------------------
    // Security groups: the databases accept PostgreSQL from the probe only
    // ---------------------------------------------------------------------------------------------
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Primary and replica: PostgreSQL from the probe only',
      allowAllOutbound: false,
    });
    const probeSecurityGroup = new ec2.SecurityGroup(this, 'ProbeSecurityGroup', {
      vpc,
      description: 'Probe Lambda: PostgreSQL to the databases and HTTPS to the Secrets Manager endpoint',
      allowAllOutbound: false,
    });
    probeSecurityGroup.addEgressRule(dbSecurityGroup, ec2.Port.tcp(5432), 'PostgreSQL to the databases');
    probeSecurityGroup.addEgressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443), 'Secrets Manager endpoint');
    dbSecurityGroup.addIngressRule(probeSecurityGroup, ec2.Port.tcp(5432), 'PostgreSQL from the probe');

    // ---------------------------------------------------------------------------------------------
    // The primary (Multi-AZ) and the read replica
    // ---------------------------------------------------------------------------------------------
    const secret = new rds.DatabaseSecret(this, 'DbSecret', { username: 'postgres', secretName: `${namePrefix}-secret` });
    const subnetGroup = new rds.SubnetGroup(this, 'DbSubnetGroup', {
      description: `${namePrefix} subnet group`,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const engine = rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17_9 });
    const instanceType = new ec2.InstanceType(params.dbInstanceClass.replace(/^db\./, ''));

    const primary = new rds.DatabaseInstance(this, 'Primary', {
      instanceIdentifier: `${namePrefix}-primary`,
      engine,
      instanceType,
      multiAz: true,
      allocatedStorage: params.allocatedStorage,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      vpc,
      subnetGroup,
      securityGroups: [dbSecurityGroup],
      publiclyAccessible: false,
      credentials: rds.Credentials.fromSecret(secret),
      databaseName: 'appdb',
      // A read replica needs automated backups on its source.
      backupRetention: cdk.Duration.days(1),
      deletionProtection: !isAutoDeleteObject,
      removalPolicy,
      cloudwatchLogsExports: ['postgresql'],
    });

    const replica = new rds.DatabaseInstanceReadReplica(this, 'Replica', {
      instanceIdentifier: `${namePrefix}-replica`,
      sourceDatabaseInstance: primary,
      instanceType,
      // A replica is a single instance here: it is for reads, not for availability.
      multiAz: false,
      storageEncrypted: true,
      vpc,
      subnetGroup,
      securityGroups: [dbSecurityGroup],
      publiclyAccessible: false,
      deletionProtection: !isAutoDeleteObject,
      removalPolicy: isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.SNAPSHOT,
      cloudwatchLogsExports: ['postgresql'],
    });

    // ---------------------------------------------------------------------------------------------
    // The replica's lag, as an alarm
    // ---------------------------------------------------------------------------------------------
    new cw.Alarm(this, 'ReplicaLagAlarm', {
      alarmName: `${namePrefix}-replica-lag`,
      alarmDescription: `The replica is more than ${params.replicaLagAlarmSeconds} seconds behind the primary`,
      metric: new cw.Metric({
        namespace: 'AWS/RDS',
        metricName: 'ReplicaLag',
        dimensionsMap: { DBInstanceIdentifier: `${namePrefix}-replica` },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: params.replicaLagAlarmSeconds,
      evaluationPeriods: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    // ---------------------------------------------------------------------------------------------
    // Probe: a Lambda in the VPC that talks to both endpoints
    // ---------------------------------------------------------------------------------------------
    const probe = new lambdaNodejs.NodejsFunction(this, 'ProbeFunction', {
      functionName: `${namePrefix}-probe`,
      entry: path.join(__dirname, '../../src/probe/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.minutes(15),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [probeSecurityGroup],
      environment: {
        SECRET_ARN: secret.secretArn,
        PRIMARY_ENDPOINT: primary.dbInstanceEndpointAddress,
        REPLICA_ENDPOINT: replica.dbInstanceEndpointAddress,
      },
      logGroup: new logs.LogGroup(this, 'ProbeLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      }),
    });
    secret.grantRead(probe);

    // The heartbeat keeps the ReplicaLag metric honest: without writes on the primary it reads as ever-growing lag.
    new events.Rule(this, 'HeartbeatRule', {
      ruleName: `${namePrefix}-heartbeat`,
      description: 'One small write a minute so that ReplicaLag measures replication, not idleness',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(probe, { event: events.RuleTargetInput.fromObject({ action: 'heartbeat' }), retryAttempts: 0 })],
    });

    new cdk.CfnOutput(this, 'ProbeFunctionName', { value: probe.functionName });
    new cdk.CfnOutput(this, 'PrimaryIdentifier', { value: primary.instanceIdentifier });
    new cdk.CfnOutput(this, 'ReplicaIdentifier', { value: replica.instanceIdentifier });
    new cdk.CfnOutput(this, 'PrimaryEndpoint', { value: primary.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'ReplicaEndpoint', { value: replica.dbInstanceEndpointAddress });
  }
}
