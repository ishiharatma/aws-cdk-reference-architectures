# Knowledge Base

Accumulated, verified operational knowledge from building and deploy-verifying the
architectures in this repository — the non-obvious gotchas, root causes, and AWS
behaviors that took real investigation to uncover. This directory is **git-tracked**
(unlike `.agent/` and `.claude/`, which hold local AI-tooling config and are
gitignored), so it survives across clones and is visible to any contributor —
human or AI — working in this repo.

## Why this exists, and how it differs from other docs

| Location | Tracked in git? | Purpose |
| -------- | :-: | ------- |
| `docs/knowledge/` (here) | ✅ | Durable, reusable facts and gotchas — "what we learned and verified" |
| `docs/.tmp/` | ❌ (gitignored) | Session scratch: dev.to drafts, one-off verification reports |
| `.project-context.md` (repo root) | ❌ (gitignored) | Personal/local running log of project history and decisions |
| `.agent/skills/`, `.claude/` | ❌ (gitignored) | Local AI-agent tooling config (skills, plugins) |
| Each workspace's `README.md` | ✅ | The finished, curated story for that one architecture |

A workspace's README explains *that* architecture. This directory captures knowledge
that cuts *across* workspaces — the kind of thing that would otherwise get
rediscovered independently in every new workspace that hits it (see
[fis-chaos-engineering.md](fis-chaos-engineering.md), where the same nonexistent FIS
action was independently reached for in two unrelated architectures before anyone
checked `aws fis list-actions`).

## Index

- [fis-chaos-engineering.md](fis-chaos-engineering.md) — AWS FIS action gotchas: actions that sound plausible but don't exist, per-action infrastructure prerequisites, targeting quirks, pricing
- [aws-cdk-deploy-operations.md](aws-cdk-deploy-operations.md) — CDK CLI/deploy operational gotchas: `deploy '**'` vs `--all`, `cdk.out` locking, SSO credential refresh, background-process hygiene
- [apigw-vpc-link-v2-alb.md](apigw-vpc-link-v2-alb.md) — REST API to an ALB over VPC link v2: L1 overrides, `IntegrationTarget` takes the ALB ARN, tsc-emit pitfall
- [multi-region-dr.md](multi-region-dr.md) — measured DR numbers (replication, DNS failover, backup copy/restore), Lambda concurrency 0 = 429, vault cleanup, Stage stack selection, bootstrap
- [network-firewall-inspection.md](network-firewall-inspection.md) — Network Firewall behind a TGW: domain allow list also drops east-west HTTP (add a pass rule), alert log evidence, SSM as an egress check, routing recipe
- [ecs-blue-green-native-vs-codedeploy.md](ecs-blue-green-native-vs-codedeploy.md) — ECS native vs CodeDeploy blue/green measured: L2 API, deployment states, timings, hooks (two protocols), broken release not given up, per-flavor state, bash subshell trap
- [rds-multiaz-vs-read-replica.md](rds-multiaz-vs-read-replica.md) — RDS Multi-AZ vs read replica measured: ReplicaLag climbs on an idle PostgreSQL primary, marker lag in ms, failover impact on each, promotion detaches
- [glue-athena-data-lake.md](glue-athena-data-lake.md) — Glue + Athena lake: string partition keys vs DATE literals, workflow triggers, dynamic partition overwrite, get-partitions pagination, workgroup enforcement
- [bedrock-kb-s3-vectors.md](bedrock-kb-s3-vectors.md) — Bedrock Knowledge Bases on S3 Vectors: non-filterable chunk keys, dimension agreement, filter is not access control, inference-profile permissions, SigV4 curl
- [security-hub-remediation.md](security-hub-remediation.md) — Security Hub auto-remediation: reserved concurrency quota trap, BatchImportFindings test method, SecurityControlId matching, GuardDuty sample findings, quarantine SG egress
- [aws-service-gotchas.md](aws-service-gotchas.md) — AWS service behaviors that looked like bugs until root-caused: withdrawn Aurora versions, NAT instance defaults, first CodeStar Notifications rule race, ASG Availability Zone behavior, Keycloak on ECS specifics, Bedrock cross-region inference profile IAM (do not pin the `foundation-model` region), CloudTrail CMK key-policy grant, `AWS::Config::ConfigurationRecorder`/`DeliveryChannel` circular dependency (use `AwsCustomResource`), `ACCESS_KEYS_ROTATED` managed rule's required `maxAccessKeyAge`, a GSI added to an existing DynamoDB table still backfilling after `UPDATE_COMPLETE`
- [dynamodb-vector-search.md](dynamodb-vector-search.md) — DynamoDB native vector search: CFn/CDK escape hatch for `VectorIndexes`, SearchSchema/AttributeDefinitions rule, `SearchVectors` request shape, PutItem-vs-UpdateItem indexing quirk, Lambda filter `exists` leaf-node trap
- [cdk-pipelines.md](cdk-pipelines.md) — CDK Pipelines: self-mutation is observable (cancelled + restarted run), Build-stage tests gate it, no Assets stage without assets, CodeCommit `Code` is initial-commit-only, pipeline does not delete its stacks, `CodeCommitSourceAction` default trigger doubles up with a custom EventBridge rule, pending manual approval blocks later executions
- [cdk-permissions-boundary.md](cdk-permissions-boundary.md) — governing IAM privilege escalation under IaC: why a `CreateRole` SCP fights CDK, boundary on `cfn-exec-role` + escalation denies (verified with `simulate-principal-policy`), `deploy-role` `PassRole` failure and `CliCredentialsStackSynthesizer`, separate-qualifier bootstrap testing
- [cognito-api-gateway-auth.md](cognito-api-gateway-auth.md) — Cognito + API Gateway: ID vs access token (401), custom scopes only from OAuth flows, insufficient scope is 401, `cognito:groups` string, curl-scripted hosted-UI PKCE flow, DynamoDB `sub` reserved word, identity pool credentials share one ARN per role (`CognitoIdentityCredentials`), CORS for IAM denials, browser SDK packaging, managed login v2 is not curl-scriptable
- [eventbridge-custom-bus.md](eventbridge-custom-bus.md) — EventBridge: `logConfig` needs a Logs delivery, source filter, archive count lag, replay `FilterArns`, target DLQ scope
- [secrets-manager-aurora-rotation.md](secrets-manager-aurora-rotation.md) — Aurora + Secrets Manager rotation: Data API caches secrets for minutes, alternating users flip the username, role must exist first, endpoint instead of NAT, force-delete secrets on teardown
- [amplify-hosting.md](amplify-hosting.md) — Amplify Hosting: `StartDeployment` with an `s3://` sourceUrl needs a bucket policy (not just IAM grants), why that's often unreachable for a CDK-asset zip, and the presigned-URL fix that avoids it entirely
- [lambda-microvms.md](lambda-microvms.md) — AWS Lambda MicroVMs: lifecycle hooks live under `/aws/lambda-microvms/runtime/v1/<hook-name>` (not bare paths), IAM actions are `lambda:*` not `lambda-microvms:*`, `PassNetworkConnector` needed for both custom and AWS-managed connectors, build-time hooks run under the build role not the execution role
- [lambda-web-functions.md](lambda-web-functions.md) — AWS Lambda Web Functions (GA 2026-10-12), deploy-verified: L1 constructs + bare-name dependencies, `BucketDeployment.objectKeys` omit the prefix, cfn-lint F3006 acknowledge, IamAuth + CloudFront OAC (`always-amz-auth`, no viewer Host), dynamic per-environment limit vs `maxEnvironments` (429 `EndpointMaxEnvThrottle`), 503 load shedding, log format, metrics, old CLI vs camelCase boto3, Tokyo pricing
- [transfer-family-custom-idp.md](transfer-family-custom-idp.md) — Transfer Family SFTP with a Lambda custom IdP: user-role trust needs the `user/<server-id>/*` source ARN (login works, file ops fail otherwise), key-only `PUBLIC_KEY` flow, LOGICAL home + session policy isolation, `test-identity-provider` for source-IP tests, nested string-set updates, a stopped server is still billed (recycle by delete/create: permissions, host key, DNS delay), alarm/SNS/KMS notes, the public key body in the Transfer log can only be masked (data protection policy needs Audit + Deidentify)
- [lambda-durable-functions.md](lambda-durable-functions.md) — Lambda durable functions, deploy-verified: async start with a reused name + different payload returns 202 and lands in the DLQ (`DurableExecutionAlreadyExists`), callback timeout on AWS vs the local runner, `StopDurableExecution` side effects, what a suspended execution's history looks like
- [aws-waf-body-inspection.md](aws-waf-body-inspection.md) — AWS WAF body inspection measured on CloudFront vs ALB: exact 8 / 16 / 64 KB boundaries (`CONTINUE` is blind past them, `MATCH` size rule closes it), ALB Web ACL behind CloudFront re-blocks what CloudFront allowed, COUNT-inserted headers reach the origin, case-sensitive matches, rate-rule lag, ALB→Lambda 413 before WAF
- [deploy-verification-workflow.md](deploy-verification-workflow.md) — the end-to-end procedure this repo uses to deploy-verify a new or previously-`draft` architecture (deploy → verify for real → destroy → document)
- [ecs-gateway.md](ecs-gateway.md) — Amazon ECS Gateway: no CDK L1 (CfnResource + GatewayConnectors override), `PropagateTags: NONE` or ACM rejects the `aws:cloudformation:*` tags and routes hang, the hidden per-service security group, 300 s deregistration delay, test-header CANARY measurements, timings

