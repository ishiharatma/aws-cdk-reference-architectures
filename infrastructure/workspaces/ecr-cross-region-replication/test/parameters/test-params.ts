import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters
 */
const testParams: EnvParams = {
    region: 'ap-northeast-1',
    tags: {},

    ecrCrr: {
        sourceEcrConfig: {
            createConfig: {
                repositoryNameSuffix: 'sample-app',
                maxImageCount: 30,
                untaggedDurationDays: 14,
                anytagDurationDays: 180,
                isImageScanOnPush: true,
            },
        },
        destinationEcrConfig: {
            createConfig: {
                repositoryNameSuffix: 'sample-app',
                maxImageCount: 10,
                untaggedDurationDays: 7,
                anytagDurationDays: 90,
                isImageScanOnPush: false,
            },
        },
        destinationRegion: 'ap-northeast-3',
    },
};

// Register in the params object
params[Environment.TEST] = testParams;
