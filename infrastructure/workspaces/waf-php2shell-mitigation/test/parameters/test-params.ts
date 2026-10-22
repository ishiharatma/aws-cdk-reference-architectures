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
  waf: {
    // Start where the blog says to start: only the narrow PHP2Shell rule blocks.
    cloudFront: {
      ruleActions: { php2Shell: 'BLOCK', blockMultipart: 'COUNT', blockOversizeBody: 'COUNT', rateLimitPosts: 'COUNT' },
      oversizeBodyBytes: 8192,
      bodyInspectionLimit: 'KB_64',
      rateLimitPostsPerIp: 100,
    },
    alb: {
      ruleActions: { php2Shell: 'BLOCK', blockMultipart: 'COUNT', blockOversizeBody: 'COUNT', rateLimitPosts: 'COUNT' },
      oversizeBodyBytes: 8192,
    },
  },
  origin: {
    memorySize: 1024,
    timeoutSeconds: 30,
  },
  verification: {
    allowDirectAlbAccess: true,
  },
};

// Register in the params object
params[Environment.TEST] = testParams;
