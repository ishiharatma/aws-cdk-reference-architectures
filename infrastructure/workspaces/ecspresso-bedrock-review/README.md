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
| Test / Build CodeBuild projects | `npm test`; `docker build` → Trivy scan (JSON output, `--exit-code 1` on HIGH/CRITICAL, blocking) → ASFF conversion (`scripts/sechub_parser.py`) → ECR push (`imagedefinitions.json`, `image-tag.txt`) |
| AgenticReview CodeBuild project | Re-clones CodeCommit with full history (`CodeCommitSourceAction` only hands over a snapshot) to compute `git diff`, then runs `scripts/agentic-review.js` against Bedrock. Publishes an `AgenticReviewOutput` pipeline artifact and, optionally, an SNS notification — see "Where to find the review result" below |
| Deploy CodeBuild project | Resolves ECS cluster/service/role/network settings from SSM, then `ecspresso render` only (no `verify`/`deploy` — see below) |
| SSM parameters (`/<project>/<env>/ecs/*`) | Created by `PipelineStack` as placeholders (`REPLACE_ME`); overwrite with real values if you point this at an actual ECS cluster |

## Where to find the review result

- **CodeBuild logs** (always available): the AgenticReview CodeBuild
  project's log group (`/<project>/<env>/codebuild/agentic-review`, 1-month
  retention) has the full `=== Agentic Code Review Report ===` output —
  per-perspective risk level, summary, and findings.
- **Pipeline artifact** `AgenticReviewOutput`: the `AgenticReview` action
  now publishes `agentic-review-report.json` as a CodePipeline artifact (via
  `outputs: [reviewOutput]`), so it survives past the CodeBuild run and can
  be pulled from the pipeline's S3 artifact bucket for any past execution —
  previously this JSON was written to CodeBuild's throwaway workspace and
  lost the moment the build finished, even though `buildspec-review.yml`
  had an `artifacts:` block for it (the `CodeBuildAction` had no matching
  `outputs`, so CodePipeline never uploaded it).
- **SNS notification** (opt-in, see below): the only way to put the result
  in front of a human *before* the Approve stage, since
  `ManualApprovalAction.additionalInformation` is a static string baked
  into the CloudFormation template and can't carry a per-run value.

### Notifying a human of the review result (`reviewNotificationEnabled`)

Set `EnvParams.reviewNotificationEnabled: true` (→ CodeBuild env var
`REVIEW_NOTIFICATION_ENABLED=true`) to have the AgenticReview stage publish
its summary to SNS right after the review completes:

```typescript
// parameters/dev-params.ts
reviewNotificationEnabled: true, // publish the review summary to SNS before Approve
```

- **Topic**: `approvalTopicArn` if set (most likely to reach whoever acts on
  the Approve stage), otherwise the pipeline's own failure-notification
  topic (`NotificationTopic`).
- **Default: `false`** — the summary is only in the CodeBuild logs and the
  `AgenticReviewOutput` artifact; nothing is published.
- A publish failure (e.g. misconfigured topic) is logged and never fails
  the build — it's a convenience layer, not the source of truth for the
  risk decision (that's still the `RISK_THRESHOLD` exit-code check).

## Measuring the review's effect over time

"We added an AI review gate" is just an anecdote until you can see how
often it fires, on what, and at what cost. `agentic-review.js` publishes
CloudWatch metrics to the namespace `<project>/<env>/AgenticReview` after
every run (this is always on — it's pure observability, nothing external
is affected, unlike the SNS/Security Hub toggles above):

| Metric | Dimensions | What it tells you |
| --- | --- | --- |
| `OverallRiskLevel` | `RiskLevel` | Distribution of overall risk levels over time |
| `Blocked` | — | How often the gate actually blocks a deploy (`Sum` = block count) |
| `PerspectiveRiskLevel` | `Perspective`, `RiskLevel` | Which perspective (security/infra/quality/cost) is driving risk |
| `PerspectiveError` | `Perspective` | Bedrock call reliability per perspective (throttling, malformed output, etc.) |
| `BedrockLatency` | `Perspective` | How long each perspective's Bedrock call takes — is this stage a pipeline bottleneck? |
| `BedrockInputTokens` / `BedrockOutputTokens` | `Perspective` | Token usage per perspective — the basis for estimating Bedrock cost |

All dimensioned also by `Project` and `Environment`. `PipelineStack`
creates an `AgenticReviewDashboard` CloudWatch dashboard
(`<project>-<env>-agentic-review`) charting all of the above. A metrics
publish failure is logged and never fails the build, same as the SNS
notification.

**Deliberately not included** (see the discussion that led here for the
full reasoning): a feedback loop that records when a human overrides a
block as a false positive (would need a Lambda between Approve and a
place to store the verdict — the piece that would most improve review
precision over time, but too much machinery for this sample), and
long-term storage of review results in DynamoDB/S3 for audit purposes
(the artifact bucket here is `isAutoDeleteObject: true` and not meant to
retain history — a real audit requirement should get its own storage
decision, not one bolted onto a sample).

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

## desiredCount vs. Application Auto Scaling

`ecs-service-def.jsonnet` writes `desiredCount` from the `DESIRED_COUNT` env
var (default `1` in this sample — fine for a service with no Auto Scaling).
**If the target ECS service has Application Auto Scaling configured, do not
leave this as-is.**

Verified against ecspresso's own source (`ecspresso.go` / `deploy.go`,
`calcDesiredCount()`): `ecspresso deploy` reads `desiredCount` from the
service definition on every run and passes it straight to `UpdateService`.
If it's a fixed number, that number silently overwrites whatever count Auto
Scaling had scaled to — every deploy resets your service back to `1` (or
whatever `DESIRED_COUNT` is), fighting Auto Scaling. There is no
`ignore: desiredCount`-style escape hatch in ecspresso's config (`ignore:`
only covers tags) — the only way to leave the running count alone is for
the service definition to **not include the `desiredCount` key at all**;
`ecspresso` then omits `DesiredCount` from `UpdateService`, and AWS leaves
the current (Auto-Scaled) count untouched.

