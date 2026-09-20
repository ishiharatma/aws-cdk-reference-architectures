# Deploy-Verification Workflow

The end-to-end procedure this repo uses to confirm a new (or previously `draft:true`)
architecture actually works against real AWS, not just that it type-checks and passes
snapshot tests. Snapshot/unit tests confirm the CDK code produces the CloudFormation
you intended; only a real deploy confirms the intent was correct. This repo has found
genuine bugs at every stage of this pipeline that no amount of static testing caught —
a missing side-effect import, a property that no longer exists on an L2 construct, a
withdrawn database engine version, a nonexistent FIS action ID.

See also [`.agent/skills/deploy-verification/SKILL.md`](../../.agent/skills/deploy-verification/SKILL.md)
(local, gitignored) for the Claude Code-facing procedural version of this workflow.

## The procedure

1. **Confirm AWS access** — `aws sts get-caller-identity --profile <profile>` before
   starting. If the CDK CLI itself fails to resolve credentials despite the profile
   being valid, see the SSO-credential-refresh gotcha in
   [aws-cdk-deploy-operations.md](aws-cdk-deploy-operations.md).

2. **Check for resource-name collisions** with anything already deployed in the same
   account+region (`aws cloudformation list-stacks`) — several workspaces in this repo
   share fixed resource names (e.g. `<project>-<env>-aurora-secret`,
   `<project>-<env>-fis-role`) and are documented as "deploy only one at a time."

3. **Deploy** with `cdk deploy '**'` (never `--all` across a `cdk.Stage` — see
   [aws-cdk-deploy-operations.md](aws-cdk-deploy-operations.md)). Deploy in the
   background if it's likely to run long (Aurora Serverless v2 create/delete routinely
   takes 10–20 minutes); poll `aws cloudformation describe-stacks`/`describe-stack-events`
   for real progress rather than the CLI's own (fully-buffered) output.

4. **Fix real bugs as they surface**, not just cosmetic ones. A deploy failure at this
   stage is exactly the point of doing this — every gotcha in
   [aws-service-gotchas.md](aws-service-gotchas.md) and
   [fis-chaos-engineering.md](fis-chaos-engineering.md) was found this way. After a
   fix: re-run `npm run build` and the affected test suite, regenerate snapshots
   (`npm run test:snapshot:update`) if the change affects synthesized CloudFormation.

5. **Smoke-test the baseline** before running any fault injection — confirm the
   happy-path actually works (a working NLB/ALB response, a successful message
   round-trip, a successful state-machine execution) so that any later failure during
   fault injection is attributable to the fault, not to a broken baseline.

6. **Verify functionality via real AWS API/CLI checks, not assumptions.** "The
   CloudFormation stack reached CREATE_COMPLETE" is not verification that the
   architecture *works* — it only means the resources exist. Concretely:
   - For a chaos/fault-injection scenario: start the experiment, then confirm the
     fault is genuinely active via a signal that can't lie (CloudWatch Logs showing
     the FIS extension's own state transitions, `describe-target-health` showing a
     target actually flip to unhealthy, `receive-message` on a DLQ showing a real
     `ApproximateReceiveCount`) — not just "the experiment status says running."
   - Long-running or slow-converging scenarios (a 20-minute DLQ-inducing outage, a
     50%-percentage Lambda fault) don't always need to run to completion once the
     effect is confirmed — `aws fis stop-experiment` early is fine once you have the
     evidence you need; document that the stop was deliberate, not a failure.
   - Prefer a live poll loop (this environment's `Monitor` tool, or a backgrounded
     bash loop) over one-shot checks — many of the interesting findings in this repo
     (the ASG replacing a healthy-looking instance, a DLQ populating faster than
     expected) were only visible by watching state change over time, not from a single
     snapshot.

7. **Tear down** every deployed resource afterward
   (`cdk destroy '**'` / `stage:destroy:all`), even for a workspace that will stay
   `draft:true` a while longer. Confirm the stacks are actually gone
   (`aws cloudformation describe-stacks` returning empty for that prefix), not just
   that the destroy command exited 0.

8. **Document what was found**, in this order of durability:
   - **This directory** (`docs/knowledge/`) — durable, cross-workspace gotchas (see
     that directory's `README.md` for the bar a finding needs to clear).
   - **The workspace's own `README.md` / `README.ja.md`** — update any section whose
     claims turned out to be wrong (a "why we designed it this way" rationale that
     turned out to be based on a nonexistent action, a cost table that said "FIS is
     free"), and add an "Observed results" section with what was actually seen.
   - **`docs/.tmp/`** (gitignored, session-local) — a detailed narrative verification
     report and dev.to draft article(s), following the numbering convention in
     existing files there.
   - **`pages/patterns.json`** — remove `draft: true` once verified, update `date`.
   - **`rss.xml`** — regenerate (`node scripts/generate-rss.js`) after any
     `patterns.json` change; it silently excludes anything still `draft: true`.

9. **Commit on a dedicated branch off up-to-date `main`**, never directly to `main`.
   Revert any incidental `package-lock.json` churn unrelated to the actual change
   before committing (see [aws-cdk-deploy-operations.md](aws-cdk-deploy-operations.md)).

## Signals that a finding belongs in `docs/knowledge/`, not just the PR description

If, while doing the above, you hit something that:
- took real investigation to root-cause (not a quick lookup),
- would plausibly bite a *different* workspace or task in this repo, and
- you can point to exactly how it was confirmed (a specific CLI output, log line, or
  AWS documentation URL) —

it belongs in this directory, written so the next person (human or AI) hits the
symptom, searches for it, and finds the actual cause immediately instead of
re-investigating from scratch.
