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
- **A stray `tsc`-compiled `.js` file sitting next to a `.ts` module produces the
  exact same *"No parameters found for environment: dev"* error, even with the
  side-effect import correctly in place.** `tsc` (via `npm run build`) has no
  `outDir` configured in this repo's `tsconfig.base.json`, so it compiles `.js`/`.d.ts`
  files in place, right next to their `.ts` sources (they're gitignored — `*.js`/
  `*.d.ts` — so this never shows up as a tracked diff). The `stage:deploy:all`/`synth`
  scripts run the CDK app through `tsx`, which resolves a bare specifier like
  `parameters/environments` via this repo's `"*": ["./*"]` tsconfig path fallback.
  If a stale `parameters/environments.js` exists alongside `environments.ts`, some of
  the app's imports of `parameters/environments` can resolve to the compiled `.js`
  while others resolve to the `.ts` source — two different module instances, so the
  `params` object one file mutates (`params[Environment.DEVELOPMENT] = devParams`)
  is not the same object another file reads, and the reader sees an empty registry.
  Confirmed in `aws-eol-monitor`: running `npm run build` (for lint/typecheck) right
  before `npm run synth` reproduced this every time; deleting every non-`jest.config.js`
  `.js`/`.d.ts` file under the workspace (`find . -name "*.js" -not -path "./node_modules/*"
  -not -name "jest.config.js" -delete` and the `.d.ts` equivalent) before `synth`/`deploy`
  fixed it immediately, with no code change. Any workspace using this
  bare-specifier-registration pattern for its parameters should have its stray
  `.js`/`.d.ts` cleaned before a `synth`/`deploy` step in the same session as a
  `build`/`test` run.
- **Deleting a workspace's `jest.config.js`** while cleaning up stray build artifacts
  (a `find . -name "*.js" | xargs rm -f` run without excluding config files) breaks
  Jest with a confusing `SyntaxError: Missing initializer in const declaration` on a
  perfectly valid `const x: Type = value` line — Jest falls back to Babel's plain-JS
  parser instead of `ts-jest` once its own config file is gone, and the resulting
  parse error looks nothing like "config file missing." If this error shows up on a
  line that is unambiguously valid TypeScript, check for a missing `jest.config.js`
  before doubting the code.

## `NodejsFunction` bundling with `sourceMap: true` produces a non-reproducible asset hash across checkouts

A raw `expect(stackTemplate.toJSON()).toMatchSnapshot()` snapshot test that includes a
`lambdaNodejs.NodejsFunction` bundled with `sourceMap: true` can pass locally and still
fail in CI on the exact same code, with the diff being only the Lambda's `Code.S3Key`
(the CDK asset content hash). Root cause: esbuild's inline source map embeds a
**relative path from the bundling temp directory back to the source file**
(`sources: ["../../../workspaces/aws-cdk-reference-architectures/infrastructure/workspaces/<ws>/src/..."]`).
That relative path's exact string depends on the repo's absolute checkout location —
this repo's devcontainer checks out to `/workspaces/aws-cdk-reference-architectures`,
while a GitHub Actions runner checks out to
`/home/runner/work/aws-cdk-reference-architectures/aws-cdk-reference-architectures` — a
different number of path segments, so a genuinely different byte sequence gets zipped
into the asset, producing a different SHA-256 hash. The template's actual
infrastructure is identical; only the embedded debug metadata differs.

**Confirmed**: reproduced by re-running `cdk synth` on the *same* machine and seeing the
hash for a `sourceMap: true` asset change between invocations with different construct
nesting depth (a `Stage`-wrapped real deploy vs. a bare `Stack` in a unit test change
how many `../` segments separate the bundling temp dir from the repo root), and by
comparing a locally-committed snapshot against a GitHub Actions CI run of the identical
commit, where only the `S3Key` differed.

**Fix** (the pattern already used by `dynamodb-vector-search-semantic-api`, applied
retroactively to `s3-amplify-static-website` once its own `AmplifyDeployHandler`
function hit this): normalize the hash out of the snapshot before comparing, rather
than removing `sourceMap: true` (which is otherwise useful for readable stack traces
in CloudWatch Logs):

```typescript
const templateJson = JSON.parse(
  JSON.stringify(stackTemplate.toJSON()).replace(/"S3Key":"[0-9a-f]{64}\.zip"/g, '"S3Key":"<asset-hash>.zip"'),
);
expect(templateJson).toMatchSnapshot();
```

Any workspace adding a **new** `NodejsFunction` with `sourceMap: true` to a stack that
already has a snapshot test should apply this same normalization up front, rather than
discovering it via a CI-only failure after the PR is already open.

## `cdk init` inside the monorepo contaminates the root lock file

`cdk init` runs `npm install` in the new workspace, and inside this npm-workspaces monorepo that resolves the
latest majors (TypeScript 7, Jest 30) and writes them into the root `package-lock.json`. Deleting the
workspace's `node_modules` afterwards does not remove those lock entries: `npm ci` then fails with
"lock file not in sync", or CI fails with ts-jest's "typescript 7.0.2 does not expose the JavaScript
compiler API". `scripts/add-usecase.sh` now runs `cdk init --generate-only` (no install), pins the toolchain
in the workspace `package.json`, and runs `npm install --package-lock-only` at the root at the end. Also,
`cdk init` writes `"app": "npx tsc && npx tsx ..."`; the `tsc` step emits `.js` next to the sources and tsx
then loads two copies of the parameters module (`No parameters found for environment`), so the script
rewrites it to `npx tsx ...`.
