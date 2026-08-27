import * as cdk from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

/** Props for {@link AwsBackupCrrOsakaStack}. */
export interface AwsBackupCrrOsakaStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly params: EnvParams;
    /** Physical name of the secondary backup vault (must match what `AwsBackupCrrTokyoStack` targets). */
    readonly vaultName: string;
}

/**
 * Secondary Backup Vault (Osaka / ap-northeast-3).
 *
 * Pre-creating this vault — instead of letting AWS Backup auto-create a default vault on
 * first copy — is what lets the replica carry its own KMS key and be managed/torn down
 * independently of the primary (Tokyo) vault. Same-account cross-region copy needs no vault
 * access (resource-based) policy here; that is only required for cross-ACCOUNT copies.
 */
export class AwsBackupCrrOsakaStack extends cdk.Stack {
    public readonly vault: backup.BackupVault;

    constructor(scope: Construct, id: string, props: AwsBackupCrrOsakaStackProps) {
        super(scope, id, props);

        const vaultKey = new kms.Key(this, 'VaultKey', {
            alias: `${props.project}-${props.environment}-backup-osaka`,
            description: `KMS key for the ${props.project}-${props.environment} secondary (Osaka) backup vault`,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        this.vault = new backup.BackupVault(this, 'Vault', {
            backupVaultName: props.vaultName,
            encryptionKey: vaultKey,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        new cdk.CfnOutput(this, 'VaultArnOutput', {
            value: this.vault.backupVaultArn,
            description: 'ARN of the secondary (Osaka) backup vault',
        });
    }
}
