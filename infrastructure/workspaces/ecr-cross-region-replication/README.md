# ECR Cross-Region Replication - AWS CDK Reference Architecture

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **Level: 300 (Advanced)**

Amazon ECR Cross-Region Replication (CRR) from Tokyo (`ap-northeast-1`) to Osaka (`ap-northeast-3`). By default, CRR auto-creates the destination repository on first replicated push — and an auto-created repository has **no lifecycle policy**, so images accumulate there forever. This pattern avoids that trap by pre-creating both repositories independently, each with its own lifecycle policy, then enabling registry-wide replication in Tokyo that targets the repository Osaka already owns.

## 📑 Table of Contents

- [Architecture Overview](#-architecture-overview)
- [Design Decisions & Best Practices](#-design-decisions--best-practices)
- [Cost Optimization](#-cost-optimization)
- [Security Considerations](#-security-considerations)
- [Prerequisites](#-prerequisites)
- [Deployment Guide](#-deployment-guide)
- [Testing Strategy](#-testing-strategy)
- [Customization](#-customization)
- [Troubleshooting](#-troubleshooting)
- [References](#-references)

## 🏗️ Architecture Overview

![overview](overview.drawio.svg)

```text
Stack 1 — EcrCrrOsakaStack (ap-northeast-3, deployed first)
  ECR repository "<project>-<env>-<suffix>"
    lifecycle policy: leaner retention (own maxImageCount / untagged / any-tag rules)

Stack 2 — EcrCrrTokyoStack (ap-northeast-1, depends on Stack 1)
  ECR repository "<project>-<env>-<suffix>"
    lifecycle policy: independent retention (own maxImageCount / untagged / any-tag rules)
  AWS::ECR::ReplicationConfiguration (registry-wide, one per account/region)
    rule: destination region = ap-northeast-3
          repositoryFilter = PREFIX_MATCH "<project>-<env>-<suffix>"

docker push  ──►  Tokyo repository  ──[async replication]──►  Osaka repository
                                                                 (already exists, keeps its own policy)
```

### Key Components

- **`EcrCrrOsakaStack`** – creates the destination ECR repository in Osaka with its own lifecycle policy, deployed *before* the Tokyo stack so it already exists when replication (or any manual push) targets it.
- **`EcrCrrTokyoStack`** – creates the source ECR repository in Tokyo plus a single `ecr.CfnReplicationConfiguration` scoped to this repository's name via a `PREFIX_MATCH` filter.
- **`EcrConstruct`** (shared, `@common/constructs/ecr.ts`) – reused twice, once per stack/region, so both repositories get the same battle-tested lifecycle-rule structure (latest-tag retention, environment-tag count cap, untagged/any-tag age expiry) driven by independent `EcrConfig` parameters.
- **`test-replication.sh`** – pushes a test image to Tokyo, polls Osaka until it appears, and prints both repositories' lifecycle policies side by side to prove they are configured independently.

### Architecture Characteristics

| Characteristic | Value | Rationale |
|---|---|---|
| Availability | No single point of failure; replication is a managed, asynchronous ECR feature | Amazon ECR is a regional managed service in both regions; no custom infrastructure to keep available |
| Scalability | Scales with image push volume and image size | Replication throughput and storage are fully managed by ECR |
| Security | AES-256 encryption at rest in both repositories, IAM-scoped access, no public repositories | See [Security Considerations](#-security-considerations) |
| Cost | Pay for storage in both regions plus one-time cross-region transfer per replicated image layer | See [Cost Optimization](#-cost-optimization) |

## 🎯 Design Decisions & Best Practices

### 1. Pre-create the destination repository instead of letting CRR auto-create it

**Decision**: `EcrCrrOsakaStack` explicitly creates the Osaka repository with its own `EcrConfig`, rather than relying on `AWS::ECR::ReplicationConfiguration` to auto-create it on first replicated push.

**Rationale**:
- ✅ An auto-created replica repository has **no lifecycle policy** — nothing ever expires, and storage cost only grows. Pre-creating it lets it carry a real, independent retention policy from the moment it exists.
- ✅ Demonstrates that a replica's operational posture (lifecycle, scan-on-push, tag mutability) does not have to mirror the source — Osaka in this example intentionally uses a leaner retention (`maxImageCount: 10` vs. Tokyo's `30`) and disables scan-on-push, to prove the two are configured independently.
- ✅ Reuses the exact same `EcrConstruct` used everywhere else in this repository, so this pattern doesn't introduce a second way to define an ECR repository.

**Trade-offs**:
- ❌ Two stacks (and two deployments) to manage instead of one — CRR alone would only require the Tokyo side.
- ❌ The two `EcrConfig`s must agree on `repositoryNameSuffix`, or replicated images silently land in a *third*, auto-created repository instead of the one Osaka pre-created (see Decision 2).

### 2. Deterministic repository naming instead of a cross-region CDK reference

**Decision**: Both stacks derive the exact same repository name — `${project}-${environment}-${repositoryNameSuffix}` — independently from their own `EcrConfig`, rather than passing the Osaka repository's name/ARN into the Tokyo stack via `CfnOutput` / `Fn::ImportValue` / `crossRegionReferences`.

**Rationale**:
- ✅ `AWS::ECR::ReplicationConfiguration` matches repositories by **name** (`repositoryFilters` / `PREFIX_MATCH`), not by ARN or CDK reference — a plain deterministic string is all that's actually needed.
- ✅ Cross-region CloudFormation exports/imports create a hard deployment-order coupling and complicate teardown (an exported value can't be deleted while another stack imports it). A shared naming convention avoids that coupling entirely.
- ✅ `EcrCrrTokyoStack` still fails fast — at synth time — if the two suffixes ever diverge, via an explicit guard (`sourceRepositoryNameSuffix !== destinationRepositoryNameSuffix`), so the "same name by convention" approach doesn't silently break.

**Trade-offs**:
- ❌ The two parameter blocks (`sourceEcrConfig`, `destinationEcrConfig`) must be kept in sync on `repositoryNameSuffix` by the person editing `parameters/*.ts` — nothing in the type system enforces this, only the runtime guard does.

### 3. One registry-wide replication rule, scoped with `PREFIX_MATCH`

**Decision**: `EcrCrrTokyoStack` declares exactly one `ecr.CfnReplicationConfiguration`, with a single rule whose `repositoryFilters` restricts it to this stack's own repository name.

**Rationale**:
- ✅ `AWS::ECR::ReplicationConfiguration` is a **singleton per account/region** — CloudFormation (and ECR itself) allows only one. Declaring more than one anywhere in an account's Tokyo region would conflict. Scoping the rule's filter (instead of leaving it registry-wide with no filter) means this stack can coexist with other, unrelated ECR repositories in the same account/region without replicating them too.
- ✅ `PREFIX_MATCH` with the exact repository name is deliberately *not* a wildcard prefix — it only ever matches the one repository this pattern created, so growing the account's other ECR usage never accidentally starts replicating.

**Trade-offs**:
- ❌ Because the resource is a singleton, this stack cannot be safely combined in the same account/region with another, independently-deployed stack that also declares its own `CfnReplicationConfiguration` — they would collide. A real multi-repository setup should model all replication rules as rules within one such resource.

### 4. Deploy Osaka before Tokyo

**Decision**: `EcrCrossRegionReplicationStage` instantiates `EcrCrrOsakaStack` first and adds `tokyoStack.addDependency(osakaStack)`, so CloudFormation always deploys/updates Osaka before Tokyo.

**Rationale**:
- ✅ Guarantees the destination repository — with its own lifecycle policy already attached — exists in Osaka before the replication rule (or any manual `test-replication.sh` push) in Tokyo can start sending images there, closing the race window where CRR might otherwise auto-create it first.
- ✅ Matches `EcrCrrOsakaStack`'s own design intent (Decision 1): pre-creation only prevents the "no lifecycle policy" problem if it reliably happens *before* the first replicated image lands.

**Trade-offs**:
- ❌ Slightly slower initial deployment than deploying both stacks in parallel, since Tokyo now waits on Osaka.

### Well-Architected Framework Alignment

| Pillar | Implementation |
|---|---|
| **Operational Excellence** | `EcrConstruct` emits `CfnOutput`s (`RepositoryUri`, `RepositoryName`) in both regions; `test-replication.sh` gives an end-to-end, scriptable way to verify replication and compare both lifecycle policies |
| **Security** | Both repositories use AES-256 encryption at rest; source repository has scan-on-push enabled; IAM is scoped to what each stack actually creates |
| **Reliability** | Explicit stack dependency (Osaka before Tokyo) removes the race between repository creation and replication; a synth-time guard prevents a repository-name mismatch from silently misrouting replicated images |
| **Performance Efficiency** | Cross-region replication is a fully managed, asynchronous ECR feature — no custom compute or polling infrastructure required in production |
| **Cost Optimization** | Independent lifecycle policies per region (leaner retention in Osaka) bound each region's storage growth separately; see [Cost Optimization](#-cost-optimization) |
| **Sustainability** | No idle compute anywhere in this pattern — only two ECR repositories and one replication rule, both fully managed |

## 💰 Cost Optimization

### Estimated Monthly Costs (ap-northeast-1 / ap-northeast-3, light demo usage)

```text
Tokyo (source) ECR storage (<500 MB, within free tier):     Free tier
Osaka (destination) ECR storage (<500 MB):                  Free tier
Basic image scanning on push (Tokyo only):                  Free
Cross-region data transfer (a few test pushes, <100 MB):    < $0.01
-------------------------------------------
Total (Dev, demo usage):                                    < $1/month
```

### Estimated Monthly Costs at a Larger Scale (illustrative: 5 GB of new image layers pushed/month, 20 GB retained in Tokyo, 10 GB retained in Osaka after each region's own lifecycle policy prunes older images)

```text
Tokyo ECR storage (20 GB retained, @ ~$0.10/GB-month):       ~$2.00
Osaka ECR storage (10 GB retained, @ ~$0.10/GB-month):       ~$1.00
Cross-region replication data transfer (5 GB new/month):     ~$0.10-0.45
-------------------------------------------
Total (~5 GB new pushes/month, steady state):                ~$3-4/month
```

*Figures are approximate and illustrative only — ECR storage and inter-region data transfer pricing vary by region pair and change over time. Always confirm current pricing with the [AWS Pricing Calculator](https://calculator.aws/). The takeaway that holds regardless of exact pricing: only *newly pushed* image layers are transferred across regions (ECR replication is incremental, not a full periodic sync), so replication's incremental cost scales with push volume, not with total repository size.*

### Cost Optimization Strategies

1. **Independent, leaner lifecycle policy in the replica** — this pattern's whole point: Osaka's `maxImageCount: 10` / `untaggedDurationDays: 7` prunes far more aggressively than Tokyo's `maxImageCount: 30` / `untaggedDurationDays: 14`, since a DR/secondary-region replica rarely needs the same depth of history as the source.
2. **`PREFIX_MATCH` scoped to the exact repository name** — prevents accidentally replicating other, unrelated repositories that might later be added to the same account/region.
3. **Basic (free) image scanning** instead of Enhanced scanning (Amazon Inspector-backed, billed per image) — sufficient for this reference pattern; switch to Enhanced scanning only where its deeper CVE coverage is actually required.

## 🔒 Security Considerations

### Network Security

Amazon ECR is a regional managed service reached over the AWS API (and the Docker/OCI registry API over HTTPS) — there are no VPC-resident resources in this pattern and no inbound network surface to secure. Cross-region replication traffic stays on the AWS backbone.

### Security Best Practices Implemented

- ✅ Both repositories use `RepositoryEncryption.AES_256` at rest.
- ✅ Neither repository is public — both are standard private ECR repositories, reachable only by principals with explicit IAM permission.
- ✅ The source repository has `imageScanOnPush: true`, so every pushed image is scanned before anyone can reasonably pull it.
- ✅ `emptyOnDelete: true` with `RemovalPolicy.DESTROY` on both repositories keeps this reference pattern's stacks fully destroyable for demo/test purposes (documented as **not** recommended for production in `EcrConstruct`'s own inline comments — switch to `RemovalPolicy.RETAIN` for production use).
- ✅ The replication rule's `repositoryFilters` scopes replication to exactly this pattern's repository name, so it can never widen to replicate other repositories in the account without an explicit code change.

### CDK Nag Compliance

Both stacks pass `cdk-nag`'s `AwsSolutionsChecks` with one documented suppression: `AwsSolutions-ECR1` (image scan-on-push), because this pattern *intentionally* sets scan-on-push differently between Tokyo (`true`) and Osaka (`false`) to demonstrate that lifecycle/scan settings are configured independently per region — see `test/compliance/cdk-nag.test.ts` for the exact rationale.

```bash
npm run test:compliance -w workspaces/ecr-cross-region-replication
```

## 📋 Prerequisites

- AWS Account with appropriate permissions
- AWS CLI v2.x installed and configured
- Node.js 20.x or later
- AWS CDK 2.x (`aws-cdk-lib` ^2.186, bundled in this workspace)
- Git
- Docker (only needed to run `test-replication.sh`, which pushes a test image)
- `jq` (only needed to run `test-replication.sh`)

### Required IAM Permissions

The deploying user/role needs permissions to create/manage:
- ECR (repositories, lifecycle policies, replication configuration) in both `ap-northeast-1` and `ap-northeast-3`
- CloudFormation (stack deployment)

## 🚀 Deployment Guide

### 1. Clone and Setup

```bash
cd infrastructure
npm install
```

### 2. Configure Environment Parameters

Edit `parameters/dev-params.ts` if you want different repository names, regions, or lifecycle values — the defaults deploy a Tokyo source repo (`maxImageCount: 30`) and an Osaka destination repo (`maxImageCount: 10`) sharing the `sample-app` name suffix.

### 3. Deploy

```bash
export PROJECT_NAME=ecr-crr-demo
export ENV=dev
npm run bootstrap -w workspaces/ecr-cross-region-replication   # first time only, per account/region
npm run deploy:all -w workspaces/ecr-cross-region-replication
```

CDK deploys `EcrCrrOsakaStack` before `EcrCrrTokyoStack` (see [Design Decision 4](#4-deploy-osaka-before-tokyo)).

### 4. Verify Deployment

```bash
# Confirm both repositories exist, each with its own lifecycle policy:
aws ecr describe-repositories --region ap-northeast-1 --repository-names ecr-crr-demo-dev-sample-app
aws ecr describe-repositories --region ap-northeast-3 --repository-names ecr-crr-demo-dev-sample-app

# End-to-end: push a test image to Tokyo, wait for it to replicate to Osaka,
# and print both regions' lifecycle policies side by side:
./test-replication.sh --project ecr-crr-demo --env dev
```

## 🧪 Testing Strategy

### Test Structure

```text
test/
├── snapshot/          # Full CloudFormation template + resource-count snapshots (both stacks)
│   └── snapshot.test.ts
├── unit/               # Fine-grained resource/property/relationship assertions, one file per stack
│   ├── ecr-crr-tokyo-stack.test.ts
│   └── ecr-crr-osaka-stack.test.ts
└── compliance/         # cdk-nag AwsSolutions checks, one stack per test.each case
    └── cdk-nag.test.ts
```

### 1. Snapshot Tests

**Purpose**: Catch unintended CloudFormation template changes during refactoring.

```bash
npm run test:snapshot -w workspaces/ecr-cross-region-replication
npm run test:snapshot:update -w workspaces/ecr-cross-region-replication   # after an intentional change
```

### 2. Unit Tests

**Purpose**: Verify each stack produces the expected resources, properties and relationships.

**Test Categories**:
- ✅ Tokyo stack: exactly one source repository with the deterministic name, exactly one `AWS::ECR::ReplicationConfiguration` with the correct destination region and `PREFIX_MATCH` filter, the replication config depends on the repository, `ScanOnPush: true`, and a synth-time error when the source/destination `repositoryNameSuffix` values diverge
- ✅ Osaka stack: exactly one destination repository with the same deterministic name, zero replication configurations, a leaner lifecycle policy (shorter untagged-image retention), `ScanOnPush: false`, and a fallback to `sourceEcrConfig` when `destinationEcrConfig` is not provided

### 3. Compliance Tests

```bash
npm run test:compliance -w workspaces/ecr-cross-region-replication
```

### Run Everything

```bash
npm run build -w workspaces/ecr-cross-region-replication
npm test -w workspaces/ecr-cross-region-replication
npm run lint -w workspaces/ecr-cross-region-replication
```

## ⚙️ Customization

### Change the destination region

```typescript
// parameters/dev-params.ts
ecrCrr: {
    destinationRegion: 'us-west-2',   // any other supported ECR region
    // ...
},
```

### Give the destination repository a different retention policy

```typescript
// parameters/dev-params.ts
ecrCrr: {
    destinationEcrConfig: {
        createConfig: {
            repositoryNameSuffix: 'sample-app',   // must match sourceEcrConfig's suffix
            maxImageCount: 5,
            untaggedDurationDays: 3,
            anytagDurationDays: 30,
            isImageScanOnPush: false,
        },
    },
    // ...
},
```

### Skip a separate destination configuration

Omit `destinationEcrConfig` entirely and `EcrCrrOsakaStack` falls back to reusing `sourceEcrConfig` — both repositories then get an identical (not independent) lifecycle policy:

```typescript
// parameters/dev-params.ts
ecrCrr: {
    sourceEcrConfig: { /* ... */ },
    // destinationEcrConfig omitted — Osaka reuses sourceEcrConfig
    destinationRegion: 'ap-northeast-3',
},
```

## 🔧 Troubleshooting

### Issue: Replicated images land in an unexpected, auto-created repository

**Symptoms**: `aws ecr describe-repositories` in Osaka shows a repository you didn't create, and it has no lifecycle policy.

**Solutions**:
1. Check that `sourceEcrConfig.createConfig.repositoryNameSuffix` and `destinationEcrConfig.createConfig.repositoryNameSuffix` are identical — `EcrCrrTokyoStack` throws at synth time if they diverge, so this should only happen if the stacks were deployed from mismatched parameter versions.
2. Confirm `EcrCrrOsakaStack` was deployed (and its repository actually exists) *before* any image was pushed to Tokyo.

### Issue: `test-replication.sh` times out waiting for replication

**Symptoms**: `Error: image did not replicate to ap-northeast-3 within 300s`.

**Solutions**:
1. Replication is asynchronous and best-effort within minutes, not seconds — re-run with a longer `--timeout`.
2. Confirm the replication configuration exists and targets the right region: `aws ecr describe-registry --region ap-northeast-1`.
3. Confirm the destination repository exists in Osaka (see the previous issue) — CRR can only replicate into it once it's there, or will otherwise auto-create a same-named repository with default settings.

### Issue: `cdk deploy` fails with a replication configuration conflict

**Symptoms**: `AWS::ECR::ReplicationConfiguration` creation fails because one already exists in the account/region.

**Solutions**:
1. `AWS::ECR::ReplicationConfiguration` is a singleton per account/region (see [Design Decision 3](#3-one-registry-wide-replication-rule-scoped-with-prefix_match)) — check for an existing one with `aws ecr describe-registry --region ap-northeast-1` and either import/adapt it instead of declaring a second one, or add this pattern's rule to the existing configuration's `rules` array.

## 📚 References

### AWS Documentation
- [Amazon ECR private repository cross-Region replication](https://docs.aws.amazon.com/AmazonECR/latest/userguide/replication.html)
- [Amazon ECR lifecycle policies](https://docs.aws.amazon.com/AmazonECR/latest/userguide/LifecyclePolicies.html)
- [Amazon ECR image scanning](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning.html)

### AWS Well-Architected
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)

### AWS CDK
- [aws-cdk-lib.aws_ecr module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecr-readme.html)
- [CfnReplicationConfiguration](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecr.CfnReplicationConfiguration.html)
- [CDK Best Practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)

### Related Architectures
- [ecs-fargate-alb](../ecs-fargate-alb/) – another architecture using the shared `EcrConstruct`, in a single-region ECS deployment pipeline context

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.

## 👥 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](../../CONTRIBUTING.md) for details.

## 🏆 About This Reference Architecture

This reference architecture demonstrates AWS CDK best practices for building production-ready infrastructure.

**Target Level**: 300 (Advanced)

---

**Note**: This is a reference implementation. Always review and customize according to your specific requirements and organizational policies before deploying to production.