This workspace makes that switchable: set `EnvParams.autoScalingEnabled: true`
(→ CodeBuild env var `AUTO_SCALING_ENABLED=true`) and
`ecs-service-def.jsonnet` omits `desiredCount` entirely via a computed
field name:

```jsonnet
local autoScalingEnabled = env('AUTO_SCALING_ENABLED', 'false') == 'true';
{
  [if !autoScalingEnabled then 'desiredCount']: std.parseInt(env('DESIRED_COUNT', '1')),
  ...
}
```

```typescript
// parameters/dev-params.ts
autoScalingEnabled: true, // target service has Application Auto Scaling — deploy must not touch desiredCount
```

## Trivy findings → Security Hub (ASFF), gated by an env var

`buildspec-build.yml` runs Trivy with `--format json` and converts the
result to [AWS Security Finding Format (ASFF)](https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-findings-format.html)
via `scripts/sechub_parser.py` — modeled on the AWS Security Blog's
[*How to build a CI/CD pipeline for container vulnerability scanning with
Trivy and AWS Security Hub*](https://aws.amazon.com/blogs/security/how-to-build-ci-cd-pipeline-container-vulnerability-scanning-trivy-and-aws-security-hub/)
and its reference script,
[`aws-samples/aws-security-hub-scan-with-trivy`](https://github.com/aws-samples/aws-security-hub-scan-with-trivy),
adapted for the current Trivy JSON shape (`Results[].Vulnerabilities[]`).

Whether the converted findings are actually sent to Security Hub is
controlled by `EnvParams.securityHubImportEnabled` (`SECURITYHUB_IMPORT_ENABLED`
env var):

- `false` (default): findings are converted to ASFF and logged to stdout
  only — nothing is sent to Security Hub
- `true`: findings are sent via `securityhub:BatchImportFindings` (chunked
  at 100 per request)

This toggle is independent of the HIGH/CRITICAL build-blocking check above
— Trivy's `--exit-code` still fails the build either way.

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

### Switching the review's output language

The review's `summary`/`findings` language is controlled by
`EnvParams.reviewLanguage` (`en` | `ja`, default `en`), passed through as
the CodeBuild `REVIEW_LANGUAGE` environment variable:

```typescript
// parameters/dev-params.ts
reviewLanguage: 'ja', // review summary/findings are written in Japanese instead of English
```

This also switches the language of the review-perspective labels
(security/infra/quality/cost) and the prompt sent to Bedrock — see
`PERSPECTIVES_BY_LANGUAGE` / `PROMPT_TEXT_BY_LANGUAGE` in
`scripts/agentic-review.js`.

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
- ✅ Security Hub findings are only sent when `securityHubImportEnabled` is
  explicitly `true`; by default the pipeline never calls
  `BatchImportFindings`, only logs the converted ASFF
- ✅ `AgenticReview`'s CodeBuild role is scoped to `codecommit:GitPull` on
  this one repository ARN and `bedrock:InvokeModel` on foundation-model /
  inference-profile ARNs in this region only
- ✅ `Deploy`'s CodeBuild role can only `ssm:GetParameter` under this
  project/environment's own SSM path (`/${project}/${env}/ecs/*`)
- ✅ Artifact bucket blocks all public access and enforces SSL; the SNS
  notification topic enforces SSL (`enforceSSL: true`)
- ✅ `AgenticReview`'s `sns:Publish` grant is scoped to the exact
  notification/approval topic ARN it publishes to, not `*`
- ✅ `AgenticReview`'s `cloudwatch:PutMetricData` grant has no resource-level
  ARN to scope to (CloudWatch metrics don't have one), so it's restricted
  with a `cloudwatch:namespace` condition to `metricsNamespace` instead
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
reviewNotificationEnabled: true, // recommended alongside requireManualApproval, so approvers see the review before deciding
```

### Enabling Security Hub import

```typescript
// parameters/dev-params.ts
securityHubImportEnabled: true, // or: process.env.SECURITYHUB_IMPORT_ENABLED === 'true'
```

Before findings will actually appear in Security Hub, also run (once, per
account/region):

```bash
aws securityhub enable-import-findings-for-product \
  --product-arn arn:aws:securityhub:ap-northeast-1::product/aquasecurity/aquasecurity
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
- [How to build a CI/CD pipeline for container vulnerability scanning with Trivy and AWS Security Hub](https://aws.amazon.com/blogs/security/how-to-build-ci-cd-pipeline-container-vulnerability-scanning-trivy-and-aws-security-hub/)
- [AWS Security Finding Format (ASFF) syntax](https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-findings-format-syntax.html)
- [Using condition keys to limit access to CloudWatch namespaces](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/iam-cw-condition-keys-namespace.html)

### Related Tools
- [ecspresso](https://github.com/kayac/ecspresso) — ECS deployment tool
- [go-jsonnet](https://github.com/google/go-jsonnet) — jsonnet implementation used by ecspresso
- [aws-samples/aws-security-hub-scan-with-trivy](https://github.com/aws-samples/aws-security-hub-scan-with-trivy) — reference `sechub_parser.py` this workspace's version is adapted from

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
