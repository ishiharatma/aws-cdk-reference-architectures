import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/** GPU memory sizes (GiB) accepted by `AcceleratorConfig.AcceleratorMemorySize`. */
export type AcceleratorMemorySizeGiB = 3 | 6 | 12 | 16 | 24 | 48;

/**
 * Capacity provider (the EC2 fleet Lambda manages on your behalf).
 * InstanceRequirements and VpcConfig are create-only, so changing them replaces the capacity provider.
 */
export interface GpuCapacityParams {
  /**
   * G-series instance types the capacity provider may launch. GPU and non-GPU types cannot be mixed.
   * Lambda prefers the newest generation and falls back to older ones on insufficient capacity.
   */
  readonly allowedInstanceTypes: string[];
  /**
   * Upper bound of vCPUs across all instances. Keep it at or below the account's
   * "Running On-Demand G and VT instances" quota (default 0 vCPU).
   */
  readonly maxVCpuCount: number;
  /**
   * Target for `LambdaCapacityProviderAverageGPUUtilization` (0-100). When omitted the capacity
   * provider uses `ScalingMode: Auto` (service default GPU target is 40%).
   */
  readonly targetGpuUtilization?: number;
}

/** GPU Event Function settings. */
export interface GpuFunctionParams {
  /** Minimum GPU memory per execution environment. The function fails to publish if no allowed type satisfies it. */
  readonly acceleratorMemorySizeGiB: AcceleratorMemorySizeGiB;
  /** Host memory for the execution environment (GPU functions: 2,048-32,768 MB). */
  readonly memorySizeMiB: number;
  /** Host memory per vCPU in GiB. vCPUs = memorySizeMiB / 1024 / this value. */
  readonly executionEnvironmentMemoryGiBPerVCpu: number;
  /** Concurrent invocations per execution environment (GPU default 4, max 48). Each worker loads its own model copy. */
  readonly perExecutionEnvironmentMaxConcurrency: number;
  /** Execution environments kept for $LATEST.PUBLISHED. 0 enables scale-to-zero (cold start takes minutes). */
  readonly minExecutionEnvironments: number;
  /** Upper bound of execution environments. One GPU per environment. */
  readonly maxExecutionEnvironments: number;
  /** Invocation timeout in seconds. Init timeout is max(130 s, this value). */
  readonly timeoutSeconds: number;
}

/** S3 -> SQS -> Lambda event source mapping settings. */
export interface QueueParams {
  /** Messages per invocation. Images in one batch are inferred as a single GPU batch. */
  readonly batchSize: number;
  /** Seconds the event source mapping waits to fill a batch. */
  readonly maxBatchingWindowSeconds: number;
  /** Receives before a message moves to the dead-letter queue. */
  readonly maxReceiveCount: number;
}

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** Availability Zones for the capacity provider subnets. More AZs widen the pool of GPU capacity. */
  readonly maxAzs: number;
  readonly capacity: GpuCapacityParams;
  readonly gpuFunction: GpuFunctionParams;
  readonly queue: QueueParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
