# CDK Pipelines — Gotchas Worth Knowing

Verified while building and deploy-verifying `cdk-pipelines-self-mutating`
(ap-northeast-1, aws-cdk-lib 2.270, single account, CodeCommit source, pipeline type V2,
September 2026).

## Self-mutation is observable: the running execution is cancelled and restarted

When a commit changes the pipeline definition, the `UpdatePipeline` stage runs `cdk deploy` on the
pipeline stack. With `restartExecutionOnUpdate: true` on the underlying `codepipeline.Pipeline`
the in-flight execution is superseded (its `UpdatePipeline` stage shows `Cancelled`) and a new
execution starts with the new definition. A reliable end-to-end proof is to push a commit that
adds a step and assert `aws codepipeline get-pipeline` now lists the new action. When you pass
your own `codePipeline:` to `pipelines.CodePipeline` (to own the artifact bucket), set
`restartExecutionOnUpdate: true` yourself.

## A tiny test can be the thing that blocks your self-mutation

The `Build` stage runs before `UpdatePipeline`, so a failing unit test stops the run before the
pipeline is updated or anything deploys. A test asserting "no `SecurityCheck` step exists" passed
for the default config and failed the moment the commit enabling that step arrived. Tests that
describe pipeline structure must follow the config that changes it (assert `includes(...) ===
FLAG`, not a constant).

## No `Assets` stage unless a stack has file/Docker assets

The stage list for an app whose only compute is an inline Lambda is `Source -> Build ->
UpdatePipeline -> <your stages>`. Do not assert an `Assets` stage in tests unless the app has
assets.

## `AWS::CodeCommit::Repository` `Code` is initial-commit-only

Seeding a repository with `codecommit.Code.fromAsset(asset, 'main')` only affects creation.
Editing the source directory and redeploying the repository stack does not add commits; the
repository must be changed with git or the CodeCommit API (`put-file` / `create-commit`, which
needs no git client and is handy for scripted verification).

## The pipeline does not delete what it deployed

Application stacks created by pipeline stages (e.g. `Dev`/`Prod`) are independent CloudFormation
stacks. Deleting the pipeline stack leaves them behind. Delete them first, then the pipeline stack
(a `codepipeline.Pipeline` with `autoDeleteObjects` on its artifact bucket empties itself), then
the repository stack.

## A V2 pipeline starts a run at creation

`aws codepipeline list-pipeline-executions` shows `trigger.triggerType = CreatePipeline` for the
first run: deploying the pipeline stack is itself the trigger, so the repository must already exist
and contain the app.

## Bake stack parameters into the synth command

`cdk synth -c project=<p> -c env=<e>` generated from the props used at first deploy is preserved
across self-mutations. Relying on `cdk.json` context or laptop environment variables makes the
pipeline synthesize something different from what was first deployed.
