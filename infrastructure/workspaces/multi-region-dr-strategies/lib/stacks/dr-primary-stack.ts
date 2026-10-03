import * as cdk from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { OrdersApp } from 'lib/constructs/orders-app';
import { orderTableName, STRATEGIES } from 'lib/types';

export interface DrPrimaryStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
  /** Name of the backup vault in the DR region (destination of the copy). */
  readonly drVaultName: string;
  /** Host of the warm standby function URL in the DR region. */
  readonly warmStandbyHost: string;
  /** Host of the active-active function URL in the DR region. */
  readonly activeActiveHost: string;
}

/** Runs inside the VPC and resolves a record through the VPC resolver, the same path real clients use. */
const RESOLVER_CODE = `
const dns = require('dns').promises;
exports.handler = async (event) => {
  const cname = await dns.resolveCname(event.name);
  return { name: event.name, cname };
};
`;

/**
 * Primary region (default Tokyo): the data layer and the API for all four strategies, plus the DNS routing.
 *
 *   backup and restore  single-region table + AWS Backup plan that copies recovery points to the DR vault
 *   pilot light         global table (replica in the DR region); API here only
 *   warm standby        global table; API here, standby API in the DR region; DNS failover (PRIMARY/SECONDARY)
 *   active-active       global table; API in both regions; DNS weighted 50/50 with health checks
 */
