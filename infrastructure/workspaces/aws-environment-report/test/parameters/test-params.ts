import * as cdk from 'aws-cdk-lib';
import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const testParams: EnvParams = {
  stackNamePrefix: 'aws-environment-report',
  target: { regions: ['us-east-1', 'ap-northeast-1'] },
  schedule: {
    scheduleExpression: 'cron(0 9 3-10 * ? *)',
    scheduleTimeZone: cdk.TimeZone.ASIA_TOKYO,
    finalizeDeadlineDay: 10,
  },
  cur: { bucketName: 'test-cur-bucket', prefix: 'cur', exportName: 'cur2' },
  security: { maxFindingsPerSource: 1000 },
  summary: { enabled: true, bedrockModelId: 'jp.anthropic.claude-sonnet-4-6', locale: 'ja' },
  delivery: { mode: 'none' },
  retention: { rawDays: 90 },
};

params[Environment.TEST] = testParams;
