import { params, EnvParams } from 'parameters/environments';
import { Environment } from "@common/parameters/environments";

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
    // Account ID
    //accountId: process.env.CDK_DEFAULT_ACCOUNT || '111111111111', // if you want to specify
    
    // Regions
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    // Common tags
    tags: {},

    // if you want to enable WAF for the CloudFront distribution, set this to true and provide the webAclArn in the stack props
    enableWaf: true,

    // Restrict the CloudFront distribution to Japan only. Leave empty/omit to allow all countries.
    geoRestrictionCountries: ['JP'],
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;