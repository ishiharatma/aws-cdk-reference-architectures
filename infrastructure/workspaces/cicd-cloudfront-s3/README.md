# CICD-CloudFront-S3 — CodePipeline-based Deployment Pipeline for a CloudFront/S3 Static Site

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## Introduction

This is a reference implementation of a **CI/CD pipeline** that builds a static site from a CodeCommit repository and deploys it to an existing S3 bucket / CloudFront distribution (such as the one in the sibling [`cloudfront-s3-static-website`](../cloudfront-s3-static-website/) workspace), using AWS CodePipeline, CodeBuild, and two purpose-built Lambda functions.

This architecture demonstrates:

- A CodeCommit → CodeBuild → CodePipeline pipeline with no hand-rolled IAM policies — every action's permissions come from CDK's own action-scoped grants
- Splitting "upload changed files" and "delete files that no longer exist in the build" into two distinct pipeline steps instead of a single `aws s3 sync --delete`
- An async CloudFront invalidation Lambda that uses the CodePipeline **continuation token** pattern to poll invalidation status without blocking a synchronous Lambda invocation
- A per-environment, opt-in manual approval gate and pipeline-result notifications, both driven by a single optional parameter
- CDK Nag (`AwsSolutionsChecks`) compliance with documented, resource-scoped suppressions

### Why this pattern?

| Feature | Benefit |
| ------- | ------- |
| No custom pipeline/build IAM roles | Every action (`CodeCommitSourceAction`, `CodeBuildAction`, `S3DeployAction`, `LambdaInvokeAction`, ...) grants itself only the specific, resource-scoped permissions it needs when bound to the pipeline — less IAM surface to review and no drift between what's granted and what's actually used |
| Upload + cleanup as separate stages | `S3DeployAction` uploads changed files; a dedicated Lambda then removes stale objects. Each step has one job, and swapping either implementation later doesn't touch the other |
| Environment-gated approval | Setting `approvalTopicArn` in an environment's parameters is the only thing needed to insert a Manual Approval stage and wire up SNS pipeline notifications — no code branching per environment |
| CDK Nag from day one | `AwsSolutionsChecks` runs in `test/compliance/cdk-nag.test.ts`; every wildcard/managed-policy finding is suppressed at the specific resource path with a written justification |

## Architecture Overview

![Architecture Overview](overview.drawio.svg)

### Key Components

| Component | Design Points |
| --------- | ------------- |
| CodeCommit repository (imported) | Referenced by name/branch via `parameters/*-params.ts`; not created by this stack |
| CodePipeline | No custom `role` — CDK auto-creates the pipeline role and grants each action's permissions as stages are added |
| CodeBuild project | Builds the static site; does **not** deploy — deployment is handled by the later pipeline stages, not the buildspec |
| `S3DeployAction` (Deploy stage) | Uploads/overwrites the build output into the deployment target bucket |
| S3 Sync Lambda (Sync stage) | Removes objects from the target bucket that no longer exist in the latest build output |
| CloudFront Invalidation Lambda (InvalidateCache stage) | Creates a CloudFront invalidation and polls it to completion using the CodePipeline continuation-token pattern |
| Manual Approval stage (optional) | Only created when `envParams.approvalTopicArn` is set |
| CodeStarNotifications rule (optional) | Only created when `envParams.approvalTopicArn` is set — `AWS::CodeStarNotifications::NotificationRule` requires at least one target, so it is never created with an empty target list |

### Data Flow

```text
CodeCommit (push to branch)
    │  EventBridge rule triggers the pipeline
    ▼
CodePipeline
  ├─ Source            : CodeCommitSourceAction → SourceOutput artifact
  ├─ Build              : CodeBuildAction (buildspec.yml) → BuildOutput artifact
  ├─ Approval (optional): ManualApprovalAction, notifies envParams.approvalTopicArn
  ├─ Deploy             : S3DeployAction → upload BuildOutput to the target bucket
  ├─ Sync               : Lambda → delete target-bucket objects not present in BuildOutput
  └─ InvalidateCache    : Lambda → CloudFront CreateInvalidation, polled via continuation token
```

### Architecture Characteristics

| Characteristic | Value | Rationale |
|---------------|-------|-----------|
| Availability | Single-region, no HA required | A CI/CD control plane; a failed pipeline run is retried, it doesn't take the site down |
| Scalability | Fully managed (CodePipeline/CodeBuild/Lambda) | No servers to scale; CodeBuild concurrency is the only limit that matters at higher build volume |
| Security | Least-privilege via CDK auto-grants, CDK Nag-checked | No hand-written wildcard IAM statements remain in the stack |
| Cost | Pay-per-use | No idle compute; cost scales with pipeline executions, not with time |

