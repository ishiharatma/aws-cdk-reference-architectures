# API Gateway REST API → ALB over VPC Link v2 — Gotchas Worth Knowing

Verified while building and deploy-verifying `apigw-vpclink-private-alb` (ap-northeast-1,
aws-cdk-lib 2.270, October 2026).

## A REST API can target an ALB directly through a VPC link v2

The classic REST VPC link (`AWS::ApiGateway::VpcLink`, CDK `apigateway.VpcLink`) takes only an NLB.
A VPC link v2 (`AWS::ApiGatewayV2::VpcLink`, the HTTP API resource) can be used by a REST API
method, and the target can be an ALB. The CDK REST API L2 does not model it, so set these on the
L1 `CfnMethod` with `addPropertyOverride`: `Integration.ConnectionType = VPC_LINK`,
`Integration.ConnectionId = <v2 link id>`, `Integration.IntegrationTarget = <ALB ARN>`.

## `IntegrationTarget` takes the load balancer ARN, not the listener ARN

Passing the listener ARN fails the Method with `... is not a valid ALB or NLB arn` (400,
`InvalidRequest`) and rolls the stack back. The integration `Uri` stays an `http://<alb-dns>/{proxy}`
URL; it supplies the path and the `Host` header.

## Rollback noise: flow log role `CreateLogGroup` AccessDenied

After a failed first deploy, `cdk diagnose` showed the flow log role denied `logs:CreateLogGroup` on a
log group the stack was about to create. It appeared only during rollback; the successful deploy
had no such error.

## A local `tsc` emit breaks `tsx`-based CDK apps

Running `npx tsc` in a workspace (without `--noEmit`) leaves `.js` files next to the sources. The
`tsx`-run app then loads `parameters/environments` and `parameters` as different module copies and
fails with `No parameters found for environment: dev`. Delete the emitted files and use
`"app": "npx tsx bin/<name>.ts"` in `cdk.json` (the scaffold's `npx tsc && npx tsx` form hit this).
