# Amazon ECS Gateway — IaC Gotchas, What ECS Builds, and Measurements

ECS Gateway is an account-level ingress resource (`hostSharedAlb` type): a platform team
creates gateways and associates them with clusters; services opt in with a gateway
connector, and ECS provisions shared ALBs, per-route ACM certificates,
`https://<id>.ecs.<region>.on.aws` hostnames, listener rules, target groups and security
groups. No charge for the gateway itself.

Deploy-verified in [`ecs-gateway-shared-ingress`](../../infrastructure/workspaces/ecs-gateway-shared-ingress/)
on 2026-10-23 (ap-northeast-1, Fargate, CloudFormation via CDK). Single runs.

Sources:
[Blog](https://aws.amazon.com/blogs/containers/introducing-amazon-ecs-gateway-a-fully-managed-ingress-solution-for-ecs-services/) /
[Create and manage](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/gateway-managing.html) /
[Connect services](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/gateway-connect-service.html) /
[Monitor](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/gateway-monitoring.html)

## IaC (CloudFormation / CDK)

- Types: `AWS::ECS::Gateway` (Ref/primary id = ARN; `GetAtt Arn`),
  `AWS::ECS::GatewayClusterAssociations` (`Gateway`, `Cluster`; both create-only) and the
  `GatewayConnectors` property of `AWS::ECS::Service`.
- **aws-cdk-lib 2.274.0 has no L1** for any of them. Use `CfnResource` for the gateway and
  association, `addPropertyOverride('GatewayConnectors', [...])` on `CfnService`.
- cfn-lint bundled with CDK reports `F3006 Unknown resource type` and
  `F3002 'GatewayConnectors' was unexpected` at synth. Acknowledge with
  `Validations.of(resource).acknowledge({ id: 'CloudFormation-Validate::F3006' | '...F3002', reason })`.
- **`PropagateTags` must be `NONE` for a CloudFormation-created gateway.** With the default
  `GATEWAY`, ECS copies the `aws:cloudformation:{stack-name,stack-id,logical-id}` tags to
  what it creates. `CreateLoadBalancer` accepted them, but `acm:RequestCertificate` failed
  with `InvalidTagException: Invalid Tag Key: "aws:cloudformation:logical-id". AWS internal
  tags cannot be changed with this API`. The gateway routes stayed `CREATE_IN_PROGRESS`,
  services stayed at 0 running tasks, CloudFormation waited, and ECS retried every 10–30 s
  (caller name `ECSGateway` in CloudTrail). Nothing surfaced in service events or route
  status — only CloudTrail showed it.
- Switching the gateway to `NONE` afterwards (`UPDATE_COMPLETE`) did **not** heal routes that
  were already being created: their retries kept the old tag set. Deleting the service stack
  and recreating the services fixed it.
- `DeletionProtection` defaults to **true** and is propagated to the managed ALBs; set
  `false` explicitly for stacks that are destroyed.
- Destroy order works with a plain stack dependency (services in a stack that depends on the
  gateway stack): deleting the services removed the routes and ECS deleted the ALBs
  (`currentAlbCount` back to 0) before the associations and gateways were deleted.
- Teardown: service delete 7–8 min each (300 s drain); ECS removed the routes, ALBs, target
  groups, ACM certificates and managed security groups. The Container Insights log group
  `/aws/ecs/containerinsights/<cluster>/performance` (created by ECS) is left behind.
- AWS CLI 2.38.3 has `ecs create-gateway`, `list-gateway-routes`, `describe-gateway-route`,
  `describe-gateway-resources`, `list-gateway-cluster-associations`.

## What ECS creates (observed)

- ALB per gateway, named `ecs-gateway-alb-<id>`; tags `AmazonECSManaged=true` and
  `aws:ecs:gateway-arn`. Up to 25 services per ALB, then a new ALB up to `MaxAlbCount`.
- Listener: **HTTPS 443 only**, `ELBSecurityPolicy-TLS13-1-2-Ext1-PQ-2025-09`, default
  action fixed-response 404 (an unknown `Host` gets 404).
- Per route: one ACM certificate (`AMAZON_ISSUED`, EC-prime256v1) for the route hostname,
  two listener rules — `host-header` and `host-header` + test header — and a production and
  an alternate target group (HTTP:80, `ip`, deregistration delay **300 s**, not exposed on
  the connector).
- Hostname `https://dr-<32 hex>.ecs.ap-northeast-1.on.aws`; random per route. A private
  gateway's hostname is a public DNS name that resolves to the internal ALB's private IPs.
- Security groups: the ALB gets an ECS-managed group (no inbound; egress 80 to the service
  groups) plus the gateway's `InboundSecurityGroup` if given (otherwise inbound 443 from
  `0.0.0.0/0` on the managed group). Each task ENI gets an **extra ECS-managed per-service
  group** (`ecs-gateway-service-sg-...`, inbound 80 from the ALB group). It is attached to the
  ENI but is not listed in the service's `networkConfiguration`, so the task group you pass
  needs no inbound rule.
- ALB attributes: access logs as configured, `desync_mitigation_mode` from the gateway,
  `drop_invalid_header_fields=false` (no gateway setting for it).

## Timings (ap-northeast-1)

| Step | Time |
| --- | --- |
| `AWS::ECS::Gateway` create | 32–33 s |
| `AWS::ECS::GatewayClusterAssociations` create | 3–9 s |
| Service created → ALB created | ~10 s |
| Service created → route `ACTIVE` (incl. ACM DNS validation) | ~3.5 min |
| `AWS::ECS::Service` CREATE_COMPLETE, ROLLING / CANARY | 4 min 22 s / 5 min 52 s |

## Progressive deployment with the test header (CANARY 10%, 5 min, bake 1 min)

- The gateway's `TestTrafficRules` header becomes a second listener rule per route
  (`host-header` + header, higher priority). Requests with the header hit the new revision
  as soon as it is healthy (~107 s after `update-service --force-new-deployment`) and for
  the whole canary window; requests without it were 19/190 = 10.0% new.
- Deployment took 9 min 8 s end to end; ~5 min of it is the 300 s deregistration delay of
  the managed target group, which the connector cannot change.
- Outside a deployment both rules point at the production target group. The first
  deployment of a CANARY service left the rule weights at production 0 / alternate 100
  (the "alternate" group is simply the live one at that point).
- Distinguish old/new revisions by the task hostname in the response (same image, same
  version) — no task definition change is needed to test the header.
