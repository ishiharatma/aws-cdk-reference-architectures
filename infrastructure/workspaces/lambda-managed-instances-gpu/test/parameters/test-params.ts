import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters
 *
 * Static values only (no env-var lookups) so snapshots stay deterministic.
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  maxAzs: 3,
  capacity: {
    allowedInstanceTypes: ['g6.2xlarge', 'g5.2xlarge', 'g4dn.2xlarge'],
    maxVCpuCount: 8,
  },
  gpuFunction: {
    acceleratorMemorySizeGiB: 16,
    memorySizeMiB: 8192,
    executionEnvironmentMemoryGiBPerVCpu: 2,
    perExecutionEnvironmentMaxConcurrency: 4,
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
params[Environment.TEST] = testParams;
