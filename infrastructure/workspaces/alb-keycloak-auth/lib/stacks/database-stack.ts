import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { AuroraKeycloakConfig } from 'parameters/environments';

export interface DatabaseStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly vpc: ec2.IVpc;
  readonly dbSg: ec2.ISecurityGroup;
  readonly auroraConfig: AuroraKeycloakConfig;
}

/**
 * Aurora Serverless V2 (PostgreSQL) as Keycloak's backend database.
 *
 * Credentials are stored in Secrets Manager and injected into
 * the Keycloak ECS task at runtime via ecs.Secret.
 */
export class DatabaseStack extends cdk.Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly secret: rds.DatabaseSecret;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    this.secret = new rds.DatabaseSecret(this, 'AuroraSecret', {
      username: props.auroraConfig.masterUsername,
      secretName: `/${props.project}/${props.environment}/aurora/credentials`,
    });

    this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      writer: rds.ClusterInstance.serverlessV2('writer'),
      serverlessV2MinCapacity: props.auroraConfig.serverlessV2MinCapacity,
      serverlessV2MaxCapacity: props.auroraConfig.serverlessV2MaxCapacity,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.dbSg],
      defaultDatabaseName: props.auroraConfig.databaseName,
      credentials: rds.Credentials.fromSecret(this.secret),
      removalPolicy: props.isAutoDeleteObject
        ? cdk.RemovalPolicy.DESTROY
        : cdk.RemovalPolicy.SNAPSHOT,
      deletionProtection: !props.isAutoDeleteObject,
      storageEncrypted: true,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_WEEK,
    });

    new cdk.CfnOutput(this, 'AuroraEndpoint', {
      value: this.cluster.clusterEndpoint.hostname,
      description: 'Aurora Serverless V2 writer endpoint',
    });
    new cdk.CfnOutput(this, 'AuroraSecretArn', {
      value: this.secret.secretArn,
      description: 'Keycloak DB credentials secret ARN',
    });
    new cdk.CfnOutput(this, 'AuroraDatabaseName', {
      value: props.auroraConfig.databaseName,
      description: 'Keycloak database name',
    });
  }
}
