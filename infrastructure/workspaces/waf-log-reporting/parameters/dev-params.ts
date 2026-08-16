import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 *
 * Both report stacks target the standalone sample Web ACL (Stack 1) by
 * default. To point a report at an existing WAF instead, set
 * `cwLogsReport.existingLogGroupName` and/or `athenaReport.existingSource`
 * (see lib/types/waf-log-reporting-params.ts for details).
 */
const devParams: EnvParams = {
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    tags: {},

    sampleWaf: {},

    cwLogsReport: {
        // Override via `NOTIFICATION_EMAIL_CWLOGS` env var; must be confirmed
        // by clicking the link in the confirmation email after deployment.
        notificationEmail: process.env.NOTIFICATION_EMAIL_CWLOGS || 'change-me@example.com',

        // Uncomment to report on an existing WAF's log group instead of the
        // standalone sample Web ACL created by Stack 1:
        // existingLogGroupName: 'aws-waf-logs-my-existing-webacl',
    },

    athenaReport: {
        notificationEmail: process.env.NOTIFICATION_EMAIL_ATHENA || 'change-me@example.com',

        // Uncomment to report on logs an existing WAF already delivers to S3
        // instead of provisioning the sample Firehose -> S3 pipeline:
        // existingSource: {
        //     bucketName: 'my-existing-waf-logs-bucket',
        //     webAclName: 'my-existing-webacl',
        // },
    },
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
