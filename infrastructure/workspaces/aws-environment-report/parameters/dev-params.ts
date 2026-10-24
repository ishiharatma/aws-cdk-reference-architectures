import * as cdk from 'aws-cdk-lib';
import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 *
 * Replace `cur` with your own Data Exports (CUR 2.0) export, or delete the
 * block to run without cost data. The webhook URLs are not parameters: they
 * live in the Secrets Manager secret the Data stack creates, and are edited
 * there by hand after the first deploy.
 */
const devParams: EnvParams = {
  stackNamePrefix: 'aws-environment-report',

  target: {
    // us-east-1 is mandatory (global resource types are recorded there).
    regions: ['us-east-1', 'ap-northeast-1'],
  },

  schedule: {
    // Every day at 09:00 JST on days 3-10. The state machine skips the run
    // when the month is already built or CUR is not finalized yet.
    scheduleExpression: 'cron(0 9 3-10 * ? *)',
    scheduleTimeZone: cdk.TimeZone.ASIA_TOKYO,
    finalizeDeadlineDay: 10,
  },

  cur: {
    bucketName: 'change-me-cur-bucket',
    prefix: 'cur',
    exportName: 'cur2',
  },

  security: {
    maxFindingsPerSource: 1000,
  },

  summary: {
    enabled: true,
    // Cross-region inference profile ID for Claude on Bedrock.
    bedrockModelId: 'jp.anthropic.claude-sonnet-4-6',
    locale: 'ja',
  },

  delivery: {
    mode: 'none',
  },

  retention: {
    rawDays: 90,
  },
};

params[Environment.DEVELOPMENT] = devParams;
