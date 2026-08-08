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

    snsBasic: {
        // Override via `NOTIFICATION_EMAIL` env var; must be confirmed by
        // clicking the link in the confirmation email after deployment.
        notificationEmail: process.env.NOTIFICATION_EMAIL || 'change-me@example.com',
    },

};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;