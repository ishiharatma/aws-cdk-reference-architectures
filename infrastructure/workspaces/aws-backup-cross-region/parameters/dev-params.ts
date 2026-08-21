import { params, EnvParams } from 'parameters/environments';
import { Environment } from "@common/parameters/environments";

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
    // Account ID
    //accountId: process.env.CDK_DEFAULT_ACCOUNT || '111111111111', // if you want to specify

    // Regions (primary/source region — Tokyo)
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    // Common tags
    tags: {},

    awsBackupCrr: {
        // Destination region for copied recovery points — Osaka
        destinationRegion: 'ap-northeast-3',
        // Tag-based selection: any EC2/RDS/S3/CloudFormation resource in the primary
        // region carrying this tag is automatically covered by the Backup Plan.
        backupTagKey: 'Backup',
        backupTagValue: 'true',
        // Daily at 01:00 JST (16:00 UTC the previous day)
        scheduleExpression: 'cron(0 16 * * ? *)',
        primaryRetentionDays: 35,
        copyRetentionDays: 90,
        startWindowMinutes: 60,
        completionWindowMinutes: 480,
    },
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
