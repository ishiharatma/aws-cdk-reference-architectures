import * as cdk from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { OrdersApp } from 'lib/constructs/orders-app';
import { orderTableName } from 'lib/types';

export interface DrSecondaryStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * Disaster recovery region (default Osaka), deployed first.
 *
 *   backup and restore  backup vault that receives the copied recovery points (no compute)
 *   pilot light         nothing here: the table replica comes from the global table, compute is not deployed
 *   warm standby        the full API, deployed and scaled to zero (reserved concurrency 0)
 *   active-active       the full API, serving normally
 */
export class DrSecondaryStack extends cdk.Stack {
  /** Host of the warm standby function URL. */
  public readonly warmStandbyHost: string;
  /** Host of the active-active function URL in this region. */
  public readonly activeActiveHost: string;
  public readonly vaultName: string;

  constructor(scope: Construct, id: string, props: DrSecondaryStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const prefix = `${project}-${environment}-dr`;

    // Backup and restore: destination vault for the cross-region copy
    this.vaultName = `${prefix}-bnr-dr`;
    const vaultKey = new kms.Key(this, 'VaultKey', {
      alias: `${prefix}-bnr-dr`,
      description: `KMS key for the ${prefix} disaster recovery backup vault`,
      enableKeyRotation: true,
      removalPolicy,
    });
    new backup.BackupVault(this, 'Vault', { backupVaultName: this.vaultName, encryptionKey: vaultKey, removalPolicy });

    // Warm standby: deployed, but reserved concurrency 0 means every invocation is throttled until scaled up
    const warm = new OrdersApp(this, 'WarmStandby', {
      strategy: 'ws',
      functionName: `${prefix}-ws`,
      tableName: orderTableName(prefix, 'ws'),
      tableRegion: this.region,
      reservedConcurrentExecutions: params.warmStandbyConcurrency,
      removalPolicy,
    });
    this.warmStandbyHost = warm.host;

    // Active-active: serves from the local replica from day one
    const active = new OrdersApp(this, 'ActiveActive', {
      strategy: 'aa',
      functionName: `${prefix}-aa`,
      tableName: orderTableName(prefix, 'aa'),
      tableRegion: this.region,
      removalPolicy,
    });
    this.activeActiveHost = active.host;

    new cdk.CfnOutput(this, 'WarmStandbyUrl', { value: warm.url.url });
    new cdk.CfnOutput(this, 'WarmStandbyFunctionName', { value: warm.function.functionName });
    new cdk.CfnOutput(this, 'ActiveActiveUrl', { value: active.url.url });
    new cdk.CfnOutput(this, 'ActiveActiveFunctionName', { value: active.function.functionName });
    new cdk.CfnOutput(this, 'DrVaultName', { value: this.vaultName });
  }
}
