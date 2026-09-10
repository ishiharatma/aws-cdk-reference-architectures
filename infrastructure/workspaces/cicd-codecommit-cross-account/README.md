# CICD-CodeCommit-Cross-Account — Cross-Account CI/CD Pipeline from a Single CodeCommit Repository

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## Introduction

This is a reference implementation of a **cross-account CI/CD pipeline** built
entirely with AWS CodePipeline and CodeBuild, sourced from a single AWS
CodeCommit repository in a dev account, with **each environment's pipeline
deployed into its own account** (dev / stg / prd).

This architecture demonstrates:

- A single CodeCommit repository, created in the dev account, with three
  long-lived branches (`develop` / `staging` / `main`) auto-created from the
  same initial commit
- Three independent CodePipelines, **each deployed into its own account**
  (dev/stg/prd) — the pipeline lives next to whatever it deploys, not
  centralized in the dev account
- The cross-account hop happens only at the **Source** stage: the stg/prd
  pipelines' `CodeCommitSourceAction` assumes a fixed-name IAM role created
  in the dev account for exactly that purpose
- Since CodeCommit only emits push events in the account that owns the
  repository, the dev account **forwards** each branch's push events to the
  matching account's default EventBridge bus, where that account's own rule
  starts its pipeline
- `dev-params` / `stg-params` / `prd-params` for per-environment
  configuration and a `shared-params` for values that don't vary by
  environment — except the CodeCommit account ID, which is intentionally
  read from an environment variable instead of being hard-coded, since this
  is a public repository

### Why this pattern?

| Feature | Benefit |
| ------- | ------- |
| Pipeline deployed next to what it deploys | Test/Build/Deploy all run in the same account as the resources they touch — no cross-account `AssumeRole` needed anywhere except reading the source |
| Cross-account hop isolated to Source | Only `CodeCommitSourceAction` crosses accounts; a fixed-name role (`<project>-pipeline-source-action-<accountId>`) in the dev account is the only thing stg/prd need to trust |
| Explicit event forwarding | CodeCommit events never leave the dev account on their own — `RepositoryStack` forwards each branch's push events to the matching account's own default event bus, where a plain EventBridge rule starts that account's pipeline |
| Fixed-name IAM roles | The Source-action role (dev account) and each account's pipeline role are both named deterministically, so the trust relationship between them is a plain ARN string — no cross-account CloudFormation exports needed |

## Architecture Overview

![Architecture Overview](overview.drawio.svg)

### Key Components

| Component | Design Points |
| --------- | ------------- |
| CodeCommit repository (dev account, `RepositoryStack`) | Created by this stack, seeded with `sample-app/` on `main`; `develop`/`staging` are created from that same commit via `AwsCustomResource` |
| Source-action role (dev account, one per stg/prd) | `<project>-pipeline-source-action-<accountId>`, trusted only by that account's own pipeline role; grants `codecommit:GitPull` and friends scoped to this one repository |
| Event-forwarding rule (dev account, one per stg/prd) | Forwards `referenceCreated`/`referenceUpdated` events for that branch onto the target account's default event bus |
| CodePipeline (dev/stg/prd, `PipelineStack`, one per account) | `<project>-<env>-pipeline`: Source → Test → Build → [Approve] → Deploy, entirely within that account |
| EventBusPolicy + trigger rule (stg/prd) | Authorizes the dev account to `PutEvents` on this account's default bus, then a rule reacts to the forwarded event to start this account's pipeline |
| KMS key on the artifact bucket (stg/prd only) | A cross-account `CodeCommitSourceAction` requires the artifact bucket to use a customer-managed key so CodePipeline can grant the dev account's source-action role decrypt access |

### Data Flow

