import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/** Valid range of `CapacityProviderScalingConfig.MaxVCpuCount` in the CloudFormation schema. */
const MAX_VCPU_MIN = 2;
const MAX_VCPU_MAX = 15000;

/**
 * Instance families that Lambda Managed Instances accepts for GPU capacity providers.
 * `g4dn.metal` is the only excluded size.
 */
const GPU_FAMILIES = ['g4dn', 'g5', 'g6', 'gr6', 'g6e', 'g6f', 'gr6f'];

/**
 *
 */
/** Something that can attach a function to Lambda Managed Instances capacity. */
export interface GpuFunctionHost {
  /** Runs `func` on the host's instances. */
  addFunction(func: lambda.IFunction, options?: lambda.CapacityProviderFunctionOptions): void;
}

/** Properties for {@link GpuCapacityProvider}. */
export interface GpuCapacityProviderProps {
  /** Subnets the instances are launched in. Spread across AZs to widen the GPU capacity pool. */
  readonly subnets: ec2.ISubnet[];
  /** Security groups attached to the instances. */
  readonly securityGroups: ec2.ISecurityGroup[];
  /** Allowed G-series instance types (e.g. `g6.2xlarge`). */
  readonly allowedInstanceTypes: string[];
  /** Maximum vCPUs across all instances (2-15000). Align with the account's G-instance quota. */
  readonly maxVCpuCount: number;
  /**
   * Target GPU utilization (0-100) for a `Manual` target tracking policy.
   * @default - `ScalingMode: Auto`
   */
  readonly targetGpuUtilization?: number;
  /** Log group for capacity provider system logs. */
  readonly logGroup?: logs.ILogGroupRef;
  /** Tags propagated to the EC2 instances, ENIs and EBS volumes Lambda creates. */
  readonly propagatedTags?: Record<string, string>;
}

/**
 * A Lambda Managed Instances capacity provider restricted to GPU (G-series) instances.
 *
 * Wraps the aws-cdk-lib L2 `CapacityProvider` and fills two gaps in aws-cdk-lib 2.276/2.277:
 * - the L2 rejects `maxVCpuCount` below 12, although CloudFormation accepts 2 and above.
 *   A single 2xlarge GPU instance needs 8, so the value is written through an escape hatch.
 * - `TargetTrackingScalingPolicy` only offers CPU utilization; the GPU metric
 *   (`LambdaCapacityProviderAverageGPUUtilization`) is also written through the escape hatch.
 */
export class GpuCapacityProvider extends Construct implements GpuFunctionHost {
  /** The underlying capacity provider. */
  public readonly capacityProvider: lambda.ICapacityProvider;
  private readonly resource: lambda.CapacityProvider;

  /** Creates the capacity provider and applies the GPU-specific scaling configuration. */
  constructor(scope: Construct, id: string, props: GpuCapacityProviderProps) {
    super(scope, id);
    validateProps(props);

    this.resource = new lambda.CapacityProvider(this, 'Resource', {
      subnets: props.subnets,
      securityGroups: props.securityGroups,
      // GPU functions run on x86_64 only
      architectures: [lambda.Architecture.X86_64],
      instanceTypeFilter: lambda.InstanceTypeFilter.allow(
        props.allowedInstanceTypes.map((t) => new ec2.InstanceType(t)),
      ),
      logGroup: props.logGroup,
      propagateTags: props.propagatedTags ? lambda.PropagateTags.explicit(props.propagatedTags) : undefined,
    });

    this.capacityProvider = this.resource;

    const cfn = this.resource.node.defaultChild as lambda.CfnCapacityProvider;
    cfn.addPropertyOverride('CapacityProviderScalingConfig', {
      MaxVCpuCount: props.maxVCpuCount,
      ...(props.targetGpuUtilization === undefined
        ? { ScalingMode: 'Auto' }
        : {
            ScalingMode: 'Manual',
            ScalingPolicies: [
              {
                PredefinedMetricType: 'LambdaCapacityProviderAverageGPUUtilization',
                TargetValue: props.targetGpuUtilization,
              },
            ],
          }),
    });
  }

  /** ARN of the capacity provider. */
  public get capacityProviderArn(): string {
    return this.resource.capacityProviderArn;
  }

  /** Name of the capacity provider (used as the `CapacityProviderName` metric dimension). */
  public get capacityProviderName(): string {
    return this.resource.capacityProviderName;
  }

  /** Runs `func` on this capacity provider's instances. */
  public addFunction(func: lambda.IFunction, options?: lambda.CapacityProviderFunctionOptions): void {
    this.resource.addFunction(func, options);
  }
}

/** Fail fast on values CloudFormation or Lambda would reject at deploy time. */
function validateProps(props: GpuCapacityProviderProps): void {
  if (props.allowedInstanceTypes.length === 0) {
    throw new Error('allowedInstanceTypes must contain at least one GPU instance type.');
  }
  for (const type of props.allowedInstanceTypes) {
    const [family, size] = type.split('.');
    if (!GPU_FAMILIES.includes(family) || !size) {
      throw new Error(
        `${type} is not a supported GPU instance type. GPU and non-GPU types cannot be mixed in one capacity provider (supported families: ${GPU_FAMILIES.join(', ')}).`,
      );
    }
    if (type === 'g4dn.metal') {
      throw new Error('g4dn.metal is not supported by Lambda Managed Instances.');
    }
  }
  if (!cdk.Token.isUnresolved(props.maxVCpuCount) && (props.maxVCpuCount < MAX_VCPU_MIN || props.maxVCpuCount > MAX_VCPU_MAX)) {
    throw new Error(`maxVCpuCount must be between ${MAX_VCPU_MIN} and ${MAX_VCPU_MAX}, got ${props.maxVCpuCount}.`);
  }
  if (props.targetGpuUtilization !== undefined && (props.targetGpuUtilization <= 0 || props.targetGpuUtilization > 100)) {
    throw new Error(`targetGpuUtilization must be in (0, 100], got ${props.targetGpuUtilization}.`);
  }
}