export class DrPrimaryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DrPrimaryStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const prefix = `${project}-${environment}-dr`;

    // ---------------------------------------------------------------------------------------------
    // Data: one table per strategy
    // ---------------------------------------------------------------------------------------------
    const tables = {} as Record<(typeof STRATEGIES)[number], dynamodb.ITableV2 | dynamodb.Table>;
    const apps = {} as Record<(typeof STRATEGIES)[number], OrdersApp>;
    for (const strategy of STRATEGIES) {
      const tableName = orderTableName(prefix, strategy);
      const key = { name: 'id', type: dynamodb.AttributeType.STRING };
      tables[strategy] = strategy === 'bnr'
        ? new dynamodb.Table(this, 'BnrTable', {
          tableName,
          partitionKey: key,
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
          removalPolicy,
        })
        : new dynamodb.TableV2(this, `${strategy.toUpperCase()}Table`, {
          tableName,
          partitionKey: key,
          billing: dynamodb.Billing.onDemand(),
          pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
          replicas: [{ region: params.drRegion }],
          removalPolicy,
        });
      apps[strategy] = new OrdersApp(this, `${strategy.toUpperCase()}App`, {
        strategy,
        functionName: `${prefix}-${strategy}-primary`,
        tableName,
        tableRegion: this.region,
        removalPolicy,
      });
    }

    // ---------------------------------------------------------------------------------------------
    // Backup and restore: daily backup of the single-region table, copied to the DR vault
    // ---------------------------------------------------------------------------------------------
    const vaultKey = new kms.Key(this, 'VaultKey', {
      alias: `${prefix}-bnr-primary`,
      description: `KMS key for the ${prefix} primary backup vault`,
      enableKeyRotation: true,
      removalPolicy,
    });
    const vault = new backup.BackupVault(this, 'Vault', {
      backupVaultName: `${prefix}-bnr-primary`,
      encryptionKey: vaultKey,
      removalPolicy,
    });
    const drVault = backup.BackupVault.fromBackupVaultArn(this, 'DrVault', this.formatArn({
      region: params.drRegion,
      service: 'backup',
      resource: 'backup-vault',
      resourceName: props.drVaultName,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    }));
    const plan = new backup.BackupPlan(this, 'Plan', { backupPlanName: `${prefix}-bnr-plan`, backupVault: vault });
    plan.addRule(new backup.BackupPlanRule({
      ruleName: 'DailyBackupWithCopy',
      scheduleExpression: events.Schedule.expression(params.backupScheduleCron),
      deleteAfter: cdk.Duration.days(params.backupRetentionDays),
      copyActions: [{ destinationBackupVault: drVault, deleteAfter: cdk.Duration.days(params.backupRetentionDays) }],
    }));
    const backupRole = new iam.Role(this, 'BackupRole', {
      roleName: `${prefix}-bnr-backup-role`,
      assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForBackup'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForRestores'),
      ],
    });
    plan.addSelection('BnrTable', {
      role: backupRole,
      resources: [backup.BackupResource.fromDynamoDbTable(tables.bnr as dynamodb.Table)],
      allowRestores: true,
    });

    // ---------------------------------------------------------------------------------------------
    // DNS routing for warm standby (failover) and active-active (weighted)
    // ---------------------------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(params.vpcCidr),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 }],
      restrictDefaultSecurityGroup: true,
    });
    const zone = new route53.PrivateHostedZone(this, 'Zone', { zoneName: 'dr.internal', vpc });

    const healthCheck = (id: string, host: string, name: string) => new route53.CfnHealthCheck(this, id, {
      healthCheckConfig: {
        type: 'HTTPS',
        fullyQualifiedDomainName: host,
        port: 443,
        resourcePath: '/health',
        requestInterval: params.healthCheckIntervalSeconds,
        failureThreshold: params.healthCheckFailureThreshold,
        enableSni: true,
      },
      healthCheckTags: [{ key: 'Name', value: `${prefix}-${name}` }],
    });
    const wsPrimaryCheck = healthCheck('WsPrimaryCheck', apps.ws.host, 'ws-primary');
    const aaPrimaryCheck = healthCheck('AaPrimaryCheck', apps.aa.host, 'aa-primary');
    const aaDrCheck = healthCheck('AaDrCheck', props.activeActiveHost, 'aa-dr');

    const record = (id: string, name: string, setIdentifier: string, value: string, extra: Partial<route53.CfnRecordSetProps>) =>
      new route53.CfnRecordSet(this, id, {
        hostedZoneId: zone.hostedZoneId,
        name: `${name}.dr.internal`,
        type: 'CNAME',
        ttl: String(params.recordTtl),
        setIdentifier,
        resourceRecords: [value],
        ...extra,
      });
    record('WsPrimaryRecord', 'ws', 'primary', apps.ws.host, { failover: 'PRIMARY', healthCheckId: wsPrimaryCheck.attrHealthCheckId });
    record('WsSecondaryRecord', 'ws', 'secondary', props.warmStandbyHost, { failover: 'SECONDARY' });
    record('AaPrimaryRecord', 'aa', 'primary', apps.aa.host, { weight: 50, healthCheckId: aaPrimaryCheck.attrHealthCheckId });
    record('AaDrRecord', 'aa', 'dr', props.activeActiveHost, { weight: 50, healthCheckId: aaDrCheck.attrHealthCheckId });

    const resolver = new lambda.Function(this, 'ResolverFunction', {
      functionName: `${prefix}-resolver`,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(RESOLVER_CODE),
      timeout: cdk.Duration.seconds(5),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      allowPublicSubnet: false,
      logGroup: new logs.LogGroup(this, 'ResolverLogGroup', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy }),
    });
    resolver.node.addDependency(zone);

    // ---------------------------------------------------------------------------------------------
    // Outputs (used by drill.sh)
    // ---------------------------------------------------------------------------------------------
    for (const strategy of STRATEGIES) {
      new cdk.CfnOutput(this, `${strategy.toUpperCase()}Url`, { value: apps[strategy].url.url });
      new cdk.CfnOutput(this, `${strategy.toUpperCase()}FunctionName`, { value: apps[strategy].function.functionName });
    }
    new cdk.CfnOutput(this, 'ResolverFunctionName', { value: resolver.functionName });
    new cdk.CfnOutput(this, 'PrimaryVaultName', { value: vault.backupVaultName });
    new cdk.CfnOutput(this, 'BackupPlanId', { value: plan.backupPlanId });
    new cdk.CfnOutput(this, 'BnrTableArn', { value: tables.bnr.tableArn });
    new cdk.CfnOutput(this, 'BackupRoleArn', { value: backupRole.roleArn });
  }
}