```text
Dev account                              Stg account            Prd account
┌─────────────────────────────┐          ┌──────────────────┐   ┌──────────────────┐
│ CodeCommit repo              │          │                  │   │                  │
│  (develop/staging/main)      │          │                  │   │                  │
│                               │          │                  │   │                  │
│ push → forward event ────────┼─────────►│ default event bus│   │ default event bus│
│         (staging branch)     │          │  → trigger rule  │   │  → trigger rule  │
│ push → forward event ─────────────────────────────────────────►│                  │
│         (main branch)        │          │        │         │   │        │         │
│                               │          │        ▼         │   │        ▼         │
│ push (develop) → local rule  │          │  <project>-stg-   │   │  <project>-prd-   │
│        │                     │          │  pipeline         │   │  pipeline         │
│        ▼                     │          │  Source ◄─assume─┼───┼── role in dev    │
│ <project>-dev-pipeline       │          │  (cross-account)  │   │  account         │
│  Source (same account)       │          │  Test→Build→Deploy│   │  Test→Build→Deploy│
│  Test→Build→Deploy           │          │  (same account)   │   │  (same account)   │
└─────────────────────────────┘          └──────────────────┘   └──────────────────┘
```

### Architecture Characteristics

| Characteristic | Value | Rationale |
|---------------|-------|-----------|
| Availability | Single-region, no HA required | A CI/CD control plane; a failed pipeline run is retried, it doesn't take an application down |
| Scalability | Fully managed (CodePipeline/CodeBuild) | No servers to scale; CodeBuild concurrency is the only limit that matters at higher build volume |
| Security | Cross-account access limited to reading the source; no cross-account role for Test/Build/Deploy | Blast radius of a compromised pipeline role is contained to its own account |
| Cost | Pay-per-use | No idle compute; cost scales with pipeline executions, not with time |

## Design Decisions & Best Practices

### 1. The pipeline lives in the same account as what it deploys

**Decision**: `PipelineStack` is deployed once per environment, into that
environment's own account. Only the Source stage (`CodeCommitSourceAction`)
crosses accounts for stg/prd; Test, Build, and Deploy all run locally.

**Rationale**:
- ✅ Deploy's CodeBuild project can act on that account's resources directly
  — no `sts:AssumeRole` hop, no fixed-name deploy role to keep in sync
- ✅ Blast radius: a compromised pipeline role in stg can't reach prd, and
  vice versa — each pipeline only has permissions in its own account
- ✅ Matches how CodeCommit-sourced pipelines are typically built when the
  source repo and the deploy targets are in different accounts (see this
  repo's own `common/constructs/pipeline/infra-pipeline-construct.ts` for
  the same pattern applied to a CI-only pipeline)

**Trade-offs**:
- ❌ Three separate CodePipeline consoles to check instead of one — no
  single pane of glass for pipeline status across environments

### 2. Cross-account Source via a fixed-name role, not CDK's automatic support stack

**Decision**: `CodeCommitSourceAction.role` is set explicitly to a
fixed-name role (`<project>-pipeline-source-action-<accountId>`) created by
`RepositoryStack` in the dev account, rather than leaving `role` unset and
letting CDK auto-generate a `CrossAccountSupportStack`.

