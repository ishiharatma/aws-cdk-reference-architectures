import * as cdk from 'aws-cdk-lib';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { AcceleratorMemorySizeGiB, GpuFunctionParams } from 'parameters/environments';
import { GpuFunctionHost } from 'lib/constructs/gpu-capacity-provider';

const ACCELERATOR_MEMORY_SIZES: AcceleratorMemorySizeGiB[] = [3, 6, 12, 16, 24, 48];
const GPU_MEMORY_MIN_MIB = 2048;
const GPU_MEMORY_MAX_MIB = 32768;
const GPU_MAX_CONCURRENCY = 48;

/** Properties for {@link GpuInferenceFunction}. */
export interface GpuInferenceFunctionProps extends GpuFunctionParams {
  /** Capacity provider whose GPU instances run the function. */
  readonly capacityProvider: GpuFunctionHost;
  /** Directory containing the Dockerfile (GPU functions are container images only). */
  readonly imageDirectory: string;
  /** Environment variables for the handler. */
  readonly environment?: Record<string, string>;
  /** Log group for function logs. */
  readonly logGroup: logs.ILogGroup;
}

/**
 * A container-image Event Function that runs on GPU instances of a Lambda Managed Instances
 * capacity provider.
 *
 * aws-cdk-lib 2.276/2.277 has no property for `AcceleratorConfig` yet, although the
 * `AWS::Lambda::Function` schema already accepts it, so it is written through an escape hatch.
 * Without it the function would be placed as a CPU function and the image would find no GPU.
 */
export class GpuInferenceFunction extends Construct {
  /** The GPU function (unqualified; invocations go to $LATEST.PUBLISHED). */
  public readonly function: lambda.IFunction;

  /** Creates the function, attaches it to the capacity provider and requests a GPU. */
  constructor(scope: Construct, id: string, props: GpuInferenceFunctionProps) {
    super(scope, id);
    validateProps(props);

    const fn = new lambda.DockerImageFunction(this, 'Resource', {
      code: lambda.DockerImageCode.fromImageAsset(props.imageDirectory, {
        platform: ecrAssets.Platform.LINUX_AMD64,
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: props.memorySizeMiB,
      timeout: cdk.Duration.seconds(props.timeoutSeconds),
      environment: props.environment,
      logGroup: props.logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
    });

    this.function = fn;

    props.capacityProvider.addFunction(fn, {
      perExecutionEnvironmentMaxConcurrency: props.perExecutionEnvironmentMaxConcurrency,
      executionEnvironmentMemoryGiBPerVCpu: props.executionEnvironmentMemoryGiBPerVCpu,
      // Publishing $LATEST.PUBLISHED is what makes Lambda launch the GPU instances
      publishToLatestPublished: true,
      latestPublishedScalingConfig: {
        minExecutionEnvironments: props.minExecutionEnvironments,
        maxExecutionEnvironments: props.maxExecutionEnvironments,
      },
    });

    const cfn = fn.node.defaultChild as lambda.CfnFunction;
    cfn.addPropertyOverride('AcceleratorConfig', {
      AcceleratorMemorySize: props.acceleratorMemorySizeGiB,
    });
    // The schema bundled with aws-cdk-lib (validateAgainstDefaultRules) predates AcceleratorConfig.
    cdk.Validations.of(cfn).acknowledge({
      id: 'CloudFormation-Validate::F3002',
      reason: 'Bundled cfn-lint schema predates AWS::Lambda::Function AcceleratorConfig; the CloudFormation registry schema accepts it.',
    });
  }
}

/** Fail fast on values Lambda rejects for GPU functions. */
function validateProps(props: GpuInferenceFunctionProps): void {
  if (!ACCELERATOR_MEMORY_SIZES.includes(props.acceleratorMemorySizeGiB)) {
    throw new Error(
      `acceleratorMemorySizeGiB must be one of ${ACCELERATOR_MEMORY_SIZES.join(', ')}, got ${props.acceleratorMemorySizeGiB}.`,
    );
  }
  if (props.memorySizeMiB < GPU_MEMORY_MIN_MIB || props.memorySizeMiB > GPU_MEMORY_MAX_MIB) {
    throw new Error(
      `memorySizeMiB must be between ${GPU_MEMORY_MIN_MIB} and ${GPU_MEMORY_MAX_MIB} for GPU functions, got ${props.memorySizeMiB}.`,
    );
  }
  if (props.perExecutionEnvironmentMaxConcurrency < 1 || props.perExecutionEnvironmentMaxConcurrency > GPU_MAX_CONCURRENCY) {
    throw new Error(
      `perExecutionEnvironmentMaxConcurrency must be between 1 and ${GPU_MAX_CONCURRENCY} for GPU functions, got ${props.perExecutionEnvironmentMaxConcurrency}.`,
    );
  }
  if (props.timeoutSeconds < 1 || props.timeoutSeconds > 900) {
    throw new Error(`timeoutSeconds must be between 1 and 900, got ${props.timeoutSeconds}.`);
  }
}
