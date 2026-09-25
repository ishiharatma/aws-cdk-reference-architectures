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
- [aws-service-gotchas.md](aws-service-gotchas.md) — AWS service behaviors that looked like bugs until root-caused: withdrawn Aurora versions, NAT instance defaults, ASG Availability Zone behavior, Keycloak on ECS specifics
- [dynamodb-vector-search.md](dynamodb-vector-search.md) — DynamoDB native vector search: CFn/CDK escape hatch for `VectorIndexes`, SearchSchema/AttributeDefinitions rule, `SearchVectors` request shape, PutItem-vs-UpdateItem indexing quirk, Lambda filter `exists` leaf-node trap
- [cdk-pipelines.md](cdk-pipelines.md) — CDK Pipelines: self-mutation is observable (cancelled + restarted run), Build-stage tests gate it, no Assets stage without assets, CodeCommit `Code` is initial-commit-only, pipeline does not delete its stacks
- [cognito-api-gateway-auth.md](cognito-api-gateway-auth.md) — Cognito + API Gateway: ID vs access token (401), custom scopes only from OAuth flows, insufficient scope is 401, `cognito:groups` string, curl-scripted hosted-UI PKCE flow, DynamoDB `sub` reserved word
- [deploy-verification-workflow.md](deploy-verification-workflow.md) — the end-to-end procedure this repo uses to deploy-verify a new or previously-`draft` architecture (deploy → verify for real → destroy → document)

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
