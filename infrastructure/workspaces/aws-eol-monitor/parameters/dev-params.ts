import * as cdk from 'aws-cdk-lib';
import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 *
 * Weekly schedule and a 180-day "upcoming EOL" window, tuned for a small
 * demo dataset (13 services) rather than a large fleet. Replace
 * `notification.emails` with a real, confirmable address before deploying.
 */
const devParams: EnvParams = {
  stackNamePrefix: 'aws-eol-monitor',

  collector: {
    // Pinned to a commit rather than `main` so an upstream schema change
    // doesn't silently break the parser. Update deliberately.
    datasetUrl:
      'https://raw.githubusercontent.com/awslabs/aws-service-eol-data/main/data/eol.json',
    upcomingThresholdDays: 180,
  },

  schedule: {
    scheduleExpression: 'cron(0 9 * * ? *)', // daily at 09:00 JST (scheduleTimeZone below)
    scheduleTimeZone: cdk.TimeZone.ASIA_TOKYO,
  },

  report: {
    // Cross-region inference profile ID for Claude on Bedrock.
    bedrockModelId: 'apac.anthropic.claude-sonnet-4-5-20250929-v1:0',
    locale: 'ja',
  },

  notification: {
    emails: ['dev-team@example.com'],
  },
};

params[Environment.DEVELOPMENT] = devParams;
