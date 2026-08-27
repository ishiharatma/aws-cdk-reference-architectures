/**
 * Parameters for the AWS Backup Cross-Region (CRR) pattern (Tokyo -> Osaka).
 */
export interface AwsBackupCrrParams {
    /**
     * Region that receives copied recovery points.
     * @default 'ap-northeast-3'
     */
    readonly destinationRegion?: string;

    /**
     * Tag key used by the tag-based Backup Selection. Any supported resource in the
     * primary region carrying `backupTagKey: backupTagValue` is automatically covered by
     * the Backup Plan, regardless of resource type (EC2, RDS, S3, CloudFormation, ...).
     * @default 'Backup'
     */
    readonly backupTagKey?: string;

    /**
     * Tag value used by the tag-based Backup Selection.
     * @default 'true'
     */
    readonly backupTagValue?: string;

    /**
     * Cron/rate schedule expression (`events.Schedule` syntax) for the daily backup rule.
     * @default 'cron(0 16 * * ? *)' (01:00 JST)
     */
    readonly scheduleExpression?: string;

    /**
     * Days a recovery point is retained in the primary (Tokyo) vault before expiring.
     * @default 35
     */
    readonly primaryRetentionDays?: number;

    /**
     * Days a copied recovery point is retained in the secondary (Osaka) vault before
     * expiring. Set independently from `primaryRetentionDays` to demonstrate that the
     * copy's lifecycle does not have to mirror the source's.
     * @default 90
     */
    readonly copyRetentionDays?: number;

    /**
     * Minutes AWS Backup waits for a backup job to start before marking it failed.
     * @default 60
     */
    readonly startWindowMinutes?: number;

    /**
     * Minutes AWS Backup allows a backup job to run before canceling it.
     * @default 480
     */
    readonly completionWindowMinutes?: number;
}
