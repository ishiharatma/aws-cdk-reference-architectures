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

    ecrCrr: {
        // Source repository — Tokyo (ap-northeast-1)
        sourceEcrConfig: {
            createConfig: {
                repositoryNameSuffix: 'sample-app',
                maxImageCount: 30,
                untaggedDurationDays: 14,
                anytagDurationDays: 180,
                isImageScanOnPush: true,
            },
        },
        // Destination repository — Osaka (ap-northeast-3).
        // repositoryNameSuffix must match sourceEcrConfig's — replication matches
        // repositories by name (see EcrCrrParams). The retention policy itself is
        // intentionally leaner here to demonstrate that the replica lifecycle is
        // configured independently from the source.
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
params[Environment.DEVELOPMENT] = devParams;