## Design Decisions & Best Practices

### 1. Let CDK grant IAM permissions per action instead of hand-rolling a pipeline role

**Decision**: The stack does not create a custom IAM role for the pipeline or the CodeBuild project.

**Rationale**:
- ✅ Each L2 action construct (`CodeCommitSourceAction`, `CodeBuildAction`, `S3DeployAction`, `LambdaInvokeAction`) grants exactly the permissions it needs, scoped to the specific resource ARN, when it is bound to a pipeline stage
- ✅ Removes an entire class of "the hand-written policy is broader than what's actually used" drift (this reference implementation originally shipped with unused `codedeploy:*` and `codestar-notifications:*` wildcard grants on the pipeline role — neither was ever used by any action in the pipeline)
- ✅ Fewer lines of IAM policy to review in PRs

**Trade-offs**:
- ❌ Less control over the exact shape of the generated role if you need to attach additional, unrelated permissions later (add a targeted `addToRolePolicy` call on `pipeline.role` only if and when you actually need it)

### 2. Separate "upload" from "cleanup" instead of one `aws s3 sync --delete`

**Decision**: The Deploy stage (`S3DeployAction`) only uploads/overwrites; a dedicated Sync Lambda stage removes stale objects afterward.

**Rationale**:
- ✅ `S3DeployAction` is a managed CodePipeline action — no custom code required for the common "upload the build" case
- ✅ The deletion logic (diffing the new build's contents against what's already in the bucket) is isolated in one Lambda, making it easy to test or replace independently
- ✅ A partial failure during upload does not risk deleting still-valid objects, since deletion only happens in the later, separate stage

**Trade-offs**:
- ❌ Two pipeline stages instead of one `aws s3 sync --delete` CLI call — slightly more moving parts than doing it all in the CodeBuild buildspec

### 3. Environment-gated approval and notifications via a single parameter

**Decision**: `EnvParams.approvalTopicArn` (optional) is the only switch. When unset, no Approval stage and no `AWS::CodeStarNotifications::NotificationRule` are created at all.

**Rationale**:
- ✅ `NotificationRule` requires at least one target in the underlying CloudFormation resource — always creating it with `targets: []` when no topic is configured would fail at deploy time, so the construct is wrapped in `if (props.envParams.approvalTopicArn)`
- ✅ Dev/test environments can skip the manual gate entirely; only environments that set `approvalTopicArn` (e.g. production) get the extra stage

**Environment-Specific Configuration**:
```typescript
// parameters/prod-params.ts
export const prodParams: EnvParams = {
  // ...
  approvalTopicArn: 'arn:aws:sns:ap-northeast-1:123456789012:prod-pipeline-approvals',
};
```

### 4. Async CloudFront invalidation via the CodePipeline continuation-token pattern

**Decision**: The invalidation Lambda does not wait synchronously for the CloudFront invalidation to complete. It creates the invalidation, returns a `continuationToken` containing the `InvalidationId`, and CodePipeline re-invokes the same Lambda to check status until it reports `Completed`.

**Rationale**:
- ✅ Avoids a long-running, polling Lambda invocation (CloudFront invalidations can take minutes)
- ✅ Each poll is a fresh, short Lambda invocation — no risk of hitting the Lambda timeout mid-poll

### 5. Well-Architected Framework Alignment

| Pillar | Implementation |
|--------|---------------|
| **Operational Excellence** | Pipeline-result notifications via SNS (opt-in), CloudWatch Logs (1-week retention, JSON structured logging) for both Lambda functions |
| **Security** | No hand-written wildcard IAM; `AwsSolutionsChecks` (CDK Nag) runs in CI with every remaining wildcard documented and justified at the specific resource path |
| **Reliability** | Managed CodePipeline/CodeBuild/Lambda — no servers to patch or fail; invalidation status is polled rather than assumed |
| **Performance Efficiency** | Serverless throughout; CodeBuild `BUILD_GENERAL1_SMALL` is sufficient for a static-site build |
| **Cost Optimization** | Pay-per-use pipeline/build/Lambda; no idle compute; 1-week log retention with `RemovalPolicy.DESTROY` |
| **Sustainability** | No idle infrastructure (no NAT Gateway, no always-on compute) |

