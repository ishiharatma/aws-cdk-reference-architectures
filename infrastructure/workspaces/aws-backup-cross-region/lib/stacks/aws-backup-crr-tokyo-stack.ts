import * as cdk from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { SampleWorkloadConstruct } from 'lib/constructs/sample-workload-construct';

/** Props for {@link AwsBackupCrrTokyoStack}. */
export interface AwsBackupCrrTokyoStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly params: EnvParams;
    readonly isAutoDeleteObject: boolean;
    /** Region the Backup Plan's copy action targets — Osaka. */
    readonly destinationRegion: string;
    /** Physical name of the pre-created secondary vault in `destinationRegion`. */
    readonly destinationVaultName: string;
}

/**
 * Sample VPC/EC2/RDS/S3 workload (Tokyo / ap-northeast-1) plus the primary Backup Vault,
 * Backup Plan, and a single tag-based Backup Selection that spans all resource types used in
 * this pattern (EC2, RDS, S3, and — via the sibling `SampleAppStack` — CloudFormation)
 * without a separate selection per service. The plan's daily rule copies every recovery
 * point into the pre-created Osaka vault.
 *
 * The destination vault ARN is built deterministically from region/account/name rather than
 * passed as a CDK cross-stack reference: CloudFormation exports/`Fn::ImportValue` cannot
 * cross regions, so `AwsBackupCrrOsakaStack`'s vault ARN cannot be `Ref`'d directly from
 * here. This is the same approach the ECR Cross-Region Replication pattern uses.
 */
export class AwsBackupCrrTokyoStack extends cdk.Stack {
    public readonly vault: backup.BackupVault;
    public readonly plan: backup.BackupPlan;

    constructor(scope: Construct, id: string, props: AwsBackupCrrTokyoStackProps) {
        super(scope, id, props);

        const {
            backupTagKey = 'Backup',
            backupTagValue = 'true',
            scheduleExpression = 'cron(0 16 * * ? *)',
            primaryRetentionDays = 35,
            copyRetentionDays = 90,
            startWindowMinutes = 60,
            completionWindowMinutes = 480,
        } = props.params.awsBackupCrr;

        new SampleWorkloadConstruct(this, 'SampleWorkload', {
            project: props.project,
            environment: props.environment,
            isAutoDeleteObject: props.isAutoDeleteObject,
            backupTagKey,
            backupTagValue,
        });

        const vaultKey = new kms.Key(this, 'VaultKey', {
            alias: `${props.project}-${props.environment}-backup-tokyo`,
            description: `KMS key for the ${props.project}-${props.environment} primary (Tokyo) backup vault`,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        this.vault = new backup.BackupVault(this, 'Vault', {
            backupVaultName: `${props.project}-${props.environment}-backup-tokyo`,
            encryptionKey: vaultKey,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const destinationVaultArn = this.formatArn({
            region: props.destinationRegion,
            account: this.account,
            service: 'backup',
            resource: 'backup-vault',
            resourceName: props.destinationVaultName,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        });
        const destinationVault = backup.BackupVault.fromBackupVaultArn(this, 'DestinationVault', destinationVaultArn);

        this.plan = new backup.BackupPlan(this, 'Plan', {
            backupPlanName: `${props.project}-${props.environment}-backup-plan`,
            backupVault: this.vault,
        });

        this.plan.addRule(
            new backup.BackupPlanRule({
                ruleName: 'DailyBackup',
                scheduleExpression: events.Schedule.expression(scheduleExpression),
                startWindow: cdk.Duration.minutes(startWindowMinutes),
                completionWindow: cdk.Duration.minutes(completionWindowMinutes),
                deleteAfter: cdk.Duration.days(primaryRetentionDays),
                copyActions: [
                    {
                        destinationBackupVault: destinationVault,
                        deleteAfter: cdk.Duration.days(copyRetentionDays),
                    },
                ],
            }),
        );

        // AWS Backup has no customer-manageable equivalent to these two service-role
        // policies (AwsSolutions-IAM4 is suppressed for this role in test/compliance).
        const backupRole = new iam.Role(this, 'BackupRole', {
            roleName: `${props.project}-${props.environment}-backup-role`,
            assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForBackup'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForRestores'),
            ],
        });

        // A single tag-based selection covers every supported resource type carrying this
        // tag in this region — EC2, RDS, and S3 from SampleWorkloadConstruct above, plus the
        // AWS::CloudFormation::Stack recovery point for the sibling SampleAppStack — with no
        // per-service selection needed.
        this.plan.addSelection('TagBasedSelection', {
            role: backupRole,
            resources: [backup.BackupResource.fromTag(backupTagKey, backupTagValue)],
            allowRestores: true,
        });

        new cdk.CfnOutput(this, 'VaultArnOutput', {
            value: this.vault.backupVaultArn,
            description: 'ARN of the primary (Tokyo) backup vault',
        });
    }
}