**Rationale**:
- ✅ CDK's automatic cross-account support requires `cdk bootstrap --trust
  <pipeline-account>` on the CodeCommit account ahead of time — a fixed-name
  role sidesteps that bootstrap trust setup entirely
- ✅ The trust relationship is a plain ARN string computed the same way on
  both sides (`lib/stacks/naming.ts`), so `RepositoryStack` and
  `PipelineStack` can be deployed independently, in either order after the
  first dev deployment

**Trade-offs**:
- ❌ Renaming `<project>` requires redeploying both `RepositoryStack` (dev)
  and every target account's `PipelineStack` in lockstep

### 3. Explicit EventBridge forwarding, not a shared event bus

**Decision**: `RepositoryStack` forwards each branch's push events to the
matching account's own default event bus (`events_targets.EventBus`); that
account's `PipelineStack` authorizes the dev account via
`AWS::Events::EventBusPolicy` and reacts with its own rule.

**Rationale**:
- ✅ CodeCommit only publishes `CodeCommit Repository State Change` events
  in the account that owns the repository — stg/prd can't see them without
  this forwarding step
- ✅ Same-account (dev) and cross-account (stg/prd) pipelines both end up
  triggered by "a rule reacting to a CodeCommit-shaped event in this
  account" — the forwarded event preserves the original repository ARN, so
  the trigger rule's `resources` filter is identical in both cases

### 4. `shared-params` for common values, except the one that's sensitive

**Decision**: `parameters/shared-params.ts` holds values common to every
environment. The CodeCommit account ID conceptually belongs there too — it's
always the dev account — but since this is a **public repository**, it's
read from the `CODECOMMIT_ACCOUNT_ID` environment variable instead of being
hard-coded.

```typescript
// parameters/shared-params.ts
export const sharedParams: SharedParams = {
  repositoryName: 'sample-app',
  codecommitAccountId: process.env.CODECOMMIT_ACCOUNT_ID,
};
```

### 5. Auto-created `develop`/`staging` branches

**Decision**: `codecommit.Code.fromDirectory()` only seeds a single branch
(`main`) at repository-creation time. Two `AwsCustomResource` calls
(`GetBranch` then `CreateBranch` x2) create `develop` and `staging` from
that same initial commit.

**Rationale**:
- ✅ A single `cdk deploy` (`ENV=dev`) leaves the repository fully ready —
  no manual `git push origin HEAD:develop` step required before the
  pipelines can be exercised

### 6. Well-Architected Framework Alignment

| Pillar | Implementation |
|--------|---------------|
| **Operational Excellence** | Structured CodeBuild logs (1-month retention) per environment and stage |
| **Security** | Cross-account access limited to a single, narrowly-scoped Source role per environment; `AwsSolutionsChecks` (CDK Nag) with documented, resource-scoped suppressions |
| **Reliability** | Managed CodePipeline/CodeBuild — no servers to patch or fail |
| **Performance Efficiency** | `BUILD_GENERAL1_SMALL` CodeBuild compute is sufficient for a sample pipeline |
| **Cost Optimization** | Pay-per-use pipeline/build; no idle compute; KMS key only created where cross-account access actually requires it |

## Prerequisites

- Three AWS accounts (dev / stg / prd), each with its own CLI profile
- AWS CLI v2.x installed and configured with a profile per account
- Node.js 20.x or later
- AWS CDK 2.x
- Git

### Required IAM Permissions

The deploying user/role needs permissions to create/manage, in EACH account:
CodeCommit (dev only), CodePipeline, CodeBuild, IAM, S3 (artifact bucket),
EventBridge, KMS (stg/prd only).

## Deployment Guide

### 1. Set the account IDs and CodeCommit account ID

```bash
export CODECOMMIT_ACCOUNT_ID=111111111111   # dev account — where CodeCommit lives
export DEV_ACCOUNT_ID=111111111111
export STG_ACCOUNT_ID=222222222222
export PRD_ACCOUNT_ID=333333333333
export PROJECT=myproject
```

### 2. Deploy to the dev account first

This creates the CodeCommit repository, all three branches, the
cross-account source-access plumbing for stg/prd, **and** the dev
environment's own pipeline.

```bash
export ENV=dev
npm run bootstrap    # first time only, against the dev profile
npm run stage:deploy:all -- --project=$PROJECT --env=dev
```

### 3. Deploy the pipeline into stg and prd

Run against **each account's own CLI profile** — `CODECOMMIT_ACCOUNT_ID`
must still point at the dev account so the Source stage trusts the right
role.

```bash
export ENV=stg
npm run bootstrap
npm run stage:deploy:all -- --project=$PROJECT --env=stg

export ENV=prd
npm run bootstrap
npm run stage:deploy:all -- --project=$PROJECT --env=prd
```

### 4. Exercise the pipelines

```bash
# repositoryName defaults to "sample-app" (parameters/shared-params.ts)
git clone codecommit::ap-northeast-1://sample-app
cd sample-app
git checkout staging
git commit --allow-empty -m "trigger stg pipeline"
git push origin staging     # forwarded to the stg account, triggers <project>-stg-pipeline
```

Push to `develop` / `main` to trigger the dev / prd pipelines respectively.

### 5. Verify

```bash
aws codepipeline get-pipeline-state --name myproject-stg-pipeline --profile <stg-profile>
```

The Deploy stage's CodeBuild logs show `aws sts get-caller-identity` running
under that account's own credentials — the pipeline, not just the
deployment, is genuinely running in that account.

## Testing Strategy

```
test/
├── compliance/
│   └── cdk-nag.test.ts             # AwsSolutionsChecks with resource-scoped suppressions
├── snapshot/
│   └── snapshot.test.ts            # Full template snapshots for RepositoryStack + both pipeline shapes
└── unit/
    ├── repository-stack.test.ts    # Source-role/event-forwarding assertions
    └── pipeline-stack.test.ts      # Same-account vs cross-account Source behavior
