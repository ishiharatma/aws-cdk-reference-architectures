import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters
 */
const testParams: EnvParams = {
    region: 'ap-northeast-1',
    tags: {},

    awsBackupCrr: {
        destinationRegion: 'ap-northeast-3',
        backupTagKey: 'Backup',
        backupTagValue: 'true',
        scheduleExpression: 'cron(0 16 * * ? *)',
        primaryRetentionDays: 35,
        copyRetentionDays: 90,
        startWindowMinutes: 60,
        completionWindowMinutes: 480,
    },
};

// Register in the params object
params[Environment.TEST] = testParams;
