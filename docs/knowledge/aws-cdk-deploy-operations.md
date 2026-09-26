# CDK / Deploy Operations — Gotchas

Operational issues hit repeatedly while deploy-verifying architectures in this repo —
not about what to build, but about the mechanics of actually getting a `cdk deploy` to
run cleanly against a real AWS account.

## `cdk deploy --all` silently finds zero stacks across `cdk.Stage` boundaries

With this repo's CDK CLI version (2.1138.0 as last checked), `cdk deploy --all` does
**not** expand across `cdk.Stage` nesting — every workspace in this repo wraps its
stacks in a `Stage` (`FisChaosXDev`, etc.), so `--all` reports *"No stack found in the
main cloud assembly"* even though `cdk list` correctly shows all the stacks. Use
`cdk deploy '**'` (and `cdk destroy '**'`) instead — this is why every workspace's
`package.json` in this repo defines `stage:deploy:all` / `stage:destroy:all` using the
glob form, not `--all`. Don't "fix" a workspace back to `--all`; it will silently stop
deploying anything.

## The bundled CDK CLI can't refresh an expired SSO token

This repo's CDK install (via the SDK-JS credential chain) cannot refresh an SSO token
that has expired mid-session, even when the plain `aws` CLI still works fine with the
same profile. Symptom: `cdk deploy`/`destroy` fails with
`Unable to resolve AWS account to use...` or a credentials error, while
`aws sts get-caller-identity --profile <p>` succeeds. This happens even when the SSO
session is objectively still valid (not actually expired) — it's specifically a
gap in how the bundled CDK resolves credentials via `--profile`, not a real
authentication failure.

**Workaround**: run `cdk` *without* `--profile`, feeding it real temporary credentials
via environment variables instead:

```bash
eval "$(aws configure export-credentials --profile <profile> --format env)"
npx cdk deploy '**' --app "npx ts-node --prefer-ts-exts bin/<app>.ts" \
  -c project=<project> -c env=<env> --require-approval never
```

The exported credentials are valid for up to ~1 hour — long enough for most deploys,
but a long CloudFront/Aurora teardown can outlast them; for long-running destroys,
prefer `aws cloudformation delete-stack` + poll (the plain CLI auto-refreshes) over a
single long `cdk destroy` invocation.

## A shell `ENV` variable silently overrides `-c env=`

This repo's `bin/*.ts` files resolve the environment as
`process.env.ENV || app.node.tryGetContext("env")`, so an `ENV` already exported in the
shell (e.g. `ENV=local` from a dev container) wins over `-c env=dev` and fails with
`No parameters found for environment: local`. This also breaks `cdk bootstrap`, because
the app in `cdk.json` is executed even for an explicit `aws://account/region`. Set
`ENV` (and `PROJECT_NAME`) explicitly when running `cdk` by hand.

## `cdk.out` lock conflicts from stale background processes

Running a new `cdk deploy`/`destroy` against a `cdk.out` directory that a previous
invocation is still using (e.g., a background-run deploy you forgot was still going)
fails with *"Other CLIs (PID=...) are currently reading from cdk.out"*. Before starting
a new deploy/destroy against the same workspace, confirm no earlier background process
is still running (`ps aux | grep cdk`) — **check the underlying CloudFormation stack
status first** (`aws cloudformation describe-stacks`) before assuming a CLI process is
truly stale and killing it: a `cdk deploy '**'` that's midway through deploying a
*later* stack in the same Stage (e.g., already past `-base` and working on `-app`) can
look "stuck" from the CLI's silent, fully-buffered output alone, when the underlying
CloudFormation operations are actually progressing fine. Killing that process doesn't
harm the in-progress CloudFormation stack (AWS keeps applying the change independently
of whether the local CLI is still watching), but it does mean you now have to manually
resume the remaining stacks yourself rather than the same `cdk deploy '**'` invocation
finishing the whole Stage.

## Backgrounded `cdk` output is fully buffered — silence doesn't mean it's stuck

When a `cdk deploy`/`destroy` is run in the background (this environment's
`run_in_background`), its stdout often doesn't appear in the output file until the
*entire* command exits — polling the output file mid-run can show nothing for
15+ minutes even while the deploy is progressing normally. **Poll the actual
CloudFormation stack status** (`aws cloudformation describe-stacks` /
`describe-stack-events`) to judge real progress, not the CLI's own output file.
Aurora Serverless v2 cluster/instance creation and deletion in particular can each
take 10–20 minutes with long quiet gaps between CloudFormation events — this is normal,
not a hang.

## Incidental `package-lock.json` churn from `npm install` at the infra workspace root

Running `npm install` at the `infrastructure/` root (e.g., after adding a new
workspace) can touch `infrastructure/package-lock.json` even for unrelated packages —
usually harmless `peer: true` metadata normalization from a newer local npm version.
Before committing, check `git diff infrastructure/package-lock.json`: if it's only
adding entries for a workspace you actually added, it's legitimate; if it's touching
unrelated packages' metadata, `git checkout --` it to avoid unrelated diff noise in
the PR.

## Two silent-typecheck-only failure modes worth knowing

- **Missing `import 'parameters';` side-effect import** in a workspace's `bin/*.ts`
  causes `npm run deploy` to fail immediately with *"No parameters found for
  environment: dev"*, even though the parameters file itself is correct — the
  environment-registration `params[Environment.DEVELOPMENT] = devParams` line in
  `dev-params.ts` only runs if something actually imports that module for its side
  effect. `tsc`/`npm run build` won't catch this (nothing is type-unsound), only a
  real deploy attempt surfaces it.
- **Deleting a workspace's `jest.config.js`** while cleaning up stray build artifacts
  (a `find . -name "*.js" | xargs rm -f` run without excluding config files) breaks
  Jest with a confusing `SyntaxError: Missing initializer in const declaration` on a
  perfectly valid `const x: Type = value` line — Jest falls back to Babel's plain-JS
  parser instead of `ts-jest` once its own config file is gone, and the resulting
  parse error looks nothing like "config file missing." If this error shows up on a
  line that is unambiguously valid TypeScript, check for a missing `jest.config.js`
  before doubting the code.
