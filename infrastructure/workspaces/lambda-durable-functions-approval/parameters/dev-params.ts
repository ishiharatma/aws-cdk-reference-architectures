import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},
  workflow: {
    executionTimeoutDays: 7,
    retentionDays: 14,
    approvalTimeoutMinutes: 48 * 60,
    invocationTimeoutSeconds: 60,
  },
  apiThrottle: { rateLimit: 10, burstLimit: 20 },
  demoWebUi: { enabled: true },
  // approverEmails: ['approver@example.com'],
  // alertEmails: ['ops@example.com'],
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
