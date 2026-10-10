# ECS Blue/Green: Native versus CodeDeploy — Measured Facts and Gotchas

Verified while deploy-verifying `ecs-blue-green-native-vs-codedeploy` (ap-northeast-1, Fargate ARM64, aws-cdk-lib 2.270,
AWS CLI 2.36, October 2026).

## Native blue/green is in the CDK L2

`FargateService({ deploymentStrategy: ecs.DeploymentStrategy.BLUE_GREEN, bakeTime })`,
`service.addLifecycleHook(new ecs.DeploymentLifecycleLambdaTarget(fn, id, { lifecycleStages: [...] }))` and
`service.loadBalancerTarget({ ..., alternateTarget: new ecs.AlternateTarget(id, { alternateTargetGroup, productionListener, testListener }) }).attachToApplicationTargetGroup(blue)`.
The listeners must route through **listener rules** (`ecs.ListenerRuleConfiguration.applicationListenerRule(rule)`), not a default action.
CodeDeploy needs the `CODE_DEPLOY` controller and `codedeploy.EcsDeploymentGroup`.

## Observing a native deployment

`aws ecs list-service-deployments --cluster C --service S` (newest first) and
`aws ecs describe-service-deployments --service-deployment-arns <arn>`: `status` is `IN_PROGRESS` through the bake
(`lifecycleStage: BAKE_TIME`), then `SUCCESSFUL`; a failed hook ends as `ROLLBACK_SUCCESSFUL` with a `statusReason`
naming the stage and the hook target. The new deployment appears in the list a moment after `update-service`; a script that
reads the list immediately watches the previous (finished) deployment.

## Timing (2 tasks, a 25 s hook, 2 minute bake/wait)

| | Native | CodeDeploy |
|---|---|---|
| Production serves the new version | about 170 s | about 168 s |
| Deployment ends | about 310 s | about 277 s |
| Failing hook: gives up after | 205 to 260 s | 155 s |
| Rollback during the bake/wait: back on the old version | 20 to 21 s | 14 s |

No HTTP error response was seen at 5 requests per second across the shifts and rollbacks on either flavor.

## Rollback commands

Native: `aws ecs stop-service-deployment --service-deployment-arn <arn> --stop-type ROLLBACK`.
CodeDeploy: `aws deploy stop-deployment --deployment-id <id> --auto-rollback-enabled`; a failed deployment with automatic
rollback starts a second deployment (`rollbackInfo.rollbackDeploymentId`).

## Hooks: two protocols, one function

Native hooks RETURN `{ "hookStatus": "SUCCEEDED" | "FAILED" | "IN_PROGRESS", "reason": ... }`. CodeDeploy hooks (the event has
`DeploymentId` and `LifecycleEventHookExecutionId`) REPORT with `codedeploy:PutLifecycleEventHookExecutionStatus`
and the CodeDeploy service role needs `lambda:InvokeFunction` on the function. For the ECS AppSpec the test-traffic hook is
`AfterAllowTestTraffic`.

## A container that exits is not given up on (within 7 minutes)

A release whose container exits immediately did not fail by itself within 7 minutes on either flavor; production stayed
on the old version. A deployment timeout, a CloudWatch alarm or a circuit breaker is needed, and was not exercised here.

## One CodeDeploy deployment at a time per deployment group

A second `create-deployment` is refused while one (including its rollback deployment) is running: wait for it to end.

## Two flavors driven in parallel need separate state

A shared SSM "verdict" parameter made the CodeDeploy hook fail because the native scenario had set it to `fail`
at the same moment. Use one parameter per flavor.

## curl noise is not a deployment failure

A probe from a dev container saw about one no-response (`000`, 2 s timeout) a minute, in steady state as well. Count HTTP error
responses separately, and judge no-response probes by whether they cluster around a version change.

## Bash: command substitution loses variables

A function called as `st="$(state "$f")"` runs in a subshell, so variables it sets (`STATE_DETAIL`) are lost, and under
`set -u` the script dies later. Call the function directly and read its result from a global. `set -e` also ends a
background run on the first failing step; use `set +e` in a function that must record every outcome.
