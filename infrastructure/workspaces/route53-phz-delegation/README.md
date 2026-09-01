# Route 53 Private Hosted Zone Delegation - AWS CDK Reference Architecture

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **Level: 300 (Advanced)**

A parent private hosted zone (`system.example.com`) delegates two subdomains (`dev.system.example.com`,
`stg.system.example.com`) to two other VPCs, using the June 2025 **Route 53 Resolver DNS delegation** feature:
`INBOUND_DELEGATION` endpoints on the child VPCs and a `DELEGATE` resolver rule on the parent's outbound endpoint,
tied together with ordinary NS + glue records in the parent zone. A fourth on-premises-role VPC forwards *only*
the parent domain to the hub, with no per-child conditional forwarder, and all four VPCs are joined by one Transit
Gateway.

## 📑 Table of Contents

- [Architecture Overview](#architecture-overview)
- [Design Decisions & Best Practices](#design-decisions--best-practices)
- [Cost Optimization](#cost-optimization)
- [Security Considerations](#security-considerations)
- [Prerequisites](#prerequisites)
- [Deployment Guide](#deployment-guide)
- [Testing Strategy](#testing-strategy)
- [Customization](#customization)
- [Troubleshooting](#troubleshooting)
- [References](#references)

## 🏗️ Architecture Overview

![Architecture Diagram](overview.drawio.svg)

```text
                              ┌───────────────────────────────┐
                              │        Transit Gateway         │
                              └───┬───────┬────────┬───────┬───┘
        HubVpc 10.0.0.0/16        │  DevVpc 10.1.0.0/16     │  StgVpc 10.2.0.0/16
        ├─ Private (test EC2, SSM │  ├─ Resolver /27 x2 AZ  │  ├─ Resolver /27 x2 AZ
        │   endpoints)            │  │   Inbound-Delegation  │  │   Inbound-Delegation
        ├─ Resolver /27 x2 AZ     │  │                       │  │
        │   ├─ Inbound endpoint ◄─┼──┼── forwards system.*   │  │
        │   └─ Outbound endpoint ─┼──┤   PHZ dev.system.*    │  │  PHZ stg.system.*
        ├─ Tgw /28 x2 AZ          │  └─ Tgw /28 x2 AZ        │  └─ Tgw /28 x2 AZ
        PHZ system.example.com    │                          │
          NS dev.system.*  → ns-dev-{1,2}.system.* (glue: DevVpc delegation endpoint IPs)
          NS stg.system.*  → ns-stg-{1,2}.system.* (glue: StgVpc delegation endpoint IPs)
        ResolverRule DELEGATE(system.example.com) on Outbound endpoint: one rule, both children
                              │
        OnPremVpc 10.3.0.0/16 │  ("on-premises role")
        ├─ Private (BIND9 forwarder, SSM endpoints: system.example.com → HubVpc Inbound endpoint IPs)
        └─ Tgw /28

No Internet Gateway / NAT Gateway anywhere. Every subnet is PRIVATE_ISOLATED.
```

### DNS Resolution Sequence

The diagrams above show static topology; they don't make clear *in what order* a query actually gets resolved. [`resolution-sequence.drawio.svg`](resolution-sequence.drawio.svg) walks through that order step by step, for both the delegation path (HubTestInstance → HubVpc resolver → NS/glue lookup → `ParentDelegateRule` → Transit Gateway → DevVpc's delegation endpoint) and the on-premises BIND9 path, which rejoins the same flow at HubVpc's regular inbound endpoint.

![DNS Resolution Sequence](resolution-sequence.drawio.svg)

### Key Components

| Component | Role |
|-----------|------|
| **`ResolverEndpointConstruct`** (`@common/constructs/route53/resolver-endpoint`) | Shared with [`route53-resolver-endpoints`](../route53-resolver-endpoints/): here it creates HubVpc's regular inbound + outbound endpoints and DevVpc/StgVpc's `INBOUND_DELEGATION` endpoints (Do53-only, static IPs). |
| **`TransitGatewayConstruct`** (`@common/constructs/vpc/transit-gateway`) | Joins all four VPCs into one shared TGW route table (same pattern as the [`transit-gateway`](../transit-gateway/) workspace). |
| **`VpcConstruct`** (`@common/constructs/vpc/vpc`) | Builds each VPC's subnet groups: `Private` (workload + SSM endpoints, Hub/OnPrem only), `Resolver` (Hub/Dev/Stg only), `Tgw` (all four). Every subnet is `PRIVATE_ISOLATED`, with no Internet Gateway and no NAT Gateway. |
| **SSM interface endpoints** (`SSM` / `SSM Messages` / `EC2 Messages`) | One set in HubVpc, one in OnPremVpc, the only two VPCs with an EC2 instance, so Session Manager reaches them with no internet path at all. |
| **Private hosted zones** | `system.example.com` in HubVpc, `dev.system.example.com` in DevVpc, `stg.system.example.com` in StgVpc, each associated with its own VPC only. |
| **`DELEGATE` resolver rule** | One `CfnResolverRule` (`RuleType: DELEGATE`, `DelegationRecord` set to the *parent* zone name) on HubVpc's outbound endpoint, associated with HubVpc; handles both children. |
| **NS + glue records** | In the parent zone: an `NS` record per child domain pointing at two synthetic nameserver hostnames, each backed by an `A` record (glue) resolving to that child's delegation endpoint static IP. |
| **BIND9 forwarder** | AL2023 EC2 in OnPremVpc, forwarding only `system.example.com` to HubVpc's regular inbound endpoint. `dev.`/`stg.` queries ride the delegation chain transparently. |

### Architecture Characteristics

| Characteristic | Value | Rationale |
|-----------------|-------|-----------|
| Connectivity | Transit Gateway, not peering | Four VPCs, hub-and-spoke. See the [`route53-resolver-endpoints`](../route53-resolver-endpoints/) workspace for the 2-VPC peering case. |
| Delegation depth | One hop (parent → child) | AWS's `DELEGATE` rule mechanism is demonstrated end to end; deeper chains (child delegates a grandchild) are a straightforward extension, not implemented here. |
| Zone isolation | Each PHZ associated with exactly one VPC | Mirrors how a real organization would split `dev`/`stg` ownership across separate accounts/VPCs while keeping a single DNS namespace. |
| Security | No internet exposure | Every subnet is `PRIVATE_ISOLATED`; both EC2s reach SSM through interface endpoints instead of an Internet Gateway. |
| Cost | No NAT Gateway, but SSM interface endpoints instead | Transit Gateway attachment-hours and Resolver endpoint-hours dominate either way; SSM interface endpoints add a smaller, bounded cost on top. |

## 🧭 Design Decisions & Best Practices

### 1. `DELEGATE` rules, not `FORWARD`, for the parent → child path

**Decision**: HubVpc's outbound endpoint carries one `AWS::Route53Resolver::ResolverRule` with `RuleType: DELEGATE`,
instead of `FORWARD` rules with static `TargetIps`.

**Why**: `DELEGATE` resolves its destination via NS + glue records already present in the zone, the same mechanism
public DNS has always used to delegate a subdomain, applied here to a private hosted zone hierarchy. The
alternative, `FORWARD`, would need a hard-coded `TargetIps` list per child, which is exactly the "on-premises
conditional forwarder" problem this whole feature exists to remove. See the sibling
[`route53-resolver-endpoints`](../route53-resolver-endpoints/) workspace for where `FORWARD` is still the right
tool (a destination with a static IP and no Route 53 zone of its own).

**`DelegationRecord` is the *parent* zone name, not each child's**: this is the single most important, and least
obviously documented, detail of this whole workspace. `AWS::Route53Resolver::ResolverRule`'s `DelegationRecord`
does not name the subdomain you're delegating; it names the zone whose NS responses this rule should watch. AWS's
own [Resolver delegation rules tutorial](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/outbound-delegation-tutorial.html)
calls this "in-zone delegation" (the NS + glue records for the children live inside the parent zone, exactly as
they do here) and its worked example creates **one** delegation rule keyed on the parent (`hr.example.com`) that
transparently covers two children (`eu.hr.example.com`, `apac.hr.example.com`); a *separate* rule per child is
only needed for "out-of-zone" delegation, where the child's NS + glue records live in an entirely different zone
your account doesn't own. An earlier version of this workspace got this backwards: one `DELEGATE` rule per child,
each keyed on the child's own name, which deploys and associates without error but silently resolves nothing:
`dig app.dev.system.example.com` returns empty, no timeout, no error, because the rule never matches an NS
response in the first place. `ParentDelegateRule`, keyed on `system.example.com`, is what actually routes both
children's queries.

### 2. Static IPs on the delegation endpoints, used as glue

**Decision**: `DevInboundDelegationEndpoint` / `StgInboundDelegationEndpoint` are created with `useStaticIps: true`,
and the parent zone's glue `A` records reference `devInboundDelegationEndpoint.ipAddresses` / `stgInboundDelegationEndpoint.ipAddresses`
directly.

**Why**: a glue record has to point at a real, known IP. It cannot reference a CloudFormation `Fn::GetAtt` that
only resolves post-deployment IP allocation, because `ResolverEndpoint` doesn't expose its assigned IPs as a
`Fn::GetAtt` attribute at all (only `IpAddressCount`). Computing the IPs deterministically from the subnet CIDR at
synth time (see `ResolverEndpointConstruct`) is what makes an in-template glue record possible.

### 3. HubVpc gets *two* endpoints, not one bidirectional endpoint

**Decision**: HubVpc has a separate regular `INBOUND` endpoint (for on-premises → Hub queries) and a separate
`OUTBOUND` endpoint (carrying the `DELEGATE` rule, for Hub → Dev/Stg queries).

**Why**: `AWS::Route53Resolver::ResolverEndpoint`'s `Direction` is a single value per endpoint resource; there is
no "both directions" option. A hub that both answers inbound queries *and* delegates outbound to children
necessarily needs two endpoint resources, exactly mirroring how a real hybrid-DNS hub would be built.

### 4. The on-premises BIND9 configures exactly one forward zone

**Decision**: `bind9ForwarderUserData(parentZoneName, hubInboundEndpoint.ipAddresses)` only configures a `forward`
zone for `system.example.com`. There is no `dev.system.example.com` or `stg.system.example.com` entry in BIND9's
config at all.

**Why**: this is the entire value proposition of the June 2025 feature, made visible. Before delegation endpoints
existed, an on-premises DNS administrator would need a conditional-forwarding rule *per subdomain* that changes
whenever AWS-side ownership changes. With the `DELEGATE` rule doing the routing on the AWS side, on-premises needs
to know about exactly one domain, ever. Route 53 Resolver follows the delegation chain on its own.

### 5. Transit Gateway, not four pairs of VPC peering

**Decision**: all four VPCs attach to one Transit Gateway via the existing `TransitGatewayConstruct`.

**Why**: four VPCs that all need mutual reachability would need up to 6 peering connections (`N(N-1)/2`); a hub
topology needs 4 attachments. This is the same trade-off documented in the
[`transit-gateway`](../transit-gateway/) workspace's README, applied here because this workspace crosses the
2-VPC threshold where peering stops being the cheaper answer.

### 6. Every subnet is private: SSM interface endpoints instead of an Internet Gateway

**Decision**: neither HubVpc nor OnPremVpc has a `Public` subnet group or an Internet Gateway. Their EC2 instances
sit in a `Private` (`PRIVATE_ISOLATED`) subnet group, and each of those two VPCs gets its own SSM, SSM Messages,
and EC2 Messages interface endpoints (in that same subnet group) so Session Manager still works. DevVpc and StgVpc
never had a workload subnet to begin with, so they are unaffected.

**Why**: see the identical decision (and full rationale) in the
[`route53-resolver-endpoints`](../route53-resolver-endpoints/) workspace's README: a real on-premises DNS server
is never directly internet-facing, and a "hub" instance does not need a route to the internet either. The same
`targetSubnetGroupName` addition to `@common/constructs/ec2/ec2-testinstance` used there is reused here to place
each instance in its VPC's `Private` group rather than disambiguating by `SubnetType` alone (both VPCs also have
other `PRIVATE_ISOLATED` groups: `Resolver` and/or `Tgw`).

## 💰 Cost Optimization

Approximate **ap-northeast-1**, on-demand, running 24×7.

| Resource | Qty | Unit | ~Monthly |
|----------|-----|------|----------|
| Transit Gateway attachment | 4 | $0.05 / attachment-hour | ~$144 |
| Resolver endpoint (Hub in+out, Dev, Stg delegation) | 4 | $0.125 / endpoint-hour | ~$365 |
| EC2 `t4g.nano` (test + BIND9) | 2 | $0.0042 / hr (× region factor) | ~$6 |
| EBS gp3 8 GiB | 2 | $0.08 / GB-month | ~$1.3 |
| SSM interface endpoints (SSM/SSM Messages/EC2 Messages, per AZ) | 9 (6 in HubVpc's 2 AZ + 3 in OnPremVpc's 1 AZ) | ~$0.013 / endpoint-AZ-hour | ~$85 |
| **Total (idle)** | | | **~$601 / month** |

Cost levers:

- **Endpoint-hours and attachment-hours both dominate** here, more than in either sibling workspace alone. This
  stack combines both patterns to demonstrate the full delegation chain. `cdk destroy` promptly after verifying.
- No NAT Gateway anywhere; HubVpc and OnPremVpc use SSM interface endpoints instead (see
  [Design Decision 6](#6-every-subnet-is-private-ssm-interface-endpoints-instead-of-an-internet-gateway)).
- If you only need to prove the delegation mechanism itself (not the Transit Gateway story), the two child VPCs'
  Resolver endpoints and the Transit Gateway attachment cost are the floor. It's a Well-Architected trade-off: fewer
  VPCs would need peering instead, at the cost of losing the hub-and-spoke shape a real multi-account setup uses.

## 🔒 Security Considerations

| Control | Implementation |
|---------|----------------|
| **DNS traffic scope** | Every Resolver endpoint's security group opens TCP+UDP 53 to one specific peer VPC CIDR only (Hub inbound ← OnPrem; Hub outbound ← Dev/Stg; Dev/Stg delegation inbound ← Hub), never `0.0.0.0/0`; a unit test asserts this. |
| **No internet exposure** | Every subnet is `PRIVATE_ISOLATED`: no Internet Gateway, no NAT Gateway, no public IP on any instance; a unit test asserts this. |
| **Delegation protocol restriction** | `INBOUND_DELEGATION` endpoints are hard-coded to `Protocols: ['Do53']` in `ResolverEndpointConstruct`. |
| **Zone isolation** | Each private hosted zone is associated with exactly one VPC; `dev.system.example.com` is not resolvable from StgVpc or OnPremVpc directly, only via the delegation chain through HubVpc. |
| **`DELEGATE` rules carry no static credentials/IPs** | Unlike `FORWARD`, a `DELEGATE` rule's `TargetIps` is intentionally empty. The destination is derived from the zone's own NS/glue records, which are managed alongside the rest of the stack. |
| **Instance hardening** | IMDSv2 required, EBS encrypted, SSM Session Manager instead of long-lived SSH keys. |
| **Least-privilege IAM** | Instances get only `AmazonSSMManagedInstanceCore`. CDK Nag (`AwsSolutionsChecks`) runs in tests; every suppression is scoped to a path and carries a reason. |
| **Default SG** | `@aws-cdk/aws-ec2:restrictDefaultSecurityGroup` is on repo-wide. |

Production hardening: enable VPC Flow Logs (off by default here for cost), and consider a dedicated Transit
Gateway route table per environment so a compromised `dev` VPC cannot reach `stg` beyond what DNS delegation
itself exposes.

## ✅ Prerequisites

- Node.js 20+ and the repo bootstrapped (`npm install` at `infrastructure/`)
- An AWS account and a named profile `${PROJECT}-${ENV}` (e.g. `route53-phz-delegation-dev`)
- CDK bootstrapped in the target account/region: `npm run bootstrap -w workspaces/route53-phz-delegation`

## 🚀 Deployment Guide

```bash
export PROJECT=route53-phz-delegation
export ENV=dev

# 1. Synthesize
npm run synth -w workspaces/route53-phz-delegation

# 2. Deploy
npm run deploy:all -w workspaces/route53-phz-delegation

# 3. Verify (see Testing Strategy) then tear down
npm run destroy:all -w workspaces/route53-phz-delegation
```

## 🧪 Testing Strategy

| Layer | File | What it checks |
|-------|------|----------------|
| Snapshot | `test/snapshot/snapshot.test.ts` | Full template + resource-type/count snapshot. |
| Unit | `test/unit/route53-phz-delegation-stack.test.ts` | 4 VPCs with the expected CIDRs; 1 Transit Gateway meshing all 4; no Internet Gateway/NAT Gateway/public IP anywhere; the SSM interface endpoints in HubVpc and OnPremVpc; 3 private hosted zones; 4 Resolver endpoints (Hub inbound `INBOUND`, Hub outbound `OUTBOUND`, Dev/Stg `INBOUND_DELEGATION` with `Protocols: [Do53]` and 2 IPs each); exactly one `DELEGATE` rule (no `TargetIps`), keyed on the parent zone name, with its association; NS + glue `A` records in the parent zone for both children; no security group opening DNS to `0.0.0.0/0`. |
| Compliance | `test/compliance/cdk-nag.test.ts` | `AwsSolutionsChecks` with only scoped, documented suppressions. |

```bash
npm test -w workspaces/route53-phz-delegation
npm run test:snapshot:update -w workspaces/route53-phz-delegation   # after an intentional change
```

### Manual DNS resolution check

```bash
# From HubVpc's test instance (id from stack outputs)
aws ssm start-session --target <HubTestInstance id> --profile route53-phz-delegation-dev

dig app.system.example.com +short      # → 10.0.200.10, answered directly by HubVpc's own zone (no delegation)
dig app.dev.system.example.com +short  # → 10.1.200.10, delegated to DevVpc via the parent-zone DELEGATE rule
dig app.stg.system.example.com +short  # → 10.2.200.10, delegated to StgVpc via the same rule

# From the BIND9 host in OnPremVpc, using itself as resolver (only system.example.com is
# configured as a forward zone - dev./stg. still resolve via the delegation chain)
aws ssm start-session --target <OnPremDnsForwarder id> --profile route53-phz-delegation-dev
dig @127.0.0.1 app.dev.system.example.com +short
```

## ⚙️ Customization

| Goal | Change |
|------|--------|
| Different zone/domain names | `parentZoneName` / `devZoneName` / `stgZoneName` in `parameters/dev-params.ts`. |
| A third child environment | Add a `PrdVpc` following the `DevVpc`/`StgVpc` pattern: a `Resolver` + `Tgw` subnet group, a private hosted zone, an `INBOUND_DELEGATION` endpoint, and an NS/glue record pair in the parent zone. The existing `ParentDelegateRule` already covers it; no new `DELEGATE` rule needed, since it's keyed on the parent zone, not the child. |
| Different CIDRs | `hubVpcConfig` / `devVpcConfig` / `stgVpcConfig` / `onPremVpcConfig` in `parameters/dev-params.ts`. |
| Reuse the endpoint construct elsewhere | `ResolverEndpointConstruct` only needs `vpc`, `subnets`, `direction`, and `allowedCidrs`, with no dependency on this workspace. |

## 🔧 Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `dig app.dev.system.example.com` returns empty: no answer, no error, no timeout | `DELEGATE` rule's `DelegationRecord` is set to the *child* zone name instead of the *parent* zone name | `DelegationRecord` must be the zone that actually holds the NS + glue records (`system.example.com` here), not the delegated subdomain; see [Design Decision 1](#1-delegate-rules-not-forward-for-the-parent--child-path). `aws route53resolver get-resolver-rule --resolver-rule-id <id>` to check the deployed value. |
| `dig app.dev.system.example.com` from HubVpc's test instance times out | `DELEGATE` rule not yet associated, or Transit Gateway attachment still `pending` | `aws route53resolver list-resolver-rule-associations`; `aws ec2 describe-transit-gateway-attachments`. |
| BIND9 can resolve `system.example.com` but not `dev.system.example.com` | HubVpc's regular inbound endpoint SG doesn't allow OnPremVpc's CIDR, or the `DELEGATE` rule/glue records are missing | Confirm `HubInboundEndpoint`'s security group and the `DevNsRecord`/`DevNsGlueRecord*` outputs in the synthesized template. |
| CloudFormation Validate warns about a Resolver endpoint `Name` | Name contains characters outside `[a-zA-Z0-9\-_ ]` | `ResolverEndpointConstruct` already sanitizes slashes; adjust if `project`/`environment` contain other punctuation. |
| CDK Nag test fails after an edit | New resource triggers a rule | Add a **scoped, documented** suppression in `test/compliance/cdk-nag.test.ts`; do not broaden existing ones. |

## 📚 References

- [Amazon Route 53 Resolver endpoints now support DNS delegation for private hosted zones (AWS What's New, 2025/06/24)](https://aws.amazon.com/about-aws/whats-new/2025/06/amazon-route-53-resolver-endpoints-dns-delegation-private-hosted-zones/)
- [AWS::Route53Resolver::ResolverEndpoint (CloudFormation reference)](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53resolver-resolverendpoint.html)
- [AWS::Route53Resolver::ResolverRule (CloudFormation reference)](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53resolver-resolverrule.html)
- [Resolver delegation rules tutorial](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/outbound-delegation-tutorial.html): the worked example this workspace's `DelegationRecord` choice (parent zone, not child) is based on.
- [Resolving DNS queries between VPCs and your network](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver.html)
- Related workspace: [`route53-resolver-endpoints`](../route53-resolver-endpoints/): the simpler 2-VPC inbound/outbound endpoint case, including the config-driven `INBOUND` / `INBOUND_DELEGATION` toggle.
- Related workspace: [`transit-gateway`](../transit-gateway/): the Transit Gateway construct reused here, documented in isolation.
