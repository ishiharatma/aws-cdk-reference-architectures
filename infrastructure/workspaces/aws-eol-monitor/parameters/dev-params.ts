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
    // The dataset's own README says: "Pin to a tagged release - for
    // production integrations, pin to a specific release rather than
    // tracking the main branch." This sample still points at `main` for
    // simplicity; before a real deployment, check
    // https://github.com/awslabs/aws-service-eol-data/tags for the latest
    // tag and replace `main` with it (e.g. `.../v1.2.0/data/eol.json`), so
    // an upstream schema change can't silently break the parser.
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
    bedrockModelId: 'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
    locale: 'ja',
  },

  notification: {
    emails: ['dev-team@example.com'],
  },
};

params[Environment.DEVELOPMENT] = devParams;
