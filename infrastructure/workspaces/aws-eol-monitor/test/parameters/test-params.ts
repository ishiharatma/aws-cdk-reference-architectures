import * as cdk from 'aws-cdk-lib';
import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const testParams: EnvParams = {
  stackNamePrefix: 'aws-eol-monitor',

  collector: {
    datasetUrl: 'https://raw.githubusercontent.com/awslabs/aws-service-eol-data/main/data/eol.json',
    upcomingThresholdDays: 180,
  },

  schedule: {
    scheduleExpression: 'cron(0 9 * * ? *)',
    scheduleTimeZone: cdk.TimeZone.ASIA_TOKYO,
  },

  report: {
    bedrockModelId: 'apac.anthropic.claude-sonnet-4-5-20250929-v1:0',
    locale: 'ja',
  },

  notification: {
    emails: ['test@example.com'],
  },
};

params[Environment.TEST] = testParams;
