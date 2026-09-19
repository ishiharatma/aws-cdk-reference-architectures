# Demo: triggering the Agentic Review gate

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

A way to exercise the `AgenticReview` pipeline stage end-to-end against a
diff that should actually get flagged, without permanently polluting
`src/index.js` with intentionally bad code. `inject-risky-change.js`
inserts (and later removes) `risky-snippet.js` — five endpoints written to
trip a specific review perspective each:

| Perspective | What's in the snippet |
| --- | --- |
| Security | Hardcoded AWS credentials and a DB password; unauthenticated endpoint that pipes raw user input into a shell command (`exec`); a second endpoint that builds "SQL" via string concatenation of user input and logs the password alongside it |
| Infra/Ops | An endpoint with an empty `catch` block — errors are silently swallowed, nothing is logged |
| Cost | An endpoint that synchronously fires 5,000 outbound HTTP calls per request, one at a time |
| Code quality | Deeply nested duplicated conditionals with an unreachable branch |

**Never deploy this.** It's for producing a `git diff` for
`AgenticReview` to look at — not for running. This sample has no real ECS
cluster behind it anyway (see the main README), so nothing gets deployed
either way, but keep it off `main`/`develop` outside of this demo.

## Steps

Run these from `backend/ecspresso-bedrock-review-app/`, on a throwaway
branch (or immediately followed by the revert — see below):

```bash
# 1. Apply the risky change
node demo/inject-risky-change.js apply

# 2. Look at the diff it produced
git diff -- src/index.js

# 3. Confirm the app still boots and the untouched endpoints still pass
npm test

# 4. Commit and push to the branch your pipeline watches (see EnvParams.branchName,
#    "develop" by default)
git add src/index.js
git commit -m "demo: intentionally risky change for agentic review testing"
git push origin develop
```

## What to expect

- The `AgenticReview` CodeBuild project reviews the diff and should return
  `HIGH` or `CRITICAL` for at least the Security perspective (the
  hardcoded credentials and command injection are unambiguous). Whether
  the overall run is blocked depends on `RISK_THRESHOLD` (default `high`)
  and on the specific model's judgment — Bedrock reviews are not
  deterministic, so treat this as "should very likely trip it," not a
  guarantee for every run.
- See it in the same three places any real review shows up (documented in
  detail in the workspace's main README, "Where to find the review
  result" / "Measuring the review's effect over time"):
  - the `AgenticReview` CodeBuild project's logs
  - the `AgenticReviewOutput` pipeline artifact
  - if `reviewNotificationEnabled: true`, the SNS notification
  - the `AgenticReviewDashboard` CloudWatch dashboard (risk level / block
    rate for this run shows up there too)

## Cleaning up

```bash
node demo/inject-risky-change.js revert
git add src/index.js
git commit -m "revert: remove agentic review demo change"
git push origin develop
```

`revert` is idempotent — running it when nothing is applied just prints
"nothing to revert" and exits cleanly. `apply` refuses to run a second
time on top of itself (run `revert` first) so you can't end up with the
snippet duplicated.
