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

    repositoryName: 'cloudfront-s3',
    repositoryBranch: 'main',
    enableBuild: false, // Set to true if you want to enable the build stage in the pipeline
    deploymentTargetBucketName: 'drillexercises-dev-webs-e70af7f9-904233092792-ap-northeast-1-an',
    cloudfrontDistributionId: 'ECIA2062UBKDO',

};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;