import { params, EnvParams } from 'parameters/environments';
import { Environment } from "@common/parameters/environments";

/**
 * Test Environment Parameters
 */
const testParams: EnvParams = {
    region: 'ap-northeast-1',

    tags: {},

    repositoryName: 'test-repo',
    repositoryBranch: 'main',
    enableBuild: true,
    deploymentTargetBucketName: 'test-deployment-bucket',
    cloudfrontDistributionId: 'EXXXXXXXXXXXXX',
};

// Register in the params object
params[Environment.TEST] = testParams;
