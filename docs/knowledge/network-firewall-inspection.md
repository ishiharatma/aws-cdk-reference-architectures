# Network Firewall Behind a Transit Gateway — Gotchas Worth Knowing

Verified while deploy-verifying `tgw-network-firewall-inspection` (ap-northeast-1, aws-cdk-lib 2.270,
October 2026).

## A domain allow list also drops east-west HTTP and TLS

A stateful domain list rule group (`GeneratedRulesType: ALLOWLIST`) drops every HTTP or TLS flow whose
host is not listed, whatever the destination. `curl http://10.2.0.14:8080` between two spokes timed out;
the alert log entry said `not matching any HTTP allowlisted FQDNs` with `hostname: 10.2.0.14`. Add an
explicit Suricata `pass` rule for the east-west service in another stateful rule group
(`pass tcp <spokeA> any <> <spokeB> 8080 (msg:"..."; sid:...; rev:1;)`). With the default (action order)
evaluation, `pass` rules are evaluated before the allow list's drops, and the flow went through.

## Dropped flows are in the alert log, with the rule group that dropped them

With the default policy, `drop` rule hits and the allow list's drops appear in the ALERT log destination as
`alert.action: "blocked"`, with `aws_metadata.resource_arn` naming the rule group. Filter the log group with
`"blocked"` to prove a rule fired.

## SSM registration proves the whole inspected egress path

An instance in a spoke with no internet route and no VPC endpoints registers with Session Manager only if
spoke → Transit Gateway → firewall → NAT → internet works and `.amazonaws.com` passes the allow list. Waiting
for `PingStatus: Online` is a cheap end-to-end check before the real tests.

## Routing recipe (one AZ)

Inspection VPC: `tgw` subnet default → firewall endpoint; `firewall` subnet default → NAT gateway and spoke
CIDRs → Transit Gateway; `public` subnet default → IGW and spoke CIDRs → firewall endpoint. Transit Gateway:
spoke table `0.0.0.0/0` → inspection attachment, inspection table spoke CIDRs → spoke attachments, default
association and propagation off, appliance mode on the inspection attachment. The endpoint id for the routes is
`Fn::Select(1, Fn::Split(':', Fn::Select(0, firewall.attrEndpointIds)))`.

## Resource type of a Transit Gateway VPC attachment in tests

In templates, a VPC attachment is `AWS::EC2::TransitGatewayVpcAttachment` (not `...TransitGatewayAttachment`);
a test that counts the wrong type finds zero resources.

## The public subnet's return route cannot use the VPC CIDR

In a single-VPC layout (workload, firewall and public subnets in one VPC), the route that sends return traffic from the NAT gateway's public subnet back through the firewall endpoint must use the **workload subnet CIDR**. Using the VPC CIDR fails with `The route identified by <cidr> already exists`, because every route table already has a local route for it. A destination more specific than the local route is accepted (verified 2026-10-09, `claude-managed-agents-lambda-microvms`).
