import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface SecretsRotationAuroraStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * Automatic credential rotation for Aurora PostgreSQL with AWS Secrets Manager.
 *
 *   master secret ── single-user rotation  (the admin user changes its own password)
 *   app secret    ── alternating-user rotation (appuser <-> appuser_clone; one always stays valid)
 *
 * The rotation functions are Secrets Manager *hosted rotation* (no code to write or patch). They run
 * in the VPC, so the isolated subnets get a Secrets Manager interface endpoint instead of a NAT gateway.
 * Consumers read the secret at run time; the sample function goes through the RDS Data API and never
 * holds a password.
 */
export class SecretsRotationAuroraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SecretsRotationAuroraStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-rot`;

    // ---------------------------------------------------------------------------------------------
    // Network: private isolated subnets only. No NAT gateway, no internet route.
    // ---------------------------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });
    vpc.addFlowLog('FlowLog', { trafficType: ec2.FlowLogTrafficType.REJECT });

    // The rotation functions call the Secrets Manager API from inside the VPC.
    const secretsEndpoint = vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });

    const rotationSg = new ec2.SecurityGroup(this, 'RotationSecurityGroup', {
      vpc,
      description: 'Secrets Manager hosted rotation functions',
      allowAllOutbound: false,
    });
    secretsEndpoint.connections.allowFrom(rotationSg, ec2.Port.tcp(443), 'Rotation functions call Secrets Manager');

    // ---------------------------------------------------------------------------------------------
    // Aurora PostgreSQL Serverless v2 (writer only)
    // ---------------------------------------------------------------------------------------------
    const cluster = new rds.DatabaseCluster(this, 'Cluster', {
      clusterIdentifier: `${namePrefix}-aurora`,
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_13 }),
      credentials: rds.Credentials.fromGeneratedSecret('dbadmin', { secretName: `${namePrefix}/master` }),
      defaultDatabaseName: params.databaseName,
      serverlessV2MinCapacity: params.minCapacity,
      serverlessV2MaxCapacity: params.maxCapacity,
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      storageEncrypted: true,
      enableDataApi: true, // lets the sample function (and the check script) run SQL without network access to the DB
      iamAuthentication: true,
      backup: { retention: cdk.Duration.days(isAutoDeleteObject ? 1 : 7) },
      deletionProtection: !isAutoDeleteObject,
      removalPolicy,
    });
    cluster.connections.allowDefaultPortFrom(rotationSg, 'Rotation functions connect to the database');
    const masterSecret = cluster.secret as secretsmanager.ISecret;

    // ---------------------------------------------------------------------------------------------
    // Application secret: a separate database user, created with the master credentials as its "master secret"
    // ---------------------------------------------------------------------------------------------
    const appSecret = new rds.DatabaseSecret(this, 'AppSecret', {
      secretName: `${namePrefix}/app`,
      username: params.appUsername,
      masterSecret,
      dbname: params.databaseName,
    }).attach(cluster);

    const hostedRotationProps = { vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }, securityGroups: [rotationSg] };

    // Master: single-user (the admin user cannot be cloned, because cloning needs an admin).
    masterSecret.addRotationSchedule('MasterRotation', {
      hostedRotation: secretsmanager.HostedRotation.postgreSqlSingleUser({ functionName: `${namePrefix}-master-rotation`, ...hostedRotationProps }),
      automaticallyAfter: cdk.Duration.days(params.rotationDays),
      rotateImmediatelyOnUpdate: false, // rotations are triggered explicitly by the check script
    });

    // App user: alternating users -- the previous credentials stay valid while consumers pick up the new ones.
    appSecret.addRotationSchedule('AppRotation', {
      hostedRotation: secretsmanager.HostedRotation.postgreSqlMultiUser({
        functionName: `${namePrefix}-app-rotation`,
        masterSecret,
        ...hostedRotationProps,
      }),
      automaticallyAfter: cdk.Duration.days(params.rotationDays),
      rotateImmediatelyOnUpdate: false,
    });

    // ---------------------------------------------------------------------------------------------
    // Sample consumer: reads the credentials through the RDS Data API, so it never holds a password
    // ---------------------------------------------------------------------------------------------
    const whoami = new lambdaNodejs.NodejsFunction(this, 'WhoamiFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../src/handlers/whoami.ts'),
      handler: 'handler',
      functionName: `${namePrefix}-whoami`,
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      environment: { CLUSTER_ARN: cluster.clusterArn, SECRET_ARN: appSecret.secretArn, DATABASE_NAME: params.databaseName },
      logGroup: new logs.LogGroup(this, 'WhoamiLogGroup', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy }),
    });
    whoami.addToRolePolicy(new iam.PolicyStatement({ actions: ['rds-data:ExecuteStatement'], resources: [cluster.clusterArn] }));
    whoami.addToRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [appSecret.secretArn] }));

    // ---------------------------------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ClusterArn', { value: cluster.clusterArn });
    new cdk.CfnOutput(this, 'MasterSecretArn', { value: masterSecret.secretArn });
    new cdk.CfnOutput(this, 'AppSecretArn', { value: appSecret.secretArn });
    new cdk.CfnOutput(this, 'DatabaseName', { value: params.databaseName });
    new cdk.CfnOutput(this, 'AppUsername', { value: params.appUsername });
    new cdk.CfnOutput(this, 'WhoamiFunctionName', { value: whoami.functionName });
  }
}