```

```bash
npm test -w workspaces/cicd-codecommit-cross-account
```

## Security Considerations

- ✅ Cross-account access is limited to a single Source-action role per
  environment, scoped to `codecommit:GitPull` and friends on this one
  repository ARN — Test/Build/Deploy never assume a cross-account role
- ✅ Each account explicitly authorizes only the dev account
  (`AWS::Events::EventBusPolicy`) to publish onto its default event bus
- ✅ The artifact bucket's KMS key (created only for cross-account
  pipelines) has automatic key rotation enabled
- ✅ `AwsSolutionsChecks` (CDK Nag) runs in `test/compliance/`; every
  remaining wildcard/managed-policy finding is suppressed with a written
  reason (see `lib/stacks/repository-stack.ts` and
  `lib/stacks/pipeline-stack.ts`)

## Customization

### Replacing the sample deploy step

Edit `sample-app/buildspec-deploy.yml` — the `echo` / `aws sts
get-caller-identity` lines are placeholders. Replace them with real
deployment commands (`cdk deploy`, `aws s3 sync`, `aws ecs update-service`,
...); no `AssumeRole` is needed since Deploy already runs in the target
account.

### Enabling manual approval

```typescript
// parameters/prd-params.ts
requireManualApproval: true,
approvalTopicArn: 'arn:aws:sns:ap-northeast-1:333333333333:cicd-x-account-prd-approvals',
```

## Troubleshooting

### Issue: stg/prd pipeline never starts on push

**Symptoms**: Pushing to `staging`/`main` doesn't trigger the matching
pipeline.

**Solutions**:
1. Confirm `RepositoryStack` was deployed (`ENV=dev`) — it creates the
   event-forwarding rule for that branch
2. Confirm that account's `PipelineStack` was deployed against its own
   profile — it creates the `AWS::Events::EventBusPolicy` that lets the dev
   account publish onto its bus, and the trigger rule that reacts to it
3. Confirm `CODECOMMIT_ACCOUNT_ID` was the same value in both the dev
   deployment and the target account's deployment — both the source-action
   role's ARN and the trigger rule's `resources` filter are built from it

### Issue: `AccessDenied` on the Source stage in stg/prd

**Symptoms**: The pipeline starts but the Source stage fails with an
IAM-related error.

**Solutions**:
1. Confirm `RepositoryStack`'s source-action role
   (`<project>-pipeline-source-action-<accountId>`) exists in the dev
   account and trusts this account's pipeline role
   (`<project>-<env>-pipeline-role`) by ARN
2. Confirm the artifact bucket's KMS key exists — a cross-account Source
   action requires customer-managed encryption on the artifact bucket

## References

### AWS Documentation
- [AWS CodePipeline User Guide](https://docs.aws.amazon.com/codepipeline/latest/userguide/welcome.html)
- [AWS CodeCommit User Guide](https://docs.aws.amazon.com/codecommit/latest/userguide/welcome.html)
- [AWS CodeBuild User Guide](https://docs.aws.amazon.com/codebuild/latest/userguide/welcome.html)
- [Cross-account and cross-region actions in CodePipeline](https://docs.aws.amazon.com/codepipeline/latest/userguide/pipelines-create-cross-account.html)
- [Sending and receiving Amazon EventBridge events between AWS accounts](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-cross-account.html)

### AWS CDK
- [aws-codepipeline-actions module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_codepipeline_actions-readme.html)
- [CDK Nag](https://github.com/cdklabs/cdk-nag)

### Related Architectures
- [`cicd-cloudfront-s3`](../cicd-cloudfront-s3/) — a same-account CodeCommit → CodePipeline reference for comparison

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](../../../LICENSE) file for details.

## 👥 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](../../../docs/contribution/CONTRIBUTING.md) for details.

## 🏆 About This Reference Architecture

This reference architecture demonstrates AWS CDK best practices for building
production-ready, cross-account CI/CD infrastructure.

**Target Level**: 300 (Advanced)

---

**Note**: This is a reference implementation. Always review and customize
according to your specific requirements and organizational policies before
deploying to production.