## Convention: when and how to add to this directory

Add or update a file here when a task in this repo produces knowledge that meets
**all** of the following (the same bar `claudeception` uses for extracting a skill):

- **Reusable** — would help a *different* task, not just the one at hand
- **Non-trivial** — required actual investigation (reading AWS docs closely, root-causing
  a misleading symptom via CLI, hitting a real deploy failure), not just a lookup
- **Verified** — confirmed against a real AWS deployment or an authoritative source
  (official AWS documentation, not something recalled from training data alone)

**How to add:**
1. Check whether an existing file in this directory already covers the topic — extend
   it (with a new subsection or an update) rather than creating a near-duplicate.
2. Write the finding as a self-contained subsection: what looked like the problem,
   what the actual root cause was, how it was confirmed, and the fix. Link to the
   workspace(s) where it was found.
3. If the finding came from official AWS documentation, cite the URL. If it came from
   root-causing a live deployment, say how it was confirmed (the specific CLI command
   or log line that proved it) — a claim without a verification path is not durable
   knowledge, it's a guess.
4. Keep entries in English (matches this repo's code-comment convention — see
   `.agent/AGENT.md` § Code Style), even though PRs and commit messages in this repo
   are otherwise in Japanese.
5. **Strip anything account-specific before writing** — this directory is git-tracked
   in a public repo. No AWS account IDs, no real ARNs that embed one, no CLI/SSO
   profile names, no real resource/bucket names from a verification deployment. Use
   this repo's own `<project>-<env>-...` / `<bucket>` / `<account>` placeholder
   convention instead — a command or error message is just as searchable with the
   account-specific parts redacted as without.

This directory is meant to be **living** — update it any time a task surfaces
something that belongs here, not only at the end of a large piece of work.
