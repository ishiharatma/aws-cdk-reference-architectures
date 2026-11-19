import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 *
 * Sized for an account whose G-instance quota is 8 vCPU: every allowed type is a
 * single-GPU 2xlarge (8 vCPU, 32 GiB), so at most one instance runs at a time.
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},
  maxAzs: 3,
  capacity: {
    // Newest first: L4 (24 GB) -> A10G (24 GB) -> T4 (16 GB)
    allowedInstanceTypes: ['g6.2xlarge', 'g5.2xlarge', 'g4dn.2xlarge'],
    maxVCpuCount: 8,
  },
  gpuFunction: {
    // 16 GiB keeps g4dn (T4) eligible as the last fallback
    acceleratorMemorySizeGiB: 16,
    memorySizeMiB: 8192,
    executionEnvironmentMemoryGiBPerVCpu: 2,
    perExecutionEnvironmentMaxConcurrency: 4,
    // Keep one environment warm while verifying; set 0 to scale to zero when idle
    minExecutionEnvironments: 1,
    maxExecutionEnvironments: 1,
    timeoutSeconds: 60,
  },
  queue: {
    batchSize: 8,
    maxBatchingWindowSeconds: 5,
    maxReceiveCount: 5,
  },
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
