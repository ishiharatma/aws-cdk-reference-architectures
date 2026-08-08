import { params, EnvParams } from 'parameters/environments';
import { Environment } from "@common/parameters/environments";

/**
 * Test Environment Parameters
 */
const testParams: EnvParams = {
    // Account ID
    //accountId: process.env.CDK_DEFAULT_ACCOUNT || '111111111111', // if you want to specify
    
    // Regions
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    // Common tags
    tags: {},
};

// Register in the params object
params[Environment.TEST] = testParams;