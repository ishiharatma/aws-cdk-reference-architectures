import { params, EnvParams } from 'parameters/environments';
import { Environment } from "@common/parameters/environments";

/**
 * Development Environment Parameters
 *
 * Architecture F: Step Functions Standard workflow (Saga pattern) + 5 Lambda
 * functions + DynamoDB. No VPC required — all services are fully managed
 * serverless.
 */
const devParams: EnvParams = {
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    tags: {},

    // alarmEmail: 'your@email.example.com',
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
