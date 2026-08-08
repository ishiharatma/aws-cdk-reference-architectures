import { params, EnvParams } from 'parameters/environments';
import { Environment } from "@common/parameters/environments";

/**
 * Test Environment Parameters
 */
const testParams: EnvParams = {
    // Regions
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    // Common tags
    tags: {},
};

// Register in the params object
params[Environment.TEST] = testParams;
