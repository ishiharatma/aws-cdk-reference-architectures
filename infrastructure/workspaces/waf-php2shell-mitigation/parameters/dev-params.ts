import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},
  waf: {
    // Configuration reached by the verification in README (phase 4b):
    // CloudFront inspects 64 KB and blocks anything larger, so no part of a body escapes
    // inspection while ordinary bodies up to 64 KB still pass. The ALB keeps the oversize
    // rule in COUNT: its 8 KB rule would otherwise block what CloudFront already allowed.
    cloudFront: {
      ruleActions: { php2Shell: 'BLOCK', blockMultipart: 'COUNT', blockOversizeBody: 'BLOCK', rateLimitPosts: 'COUNT' },
      oversizeBodyBytes: 65536,
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
    // Lets test-waf.sh compare the ALB path directly. Set false outside verification.
    allowDirectAlbAccess: true,
  },
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
