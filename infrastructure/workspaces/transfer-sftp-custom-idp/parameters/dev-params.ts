import { params, EnvParams } from 'parameters/environments';
import { Environment } from "@common/parameters/environments";

/**
 * dev Environment Parameters
 */
const devParams: EnvParams = {
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
    securityPolicyName: 'TransferSecurityPolicy-2024-01',
    logRetentionDays: 30,
    enableLogEncryption: true,
    maskSshPublicKeyInLogs: true,
    lambdaLogLevel: 'INFO',
    // always | scheduled | manual (see ServerLifecycle). Overridable with -c serverMode=...
    serverLifecycle: { mode: 'always' },
    monitoring: {
        enabled: true,
        alertEmails: [],
        periodMinutes: 5,
        authFailureThreshold: 5,
        ipDeniedThreshold: 1,
        bytesInThresholdMb: 1024,
        bytesOutThresholdMb: 1024,
    },
    // Verification environments are disposable
    retainData: false,
    tags: {},
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