## Cost Optimization

### Estimated Monthly Costs (ap-northeast-1, ~20 pipeline executions/month)

```
CodePipeline (V2 pricing)  :  ~$0.02/run × 20            ≈ $0.40
CodeBuild (BUILD_GENERAL1_SMALL, ~3 min/build) × 20       ≈ $0.30
Lambda (Sync + Invalidate, light invocations)             ≈ $0.05
S3 artifact bucket (few MB)                                < $0.05
CloudWatch Logs (3 log groups, 1-week retention)           < $0.05
SNS (only if approvalTopicArn is set)                       < $0.05
-------------------------------------------------------------------
Total                                                      ≈ $1/month
```

> Costs scale with pipeline executions, not with idle time — there is no compute running between deploys.

### Cost Optimization Strategies

1. **`BUILD_GENERAL1_SMALL` CodeBuild compute type**
   - Sufficient for building a static site; upgrade only if the build step becomes CPU/memory-bound
2. **1-week CloudWatch Logs retention with `RemovalPolicy.DESTROY`**
   - Avoids unbounded log storage growth for a pipeline that runs frequently
3. **No custom IAM roles**
   - Not a direct cost saving, but removes maintenance overhead that would otherwise accompany hand-rolled policies

## Security Considerations

### Security Best Practices Implemented

- ✅ No hand-written wildcard (`Resource: '*'`) IAM statements — every permission on the pipeline/build/Lambda roles is either CDK's own action-scoped auto-grant or the minimum required by an AWS API that does not support resource-level scoping (e.g. `lambda:ListFunctions`, `codepipeline:PutJobSuccessResult`)
- ✅ `NotificationRule` and the Manual Approval stage are only created when explicitly configured, avoiding invalid/empty CloudFormation resources
- ✅ Artifact bucket removal policy (`DESTROY` vs `RETAIN`) is driven by `isAutoDeleteObject`, so production stacks can be configured to retain artifacts on stack deletion

### CDK Nag Compliance

`test/compliance/cdk-nag.test.ts` runs `AwsSolutionsChecks` against the synthesized stack. Every remaining finding is suppressed with `NagSuppressions.addResourceSuppressionsByPath`, scoped to the specific resource, with a written reason — for example:

- `AwsSolutions-IAM4` (AWS managed policy) on both Lambda execution roles: `AWSLambdaBasicExecutionRole` for CloudWatch Logs write access
- `AwsSolutions-IAM5` (wildcard) on CodePipeline action roles: CDK's own auto-granted `bucket/*` object-level access and `lambda:ListFunctions`, neither of which supports narrower scoping
- `AwsSolutions-CB4`: the CodeBuild project uses the default AWS-managed encryption key rather than a customer-managed KMS key

```bash
npm test -w workspaces/cicd-cloudfront-s3 -- test/compliance
```

## Prerequisites

- AWS Account with appropriate permissions
- AWS CLI v2.x installed and configured
- Node.js 20.x or later
- AWS CDK 2.x
- Git
- An existing CodeCommit repository (see [`parameters/dev-params.ts`](./parameters/dev-params.ts) for the expected `repositoryName`/`repositoryBranch`)
- An existing S3 bucket / CloudFront distribution to deploy to (e.g. the [`cloudfront-s3-static-website`](../cloudfront-s3-static-website/) workspace)

### Required IAM Permissions

The deploying user/role needs permissions to create/manage:
- CodePipeline, CodeBuild
- Lambda, IAM (roles/policies for the above)
- S3 (artifact bucket)
- CodeStarNotifications, SNS (only if `approvalTopicArn` is configured)

## Deployment Guide

### 1. Clone and Setup

```bash
git clone <this-repository>
cd infrastructure
npm install
```

### 2. Configure Environment Parameters

Edit [`parameters/dev-params.ts`](./parameters/dev-params.ts) (or add a new `*-params.ts` and register it in [`parameters/index.ts`](./parameters/index.ts)):

```typescript
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  repositoryName: 'my-repo',
  repositoryBranch: 'main',
  deploymentTargetBucketName: 'my-deployment-bucket',
  cloudfrontDistributionId: 'EXXXXXXXXXXXXX',
  // approvalTopicArn: 'arn:aws:sns:...', // optional — enables Approval stage + notifications
};
```

### 3. Deploy

