# Lambda Managed Instances with GPUs — IaC Gaps, Quotas, Base Images, Pricing

GPU support for Lambda Managed Instances (LMI) was announced 2026-11-18. Found while
building [`lambda-managed-instances-gpu`](../../infrastructure/workspaces/lambda-managed-instances-gpu/)
on 2026-11-19. The entries below were confirmed against the CloudFormation registry
schema, the Service Quotas / Price List APIs, aws-cdk-lib 2.276.0/2.277.0 and the
base image itself. Runtime behavior (instance selection, scaling) is not deploy-verified
yet — add it here once it is.

Sources:
[What's New](https://aws.amazon.com/about-aws/whats-new/2026/11/aws-lambda-gpu-managed-instances/) /
[GPU functions](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-gpu.html) /
[GPU base images](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-gpu-base-images.html) /
[GPU scaling](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-gpu-scaling.html) /
[GPU monitoring](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-gpu-monitoring.html)

## aws-cdk-lib has three gaps (2.277.0, released 2026-11-13)

The registry schema already had everything in ap-northeast-1 and us-east-1 on 2026-11-19
(`aws cloudformation describe-type --type RESOURCE --type-name AWS::Lambda::Function`
shows `AcceleratorConfig { AcceleratorMemorySize: integer, required }`). The gaps are
all in aws-cdk-lib:

1. **`CfnFunction` has no `acceleratorConfig`.** Use
   `cfnFunction.addPropertyOverride('AcceleratorConfig', { AcceleratorMemorySize: 16 })`.
   With `@aws-cdk/core:validateAgainstDefaultRules: true` (in the repo's `cdk.json`),
   synth then fails on the bundled schema:
   **`ERROR AcceleratorConfig: Additional properties are not allowed ('AcceleratorConfig' was unexpected) (CloudFormation Validate)` / `Acknowledge with 'CloudFormation-Validate::F3002'`**.
   Fix: `cdk.Validations.of(cfnFunction).acknowledge({ id: 'CloudFormation-Validate::F3002', reason })`
   on that resource only (same mechanism as `ecs-gateway.md`'s `GatewayConnectors`).
2. **L2 `CapacityProvider` rejects `maxVCpuCount` below 12** (`maxVCpuCount must be between 12 and 15000`).
   The schema's `CapacityProviderScalingConfig.MaxVCpuCount` minimum is **2**. One
   single-GPU 2xlarge needs only 8, which is also a typical first quota. Leave
   `maxVCpuCount` out of the L2 and write `CapacityProviderScalingConfig` with
   `addPropertyOverride` (the L2 omits the block entirely when neither `maxVCpuCount`
   nor `scalingOptions` is set, so the override does not collide).
3. **`TargetTrackingScalingPolicy` only has `cpuUtilization()`.** The schema enum
   `CapacityProviderPredefinedMetricType` is `LambdaCapacityProviderAverageCPUUtilization`
   and **`LambdaCapacityProviderAverageGPUUtilization`**. Write
   `{ ScalingMode: 'Manual', ScalingPolicies: [{ PredefinedMetricType: 'LambdaCapacityProviderAverageGPUUtilization', TargetValue: 60 }] }`
   through the same override.

The rest of the L2 works for GPU functions: default operator role (trusts
`lambda.amazonaws.com`, managed policy `AWSLambdaManagedEC2ResourceOperator`), and
`capacityProvider.addFunction(fn, {...})`, which writes `CapacityProviderConfig`,
`PublishToLatestPublished` and `FunctionScalingConfig` on the `CfnFunction`.
`addFunction` also emits an Info annotation
`aws-lambda:Function.CapacityProviderConfiguration` ("cannot be removed from a function, only modified").
Create-only on the capacity provider: `CapacityProviderName`, `VpcConfig`,
`InstanceRequirements`, `PermissionsConfig`, `KmsKeyArn` (changing allowed instance types replaces it).

## G-instance quota is 0 by default, and the increase is not automatic

`Running On-Demand G and VT instances` (`--service-code ec2 --quota-code L-DB2E81BA`)
returned **0.0** in both ap-northeast-1 and us-east-1 for an account that had never run
G instances. A request for 8 vCPU went from `PENDING` to **`CASE_OPENED`** (a support
case) instead of being auto-approved. Request it before the first `cdk deploy`; with
0 the capacity provider cannot launch anything.

## The PyTorch base image (`public.ecr.aws/lambda/deep-learning-containers/pytorch:cuda`)

Inspected 2026-11-19 (digest `sha256:b9521b1134f4e4c119241ad6ee48730a29523799325f9a13dec979dad6bed578`):

- 26 layers, **5.07 GB compressed / 9.48 GB unpacked** (`base:cuda` is 1.64 GB compressed).
  The first `cdk deploy` pushes all of it to the CDK container asset repository.
- Python 3.13, torch 2.14.1+cu130, CUDA 13.0, torchvision 0.29.1, Pillow, boto3 1.40 included.
- `ENTRYPOINT ["/lambda_entrypoint.sh","python","-m","awslambdaric"]`, `CMD ["handler.handler"]`,
  `WORKDIR /var/task`, `LAMBDA_TASK_ROOT=/var/task`.
- **`TORCH_HOME=/tmp/torch`, `HF_HOME=/tmp/huggingface`**: by default torchvision/HF download
  weights into `/tmp` at runtime. In subnets with no internet route, set `TORCH_HOME` to a
  path inside the image and download the weights in a `RUN` step. Running the image with
  `docker run --read-only --tmpfs /tmp` (CPU fallback) confirms nothing else is written.

## Pricing (ap-northeast-1, Price List API, 2026-11-19)

The management fee is a separate usage type per instance type,
`APN1-Lambda-Managed-Instances-<type>-Management-Hours`, and equals **exactly 9.75% of
the EC2 On-Demand price**: `g6.2xlarge` $1.41781 → $0.13824/h, `g5.2xlarge` $1.75776 →
$0.17138/h, `g4dn.2xlarge` $1.015 → $0.09896/h. Requests:
`APN1-Lambda-Managed-Instances-Request` $0.0000002 (same for ARM). No duration charge.
Note that `g4dn.2xlarge` is the cheapest 8-vCPU GPU type, but Lambda prefers the newest
generation in `AllowedInstanceTypes`, so cost-first setups should allow only `g4dn.*`.
