# ecspresso-bedrock-review-app

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

Sample Node.js API meant to run on ECS Fargate. Built on top of
`example-nodejs-api`, with a full set of buildspec files invoked from
CodePipeline, a script for Amazon Bedrock-powered Agentic Code Review, and
ecspresso (jsonnet) deploy definitions added.

The matching CDK pipeline definition lives at
[`infrastructure/workspaces/ecspresso-bedrock-review`](../../infrastructure/workspaces/ecspresso-bedrock-review).

## Directory layout

```
.
├── src/                      the app itself (Express)
├── scripts/agentic-review.js pseudo multi-agent code review powered by Bedrock
├── scripts/sechub_parser.py  converts Trivy JSON results to ASFF (sending to Security Hub is gated by an env var)
├── ecspresso/                ecspresso config (jsonnet); cluster/service are resolved via SSM
├── buildspec-test.yml        Test stage: npm ci && npm test
├── buildspec-build.yml       Build stage: docker build -> Trivy scan -> ASFF conversion -> ECR push
├── buildspec-review.yml      Agentic Review stage: reviews the git diff with Bedrock
└── buildspec-deploy.yml      Deploy stage: ecspresso render (verify/deploy are not run)
```

## Pipeline flow

```
Source(CodeCommit) -> Test -> Build -> AgenticReview(Bedrock) -> [Approve*] -> Deploy(ecspresso)
```

The `AgenticReview` stage fails the CodeBuild project (blocking the
pipeline) when the overall risk level computed by `scripts/agentic-review.js`
is at or above `RISK_THRESHOLD` (default `high`).

## Where to find the review result

- CodeBuild logs (`AgenticReview` project) always have the full report.
- The `AgenticReviewOutput` pipeline artifact carries
  `agentic-review-report.json` past the end of the CodeBuild run.
- Optionally (`REVIEW_NOTIFICATION_ENABLED=true`), `agentic-review.js`
  publishes the summary to an SNS topic (`REVIEW_NOTIFICATION_TOPIC_ARN`)
  right after the review completes -- this is the only way to surface the
  result to a human *before* a manual-approval stage decides whether to
  deploy, since CodePipeline's `ManualApprovalAction.additionalInformation`
  is a static string that can't carry a per-run value. A publish failure is
  logged but never fails the build. Default: `false`. See the CDK-side
  README's "Where to find the review result" section for the full picture
  (including topic selection and how the artifact gets there).

## Switching the Bedrock model

The model used by Agentic Review is switched via the CodeBuild environment
variable `BEDROCK_MODEL_ID` (specified per stage through a CDK Construct
property) -- no code change required.

The language the review's `summary`/`findings` are written in is switched
the same way, via `REVIEW_LANGUAGE` (`en` | `ja`, default `en`; see
`EnvParams.reviewLanguage` on the CDK side, or `PERSPECTIVES_BY_LANGUAGE` /
`PROMPT_TEXT_BY_LANGUAGE` in `scripts/agentic-review.js`).

## Trivy scan results -> Security Hub (ASFF conversion)

The Build stage in `buildspec-build.yml` runs Trivy with JSON output
(`--format json`) and converts the result to
[AWS Security Finding Format (ASFF)](https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-findings-format.html)
via `scripts/sechub_parser.py` (reference:
[How to build a CI/CD pipeline for container vulnerability scanning with Trivy and AWS Security Hub](https://aws.amazon.com/blogs/security/how-to-build-ci-cd-pipeline-container-vulnerability-scanning-trivy-and-aws-security-hub/);
implementation adapted from
[aws-samples/aws-security-hub-scan-with-trivy](https://github.com/aws-samples/aws-security-hub-scan-with-trivy)'s
`sechub_parser.py` for the current Trivy JSON shape
(`Results[].Vulnerabilities[]`)).

Whether findings are actually sent to Security Hub (`BatchImportFindings`)
is controlled by the `SECURITYHUB_IMPORT_ENABLED` environment variable:

- `false` (default): the converted ASFF findings are only logged to stdout;
  nothing is sent to Security Hub
- `true`: findings are actually sent via `securityhub:BatchImportFindings`
  (chunked at 100 per request)

The build-failing check for HIGH/CRITICAL vulnerabilities (Trivy's
`--exit-code`) always runs regardless of `SECURITYHUB_IMPORT_ENABLED` --
it's independent of whether the ASFF conversion/import succeeds.

## Note: desiredCount and Application Auto Scaling

By default, `ecs-service-def.jsonnet` writes `DESIRED_COUNT` (default `1`)
as `desiredCount`. **Do not leave this as-is if the target ECS service has
Application Auto Scaling configured.** `ecspresso deploy` passes the
service definition's `desiredCount` straight through to `UpdateService` on
every run, so a fixed value overwrites whatever count Auto Scaling has
scaled to on every deploy. Passing `AUTO_SCALING_ENABLED=true` makes
`ecs-service-def.jsonnet` omit the `desiredCount` field entirely, so
ecspresso stops passing `DesiredCount` to `UpdateService` (i.e. the current
value Auto Scaling set is left untouched). See the "desiredCount vs.
Application Auto Scaling" section of the CDK-side README, and the comment
at the top of `ecspresso/ecs-service-def.jsonnet`, for details.

## Note: about ecspresso verify / deploy

This repository has no companion ECS cluster/service, so
`buildspec-deploy.yml` never runs `ecspresso verify` / `ecspresso deploy`
(both call AWS APIs); it only runs `ecspresso render`, a purely local
operation, to confirm the jsonnet definitions render correctly. If you use
this against an environment with a real cluster, uncomment the
`ecspresso verify` / `ecspresso deploy` lines in `buildspec-deploy.yml`.