```bash
export PROJECT_NAME=your-project
export ENV=dev

npm run bootstrap   # first time only
npm run diff -- --project=$PROJECT_NAME --env=$ENV
npm run deploy:all -- --project=$PROJECT_NAME --env=$ENV
```

### 4. Verify Deployment

```bash
# Trigger a pipeline run by pushing to the configured branch, then check status:
aws codepipeline get-pipeline-state --name <project>-<env>-pipeline
```

## Testing Strategy

### Test Structure

```
test/
├── compliance/
│   └── cdk-nag.test.ts     # AwsSolutionsChecks with resource-scoped suppressions
├── snapshot/
│   └── snapshot.test.ts    # Full template + resource-count snapshots
└── unit/
    └── cicd-cloudfront-s3.test.ts   # Resource/behavior assertions
```

### 1. Snapshot Tests

**Purpose**: Detect unintended changes to the synthesized CloudFormation template across refactors.

```bash
npm run test:snapshot -w workspaces/cicd-cloudfront-s3
```

### 2. Unit Tests

**Purpose**: Assert on specific resources and behavior rather than the whole template.

**Test Categories** (14 tests):
- ✅ Core resource counts (pipeline, build project, Lambda functions, artifact bucket)
- ✅ Lambda runtime (Python 3.14)
- ✅ Pipeline stage order, with and without `approvalTopicArn` configured
- ✅ Conditional `NotificationRule` creation
- ✅ Regression guard against reintroducing the `codedeploy:*` wildcard IAM statement
- ✅ Artifact bucket removal policy (`DESTROY` vs `RETAIN`)

```bash
npm test -w workspaces/cicd-cloudfront-s3 -- test/unit
```

### CI/CD Integration

```bash
npm test -w workspaces/cicd-cloudfront-s3
```

## Customization

### Adding a build step

Edit the `buildSpec` in [`lib/stacks/cicd-cloudfront-s3-stack.ts`](./lib/stacks/cicd-cloudfront-s3-stack.ts) (or the referenced `buildspec.yml`) — the Build stage only produces the `BuildOutput` artifact; it does not deploy.

### Enabling the Approval stage

```typescript
// parameters/prod-params.ts
approvalTopicArn: 'arn:aws:sns:ap-northeast-1:123456789012:prod-pipeline-approvals',
```

## Troubleshooting

### Issue: Stack fails to synthesize with a dependency cycle error

**Symptoms**: `Template is undeployable, these resources have a dependency cycle: ... -> PipelineXXXX -> PipelineXXXX`

**Solutions**:
1. Check whether any pipeline stage's action configuration references `pipeline.pipelineName` (or any other `Ref`/`Fn::GetAtt` back to the `Pipeline` construct) from *inside* an action that is itself a stage of that same pipeline
2. Use a plain string (computed before the `Pipeline` is constructed) instead of the token — this is exactly why `pipelineName` is a local `const` reused in the InvalidateCache Lambda's `userParameters` rather than `pipeline.pipelineName`

### Issue: Artifact bucket fails to deploy with `InvalidBucketNameValue`

**Symptoms**: `Bucket name must only contain lowercase characters...`

**Solutions**:
1. Ensure `props.project` doesn't rely on being lowercase elsewhere — the bucket name is explicitly lowercased (`.toLowerCase()`) since S3 bucket names must be lowercase regardless of the project name's casing

## References

### AWS Documentation
- [AWS CodePipeline User Guide](https://docs.aws.amazon.com/codepipeline/latest/userguide/welcome.html)
- [AWS CodeCommit User Guide](https://docs.aws.amazon.com/codecommit/latest/userguide/welcome.html)
- [AWS CodeBuild User Guide](https://docs.aws.amazon.com/codebuild/latest/userguide/welcome.html)

### AWS Well-Architected
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)

### AWS CDK
- [aws-codepipeline-actions module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_codepipeline_actions-readme.html)
- [CDK Nag](https://github.com/cdklabs/cdk-nag)

### Related Architectures
- [`cloudfront-s3-static-website`](../cloudfront-s3-static-website/) — the CloudFront/S3 static site this pipeline deploys to

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](../../../LICENSE) file for details.

## 👥 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](../../../docs/contribution/CONTRIBUTING.md) for details.

## 🏆 About This Reference Architecture

This reference architecture demonstrates AWS CDK best practices for building production-ready CI/CD infrastructure.

**Target Level**: 300 (Advanced)

---

**Note**: This is a reference implementation. Always review and customize according to your specific requirements and organizational policies before deploying to production.
