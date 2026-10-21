import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters
 *
 * Static values only (no env-var / network lookups) so snapshots stay deterministic.
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  workflow: {
    executionTimeoutDays: 7,
    retentionDays: 14,
    approvalTimeoutHours: 48,
    invocationTimeoutSeconds: 60,
  },
  apiThrottle: { rateLimit: 10, burstLimit: 20 },
  approverEmails: ['approver@example.com'],
  alertEmails: ['ops@example.com'],
};

// Register in the params object
params[Environment.TEST] = testParams;
