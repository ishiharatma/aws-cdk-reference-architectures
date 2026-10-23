*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

# Amazon ECS Gateway: Shared Ingress Owned by the Platform Team - AWS CDK Reference Architecture

![Level 300](https://img.shields.io/badge/Level-300-orange)
![AWS CDK](https://img.shields.io/badge/AWS%20CDK-2.273-blue)
![Amazon ECS](https://img.shields.io/badge/Amazon%20ECS-Gateway-FF9900)

[Amazon ECS Gateway](https://aws.amazon.com/blogs/containers/introducing-amazon-ecs-gateway-a-fully-managed-ingress-solution-for-ecs-services/) is an account-level ingress resource. A platform team creates gateways (scheme, subnets, WAF, access logs, desync mode, test-traffic header) and associates them with clusters. An application team adds a **gateway connector** to its service and nothing else: ECS provisions the shared Application Load Balancer, a per-service ACM certificate, a `https://<id>.ecs.<region>.on.aws` hostname, listener rules, target groups and an ingress-only security group.

This architecture builds both sides with CDK and deploy-verifies them in ap-northeast-1: an internet-facing and an internal gateway on one cluster, two public services sharing one ALB, one internal-only service, and a CANARY deployment steered by the gateway's test header.

## 📑 Table of Contents

- [Architecture Overview](#️-architecture-overview)
- [Who owns what](#-who-owns-what)
- [Design Decisions and Best Practices](#-design-decisions-and-best-practices)
- [Verification Results](#-verification-results-deployed-to-ap-northeast-1)
- [Well-Architected Alignment](#️-well-architected-alignment)
- [Cost](#-cost)
- [Security Considerations](#-security-considerations)
- [Prerequisites](#-prerequisites)
- [Deployment](#-deployment)
- [Testing Strategy](#-testing-strategy)
- [Customization](#️-customization)
- [Troubleshooting](#-troubleshooting)
- [Cleanup](#-cleanup)
- [References](#-references)

## 🏗️ Architecture Overview

![Architecture](./overview.drawio.svg)

### Key Components

| Component | Owner | Role |
| --- | --- | --- |
| `AWS::ECS::Gateway` × 2 (`HostSharedAlb`) | Platform | `internet-facing` (access type PUBLIC) with WAF, ALB access logs and its own inbound security group; `internal` (PRIVATE) |
| `AWS::ECS::GatewayClusterAssociations` × 2 | Platform | Makes both gateways available to the cluster's services. Routes nothing by itself |
| Infrastructure role | Platform | Assumed by `ecs.amazonaws.com` with `AmazonECSInfrastructureRoleForGatewayHostSharedALB` (ELB/EC2 writes are limited to resources tagged `AmazonECSManaged=true`) |
| AWS WAF Web ACL (REGIONAL) | Platform | Common rule set, known bad inputs, rate limit. Attached by ECS to every ALB of the public gateway |
| S3 bucket | Platform | ALB access logs (SSE-S3, 30 days). One bucket for every service on the gateway; the hostname in each record tells them apart |
| Fargate services `web`, `orders` | App | Connector filter `PUBLIC`. Share one ALB through host-based routing. `web` uses CANARY 10% |
| Fargate service `internal-api` | App | Connector filter `PRIVATE`. Reachable only through the internal ALB |
| Probe Lambda (in the VPC) | App | Calls internal hostnames from inside the VPC for `test-gateway.sh` |
| `test-gateway.sh` | — | `status` / `probe` / `canary` operational checks |

### Stacks

| Stack | Contents |
| --- | --- |
| `<project>-<env>-ecs-gateway-platform` | VPC (2 AZs, public + private, 1 NAT), cluster (Container Insights), infrastructure role, WAF, log bucket, inbound security group, 2 gateways, 2 associations |
| `<project>-<env>-ecs-gateway-app` | 3 task definitions and Fargate services with gateway connectors, probe Lambda |

The app stack depends on the platform stack: a connector is rejected unless an ACTIVE association exists, and on destroy the services must go first because an association stays `DISASSOCIATING` until every gateway route on the cluster is removed.

## 👥 Who owns what

The application stack contains no load balancer, listener, target group, certificate, DNS record or security group rule. Its whole ingress definition is:

```typescript
// lib/constructs/gateway-connected-service.ts
cfnService.addPropertyOverride('GatewayConnectors', [{
  PortName: 'web',                                   // named port in the task definition
  Filters: { AccessTypes: ['PRIVATE'] },             // which gateways may serve this service
  HealthCheck: { HealthCheckPath: '/', HealthCheckIntervalSeconds: 10, Matcher: { HttpCode: '200' } },
}]);
```

The platform stack decides everything a service inherits:

```typescript
// lib/constructs/ecs-gateway.ts (aws-cdk-lib has no L1 for the gateway yet)
new cdk.CfnResource(this, 'Resource', {
  type: 'AWS::ECS::Gateway',
  properties: {
    GatewayName: 'drillexercises-dev-ecsgw-public',
    InfrastructureRoleArn: infrastructureRole.roleArn,
    DeletionProtection: false,      // default true, and propagated to the ALBs
    PropagateTags: 'NONE',          // see design decision 3
    Configuration: { HostSharedAlb: {
      Scheme: 'internet-facing',
      NetworkConfiguration: { Subnets: [...publicSubnetIds], IpAddressType: 'ipv4', InboundSecurityGroup: sgId },
      WebACLArn: webAcl.attrArn,
      AccessLogs: { Destination: { S3: { Bucket: bucket.bucketName, Prefix: 'gateway-public' } } },
      HttpDesync: 'defensive',
      MaxAlbCount: 2,
      TestTrafficRules: { Header: { Name: 'x-test-traffic', Values: ['canary'] } },
    } },
  },
});
```

| Concern | Who decides | Where |
| --- | --- | --- |
| Internet-facing or internal, subnets / AZs, IP type | Platform | Gateway (immutable after creation) |
| WAF, access logs, desync mode, inbound CIDRs, max ALBs | Platform | Gateway (mutable, applied to every ALB) |
| Test traffic header for progressive deployments | Platform | Gateway (`TestTrafficRules`) |
| Which clusters can use the gateway | Platform | Cluster association |
| Port, health check, PUBLIC/PRIVATE acceptance | App | Gateway connector |
| Deployment strategy (ROLLING / BLUE_GREEN / CANARY / LINEAR) | App | Service |

An application team needs neither `iam:PassRole` nor `elasticloadbalancing:*` to get an HTTPS endpoint.

## 🎯 Design Decisions and Best Practices

### 1. Two gateways, filtered by access type

A connector does not name a gateway. A service connects to **every** gateway associated with its cluster that matches its access type filter, is in the same VPC and covers every AZ the service runs in. Two consequences shape this design:

- `internal-api` filters on `PRIVATE`. Without the filter it would also get a public hostname on the internet-facing gateway — and a public gateway associated with the cluster *later* would expose it on its next deployment. The documentation calls this out; a service that must never be public has to say so.
- Both gateways use the same two AZs as the service subnets (public subnets for the internet-facing one, private subnets for the internal one). A gateway that misses an AZ is silently ineligible.

### 2. CloudFormation resources without a CDK L1

aws-cdk-lib 2.274.0 (latest at the time of writing) has no `CfnGateway` and no `gatewayConnectors` on `CfnService`. The gateway and the association are `CfnResource`, the connector is `addPropertyOverride('GatewayConnectors', ...)`. The cfn-lint schema bundled with CDK does not know them either, so `cdk synth` reports `F3006 Unknown resource type` / `F3002 'GatewayConnectors' was unexpected`; they are acknowledged with `Validations.of(resource).acknowledge(...)` on the exact resources.

### 3. `PropagateTags: NONE` (the default `GATEWAY` breaks CloudFormation-created gateways)

A gateway created by CloudFormation carries the `aws:cloudformation:stack-name`, `stack-id` and `logical-id` tags. With the default `PropagateTags: GATEWAY`, ECS copied those to the infrastructure it creates. The ALB was created, but every `acm:RequestCertificate` failed with `InvalidTagException: Invalid Tag Key: "aws:cloudformation:logical-id". AWS internal tags cannot be changed with this API`, and the gateway routes stayed `CREATE_IN_PROGRESS` (the services ran no tasks) while ECS retried every 10–30 seconds.

Changing the gateway to `NONE` afterwards did **not** fix the routes that were already being created: their retries kept sending the old tags. The services had to be deleted and recreated. With `NONE` from the start, the requests carry only `AmazonECSManaged=true` and the routes become `ACTIVE` in about 3.5 minutes.

Trade-off: the project tags no longer reach the ALBs. ECS still tags each ALB with `aws:ecs:gateway-arn`, which is the tag the documentation recommends for selecting resources in alarms and dashboards.

### 4. Restrict the shared ALBs with the platform's own inbound security group

By default ECS creates a security group allowing 443 from anywhere. `InboundSecurityGroup` replaces that: ECS attaches the given group to the ALBs and stops managing inbound rules. Because the ALBs are shared, this applies to every service on the gateway, which is exactly the platform-team control wanted here (the dev environment allows only the deploying machine's IP). The group needs no egress rule: ECS's own ALB group carries the egress to the tasks.

### 5. CANARY with the gateway's test header

`web` uses `CANARY` (10%, 5 minutes) and a 1-minute bake time. The gateway's `TestTrafficRules` header (`x-test-traffic: canary`) is the same for every service behind the gateway; the platform owns it and the application team only needs to know it. Health check settings cannot change on a `ROLLING` service (a change replaces the target group), so they are set when the connector is first created.

### 6. Private tasks, NAT for egress

Tasks run in private subnets without public IPs. The internal gateway also uses the private subnets. One NAT gateway serves image pulls and logs in dev; use one per AZ (or VPC endpoints) in production.

## 🔬 Verification Results (deployed to ap-northeast-1)

Deployed on 2026-10-23 to `drillexercises-dev`, AWS CLI 2.38.3, aws-cdk-lib 2.273.0. Single runs.

### 1. Provisioning timeline

| Step | Time |
| --- | --- |
| `AWS::ECS::Gateway` create (CloudFormation) | 32–33 s each; no ALB yet (`currentAlbCount` 0) |
| `AWS::ECS::GatewayClusterAssociations` create | 3–9 s |
| First service created → ALB `CreateLoadBalancer` call | ~10 s |
| Service created → gateway route `ACTIVE` | ~3.5 min (ACM DNS validation of the per-route certificate) |
| CloudFormation `AWS::ECS::Service` complete (ROLLING) | 4 min 22 s |
| CloudFormation `AWS::ECS::Service` complete (CANARY, first deployment) | 5 min 52 s |

### 2. What ECS built

| Item | Observed |
| --- | --- |
| ALBs | 1 per gateway: the public one carries 2 routes (`web`, `orders`), the private one 1 |
| Hostname | `https://dr-<32 hex>.ecs.ap-northeast-1.on.aws`, random per route |
| Listener | HTTPS 443 only, `ELBSecurityPolicy-TLS13-1-2-Ext1-PQ-2025-09`, default action fixed 404 |
| Listener rules per route | 2: `host-header` (production) and `host-header` + `x-test-traffic: canary` (test) |
| Certificate | One ACM certificate per route (`AMAZON_ISSUED`, EC-prime256v1, issuer Amazon ECDSA 256 M01) |
| Target group | HTTP:80, target type `ip`, health check from the connector, deregistration delay **300 s** (not configurable through the connector) |
| ALB attributes | access logs on, `desync_mitigation_mode=defensive`, `deletion_protection=false`, `drop_invalid_header_fields=false` |
| Security groups | ALB: ECS-managed group (no inbound, egress 80 to the service groups) + the platform inbound group. Tasks: the service's own group **plus an ECS-managed per-service group** allowing 80 from the ALB group only. The managed group is attached to the ENI but does not appear in the service's network configuration |

### 3. Behavior

| Check | Result |
| --- | --- |
| Public hostnames from the internet (allowed IP) | `web`, `orders`: HTTP 200, `Host` = the route hostname |
| Unknown `Host` on the shared public ALB | HTTP 404 (listener default) |
| Plain HTTP (`http://<host>`) | No answer (no listener on 80) |
| Private hostname from the internet | Resolves publicly to **private IPs** (10.94.x.x); connection fails |
| Private hostname from the probe Lambda in the VPC | HTTP 200 from `internal-api` |
| WAF: `User-Agent: ${jndi:ldap://...}` / `?file=../../etc/passwd` | 403 / 403 |
| ALB access logs | Delivered under `gateway-public/AWSLogs/<account>/elasticloadbalancing/...` within 5 minutes |

### 4. CANARY deployment and the test header

`./test-gateway.sh ... canary` forces a new deployment of `web` and samples its URL every 15 seconds, 10 requests with and 10 without the test header, classifying each answer as an old or a new task.

| Elapsed (approx.) | Phase | Without header (old/new) | With `x-test-traffic: canary` (old/new) |
| --- | --- | --- | --- |
| 0–90 s | new tasks starting | 10/0 | 10/0 |
| 107 s | new revision healthy, test rule switched | 10/0 | **0/10** |
| 136–429 s (19 samples) | canary 10% for 5 min | **171/19 (10.0% new)** | 0/10 every time |
| 446–582 s | production shifted, bake time + deregistration | 0/10 | 0/10 |
| 599 s | `COMPLETED` | 0/10 | 0/10 |

- The test header reached the new revision as soon as it was healthy and for the whole canary window; requests without it were split 90/10.
- ECS reports the deployment from 15:10:57 to 15:20:05 (9 min 8 s): ~1.5 min of task start, 5 min canary, 1 min bake, and the rest is the old targets draining with the fixed 300 s deregistration delay.
- Outside a deployment the test rule forwards to the production target group, so the header does nothing.

### 5. Teardown

`stage:destroy:all` took 21 min 49 s for both stacks and left nothing ECS created (no gateway, ALB, target group, ACM certificate or `AmazonECSManaged` security group).

| Step | Time |
| --- | --- |
| `AWS::ECS::Service` delete (`internal-api`, `orders` / `web`) | 7 min 57 s / 7 min 5 s (300 s deregistration drain) |
| VPC Lambda (probe) delete | ~20 min (hyperplane ENI release; the longest step) |
| Platform stack (associations, gateways, VPC) | ~1 min |

The Container Insights log group `/aws/ecs/containerinsights/<cluster>/performance` is created by ECS, not by the stack, and remains after destroy; delete it by hand.

## 🏛️ Well-Architected Alignment

| Pillar | How this architecture addresses it |
| --- | --- |
| Operational Excellence | Ingress standards live in one place (the gateway); `test-gateway.sh status/probe/canary` checks routes, ALBs and the progressive deployment; ALB access logs and Container Insights |
| Security | WAF on every public ALB through the gateway, HTTPS-only listener with a TLS 1.3 policy, platform-owned inbound CIDRs, tasks reachable only from the ALB's group, internal service filtered to `PRIVATE`, app teams need no ELB/IAM pass-role permissions |
| Reliability | Gateways and services cover the same 2 AZs; deployment circuit breaker with rollback; CANARY with a test header and bake time |
| Performance Efficiency | ARM64 Fargate tasks; up to 25 services per ALB and `MaxAlbCount` ALBs per gateway |
| Cost Optimization | One ALB per 25 services instead of one per service; ECS removes an ALB when its last route leaves |
| Sustainability | Fewer idle load balancers, Graviton tasks |

## 💰 Cost

ap-northeast-1, on-demand list prices, 730 hours/month, light traffic. ECS Gateway itself has no charge.

| Item | Calculation | Monthly (USD) |
| --- | --- | --- |
| ALB × 2 (public + internal) | 2 × $0.0243/h × 730 | ~35.5 |
| ALB LCU | light traffic, ~1 LCU-h/h each | ~11.7 |
| Public IPv4 (public ALB in 2 AZs + NAT) | 3 × $0.005/h × 730 | ~11.0 |
| NAT gateway | $0.062/h × 730 + data | ~45.3 |
| Fargate ARM64 0.25 vCPU / 0.5 GB × 4 tasks | 4 × (0.25 × $0.04045 + 0.5 × $0.00442) × 730 | ~36.0 |
| WAF | $5 Web ACL + 3 × $1 rules + $0.60/M requests | ~8.0 |
| ACM public certificates | used with ALB | 0 |
| CloudWatch Logs, Container Insights, S3 logs, Lambda | small | ~3 |
| **Total (dev)** | | **~150** |

The gateway's value grows with the number of services: 20 public services cost one ALB (~$17.7 + LCU) instead of twenty (~$355 + LCU). The limit is 25 services per ALB; beyond that ECS adds ALBs up to `MaxAlbCount`.

Production: one NAT gateway per AZ (or VPC endpoints for ECR/Logs/S3), 2+ tasks per service, and a higher `MaxAlbCount`.

## 🔒 Security Considerations

- **Default inbound is open**: without `InboundSecurityGroup` the ECS-managed group allows 443 from `0.0.0.0/0`. WAF still applies, but decide this explicitly.
- **Access type filter**: any service that must stay private filters on `PRIVATE` (see design decision 1).
- **Private hostnames are public DNS names** that resolve to private IPs. The names are random but not secret.
- **`drop_invalid_header_fields` is false** on the managed ALBs and is not a gateway setting. Changing it on the ALB directly is an out-of-band change ECS does not track (`AmazonECSManaged` resources should not be modified).
- **Deletion protection** defaults to true and is propagated to the ALBs. This stack sets `false` so that `cdk destroy` works; keep `true` in production.
- **IAM**: the infrastructure role uses the AWS managed policy whose write actions are conditioned on `aws:ResourceTag/AmazonECSManaged=true`. Only the platform pipeline needs `iam:PassRole` on it.

CDK Nag suppressions (all in `test/compliance/cdk-nag.test.ts`): IAM4 (AWS managed policies: gateway infrastructure role, Lambda basic/VPC roles), IAM5 (execution role log-stream wildcard), S1 (the access log bucket itself), ECS2 (environment variables are a service name and a version label).

## 📋 Prerequisites

- AWS CLI **2.38 or later** (`aws ecs create-gateway` and friends; older CLIs lack the commands used by `test-gateway.sh`)
- Node.js 24, AWS CDK CLI, a bootstrapped account
- `jq`, `curl`, `dig` for `test-gateway.sh`

## 🚀 Deployment

```bash
cd infrastructure/workspaces/ecs-gateway-shared-ingress

# Allowed client IPs for the public gateway (defaults to this machine's global IP)
export ALLOWED_IPS=203.0.113.10

PROJECT=myproject ENV=dev npm run stage:deploy:all -- --require-approval never
```

The first deploy takes about 10 minutes (platform ~3 min, app ~6 min).

## Usage (test-gateway.sh)

```bash
./test-gateway.sh --project myproject --env dev status   # gateways, associations, routes, ALBs
./test-gateway.sh --project myproject --env dev probe    # call every route (private ones via the probe Lambda)
./test-gateway.sh --project myproject --env dev canary   # force a CANARY deployment of web and sample it
```

## 🧪 Testing Strategy

```bash
npm test -w workspaces/ecs-gateway-shared-ingress
```

| Suite | Covers |
| --- | --- |
| `test/unit/platform-stack.test.ts` | Two gateways and their schemes/subnets, `DeletionProtection: false`, `PropagateTags: NONE`, WAF/logs/inbound group only on the public gateway, associations, infrastructure role and its dependency, WAF rules, log bucket policy |
| `test/unit/app-stack.test.ts` | One connector per service on the named port, `PUBLIC`/`PRIVATE` filters and the no-filter case, health check, no ELB resources, awsvpc + named port, CANARY/ROLLING settings, private placement, no inbound rules on task groups, probe function |
| `test/snapshot/snapshot.test.ts` | Full templates and resource counts for both stacks |
| `test/compliance/cdk-nag.test.ts` | AwsSolutions pack with documented suppressions |

## ⚙️ Customization

| Parameter (`parameters/dev-params.ts`) | Effect |
| --- | --- |
| `platform.publicGateway.restrictIngressToAllowedIps` | `false` lets ECS manage a 0.0.0.0/0:443 rule |
| `platform.publicGateway.accessLogs` / `wafRateLimit` | Access log bucket / WAF rate rule limit |
| `platform.*Gateway.maxAlbCount` / `httpDesync` | ALB ceiling (25 services each) / desync mode |
| `platform.*Gateway.ipAddressType` | `ipv4`, `dualstack`, `dualstack-without-public-ipv4` (immutable) |
| `platform.testTrafficHeader` | Header that reaches the new revision during a deployment |
| `app.services[]` | Name, `accessTypes`, desired count, `ROLLING` / `BLUE_GREEN` / `CANARY` and timings |
| `app.version` | Value returned by every service; changing it deploys all services |

Immutable gateway settings (name, scheme, subnets, IP type, port, protocol) are replaced by CloudFormation. Because a connector does not name a gateway, plan such a change as "create the new gateway, associate it, redeploy services, remove the old one".

## 🔧 Troubleshooting

| Symptom | Cause / action |
| --- | --- |
| Route stays `CREATE_IN_PROGRESS`, no tasks start | Look in CloudTrail for `RequestCertificate` errors by `ECSGateway`. `InvalidTagException` on `aws:cloudformation:*` → `PropagateTags: NONE`, then delete and recreate the service |
| Service create rejected | No `ACTIVE` association on the cluster, or no gateway matches the access type / VPC / AZs |
| Route `ACTIVE` but 503 | Targets unhealthy: `aws elbv2 describe-target-health` on the target group from `describe-service-revisions` |
| Health check change fails on a ROLLING service | `Target group properties cannot be changed with ROLLING deployment strategy`: use BLUE_GREEN/CANARY or recreate |
| Private URL times out from your PC | Expected: it resolves to private IPs. Use `test-gateway.sh probe` |
| `test-gateway.sh`: no gateway commands | Update the AWS CLI to 2.38+ |

First step for any symptom: `./test-gateway.sh --project <p> --env <e> status`.

## 🧹 Cleanup

```bash
PROJECT=myproject ENV=dev npm run stage:destroy:all
```

The app stack is deleted first (services → routes → ALBs), then the platform stack.

## 📚 References

- [Introducing Amazon ECS Gateway (AWS Blog)](https://aws.amazon.com/blogs/containers/introducing-amazon-ecs-gateway-a-fully-managed-ingress-solution-for-ecs-services/) / [Japanese](https://aws.amazon.com/jp/blogs/news/introducing-amazon-ecs-gateway-a-fully-managed-ingress-solution-for-ecs-services/)
- [Create and manage an Amazon ECS Gateway](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/gateway-managing.html)
- [Connect Amazon ECS services to a gateway](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/gateway-connect-service.html)
- [Monitor a gateway](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/gateway-monitoring.html)
- [AWS::ECS::Gateway](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ecs-gateway.html) / [AWS::ECS::GatewayClusterAssociations](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ecs-gatewayclusterassociations.html) / [AWS::ECS::Service GatewayConnector](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-ecs-service-gatewayconnector.html)
- [AmazonECSInfrastructureRoleForGatewayHostSharedALB](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonECSInfrastructureRoleForGatewayHostSharedALB.html)
- Knowledge base: [docs/knowledge/ecs-gateway.md](../../../docs/knowledge/ecs-gateway.md)

---

**Level 300** · Part of [AWS CDK Reference Architectures](../../../README.md)
