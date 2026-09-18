# Ecspresso-Bedrock-Review — ECS Fargate CI/CD with an Amazon Bedrock Agentic Code Review Gate

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## Introduction

This is a reference implementation of a **CodePipeline CI/CD pipeline for an
ECS Fargate application, gated by an Amazon Bedrock "agentic" code review
stage**, inspired by the multi-agent review step in OpenAI's internal
"agentic software factory" diagram. A pseudo multi-agent reviewer (four
Bedrock calls run in parallel, one per review perspective) inspects the
`git diff` of every push and blocks the pipeline when the aggregated risk
level is too high.

The sample application is deployed with [ecspresso](https://github.com/kayac/ecspresso)
using **jsonnet** task/service definitions. **This workspace has no real ECS
cluster/service** — the Deploy stage stops at `ecspresso render` (a local,
AWS-API-free command) and does not run `ecspresso verify` / `ecspresso
deploy`.

### What this demonstrates

- A `git diff`-driven **Agentic Code Review** stage on Amazon Bedrock:
  four perspectives (security / infra / quality / cost) are reviewed in
  parallel (`Promise.all`), each returning a JSON risk verdict; the highest
  risk level wins
- **Blocking gate**: when the aggregated risk level is at or above
  `RISK_THRESHOLD` (default `high`), the CodeBuild project exits non-zero
  and the pipeline stops — matching the diagram's "risk classification"
  branch
- **Swappable review model**: the Bedrock model ID is a CodeBuild
  environment variable (`BEDROCK_MODEL_ID`, from `EnvParams.bedrockModelId`)
  — switching models never requires a code change
- **ecspresso + jsonnet** deploy definitions (`ecspresso.jsonnet`,
  `ecs-task-def.jsonnet`, `ecs-service-def.jsonnet`) that resolve the ECS
  cluster/service name via SSM Parameter Store at build time
  (`std.native('env')` / `must_env()`)
- `buildspec-test.yml` / `buildspec-build.yml` / `buildspec-review.yml` /
  `buildspec-deploy.yml` living inside the sample app
  (`backend/ecspresso-bedrock-review-app/`), one per pipeline stage

## Architecture Overview

```text
Source(CodeCommit) ─▶ Test ─▶ Build ─▶ AgenticReview(Bedrock) ─▶ [Approve*] ─▶ Deploy(ecspresso)
                                              │
                                              ├─ security  ─┐
                                              ├─ infra      ─┤  Promise.all → aggregate
                                              ├─ quality    ─┤  (highest riskLevel wins)
                                              └─ cost       ─┘
                                              risk >= RISK_THRESHOLD ⇒ CodeBuild fails (blocking)
```

`*` Approve is inserted only when `EnvParams.requireManualApproval` is `true`.

### Key Components

| Component | Design Points |
| --------- | ------------- |
| CodeCommit repository (`RepositoryStack`) | Seeded from `backend/ecspresso-bedrock-review-app/` on `develop` |
| Test / Build CodeBuild projects | `npm test`; `docker build` → Trivy scan (`--exit-code 1` on HIGH/CRITICAL, blocking) → ECR push (`imagedefinitions.json`, `image-tag.txt`) |
| AgenticReview CodeBuild project | Re-clones CodeCommit with full history (`CodeCommitSourceAction` only hands over a snapshot) to compute `git diff`, then runs `scripts/agentic-review.js` against Bedrock |
| Deploy CodeBuild project | Resolves ECS cluster/service/role/network settings from SSM, then `ecspresso render` only (no `verify`/`deploy` — see below) |
| SSM parameters (`/<project>/<env>/ecs/*`) | Created by `PipelineStack` as placeholders (`REPLACE_ME`); overwrite with real values if you point this at an actual ECS cluster |

## Why `ecspresso verify` / `ecspresso deploy` are not run

This workspace has no companion ECS cluster/service stack, so
`buildspec-deploy.yml` only runs `ecspresso render <config|task-def|service-def>`
— a purely local operation that makes no AWS API calls, used here to
validate the jsonnet definitions render correctly. `ecspresso verify` (checks
cluster/role/image/log-group existence) and `ecspresso deploy` (registers a
task definition and updates the service) both call AWS APIs against
resources that don't exist in this sample and are therefore commented out.
If you wire this pipeline to a real ECS cluster, uncomment the two lines
marked in `buildspec-deploy.yml`.

## Switching the Bedrock review model

Edit `parameters/dev-params.ts` (or override with the `BEDROCK_MODEL_ID`
env var at synth time):

```typescript
// parameters/dev-params.ts
bedrockModelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
riskThreshold: 'high', // low | medium | high | critical — minimum level that blocks the pipeline
```

The value is passed straight through to the `AgenticReview` CodeBuild
project as the `BEDROCK_MODEL_ID` environment variable — no code change is
needed to try a different model (e.g. a cross-region inference profile ID).

## Prerequisites

- An AWS account with Amazon Bedrock model access enabled for the model you
  configure in `bedrockModelId`
- AWS CLI v2.x installed and configured
- Node.js 20.x or later
- AWS CDK 2.x

### Required IAM Permissions

The deploying user/role needs permissions to create/manage: CodeCommit,
CodePipeline, CodeBuild, ECR, IAM, S3 (artifact bucket), SSM Parameter
Store, SNS, EventBridge.

## Deployment Guide

```bash
export PROJECT=myproject
export ENV=dev
npm run bootstrap -w workspaces/ecspresso-bedrock-review    # first time only
npm run stage:deploy:all -w workspaces/ecspresso-bedrock-review -- --project=$PROJECT --env=dev
```

### Exercise the pipeline

```bash
# repositoryName defaults to "ecspresso-bedrock-review-app" (parameters/shared-params.ts)
git clone codecommit::ap-northeast-1://ecspresso-bedrock-review-app
cd ecspresso-bedrock-review-app
git checkout develop
git commit --allow-empty -m "trigger pipeline"
git push origin develop
```

## Testing Strategy

```
test/
├── compliance/
│   └── cdk-nag.test.ts          # AwsSolutionsChecks with resource-scoped suppressions
├── snapshot/
│   └── snapshot.test.ts         # Full template snapshots for RepositoryStack + PipelineStack
└── unit/
    ├── repository-stack.test.ts
    └── pipeline-stack.test.ts   # Stage order, AgenticReview env vars/IAM, Approve toggle
```

```bash
npm test -w workspaces/ecspresso-bedrock-review
```

The sample application has its own tests:

```bash
cd backend/ecspresso-bedrock-review-app
npm test
```

## Security Considerations

- ✅ `Build`'s Trivy scan blocks the push to ECR when a HIGH/CRITICAL
  vulnerability is found in the image (`--exit-code 1`)
- ✅ `AgenticReview`'s CodeBuild role is scoped to `codecommit:GitPull` on
  this one repository ARN and `bedrock:InvokeModel` on foundation-model /
  inference-profile ARNs in this region only
- ✅ `Deploy`'s CodeBuild role can only `ssm:GetParameter` under this
  project/environment's own SSM path (`/${project}/${env}/ecs/*`)
- ✅ Artifact bucket blocks all public access and enforces SSL; the SNS
  notification topic enforces SSL (`enforceSSL: true`)
- ✅ `AwsSolutionsChecks` (CDK Nag) runs in `test/compliance/`; every
  remaining wildcard/managed-policy finding is suppressed with a written
  reason (see `lib/stacks/pipeline-stack.ts`)
- ⚠️ A model-generated review is a *gate*, not a substitute for human
  review — it can miss issues or misjudge risk. Keep `requireManualApproval:
  true` in front of any environment that matters.

## Customization

### Pointing this at a real ECS cluster

1. Deploy your own ECS/VPC stack and note the cluster name, service name,
   task/execution role ARNs, subnet IDs, security group IDs, and (if any)
   target group ARN.
2. Overwrite the SSM parameters `PipelineStack` creates
   (`/${project}/${env}/ecs/*`) with those real values — or remove the
   placeholder `ssm.StringParameter` block in `lib/stacks/pipeline-stack.ts`
   and manage them in your ECS stack instead.
3. Add the corresponding `ecspresso:*`, `iam:PassRole`, `ecr:Describe*`,
   `elasticloadbalancing:Describe*` permissions to `DeployProject` (see
   `infrastructure/common/constructs/cicd/ecs-fargate-cicd.ts` in this repo
   for the full permission set an `ecspresso verify`/`deploy` needs).
4. Uncomment the `ecspresso verify` / `ecspresso deploy` lines in
   `backend/ecspresso-bedrock-review-app/buildspec-deploy.yml`.

### Enabling manual approval

```typescript
// parameters/dev-params.ts
requireManualApproval: true,
approvalTopicArn: 'arn:aws:sns:ap-northeast-1:111111111111:ecspresso-bedrock-review-dev-approvals',
```

### Adjusting the review perspectives

Edit the `PERSPECTIVES` array in
`backend/ecspresso-bedrock-review-app/scripts/agentic-review.js` to add,
remove, or reword the reviewed perspectives (security/infra/quality/cost by
default).

## References

### AWS Documentation
- [AWS CodePipeline User Guide](https://docs.aws.amazon.com/codepipeline/latest/userguide/welcome.html)
- [AWS CodeBuild User Guide](https://docs.aws.amazon.com/codebuild/latest/userguide/welcome.html)
- [Amazon Bedrock Runtime — Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)

### Related Tools
- [ecspresso](https://github.com/kayac/ecspresso) — ECS deployment tool
- [go-jsonnet](https://github.com/google/go-jsonnet) — jsonnet implementation used by ecspresso

### Related Architectures
- [`cicd-codecommit-cross-account`](../cicd-codecommit-cross-account/) — the CodeCommit → CodePipeline scaffolding this workspace is based on
- `infrastructure/common/constructs/cicd/ecs-fargate-cicd.ts` — the full `ecspresso verify`/`deploy` IAM permission set for a real cluster

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](../../../LICENSE) file for details.

## 👥 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](../../../docs/contribution/CONTRIBUTING.md) for details.

---

**Note**: This is a reference implementation with no real ECS cluster
attached. Always review and customize according to your specific
requirements and organizational policies before deploying to production.
