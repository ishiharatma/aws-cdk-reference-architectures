# Amazon WorkSpaces Personal + AWS Managed Microsoft AD with CDK

Collected while building `workspaces-managed-ad-closed-vpc` (ap-northeast-1, aws-cdk-lib 2.273.0,
November 2026). **That workspace is not deploy-verified yet.** Each entry below says how it was confirmed:
official AWS documentation, a read-only AWS CLI call against the `drillexercises-dev` account, or a local
`cdk synth` / jest run. Entries that only a real deployment can settle are marked *unverified*.

## WorkSpaces Personal only runs in specific AZ IDs — pin subnets with `AvailabilityZoneId`

In ap-northeast-1 WorkSpaces Personal supports **`apne1-az1` and `apne1-az4` only** (other Regions have
their own lists). AZ names map to different physical zones per account, so a subnet pinned by AZ name can
land in an unsupported zone in another account.

- Source: [Availability Zones for WorkSpaces Personal](https://docs.aws.amazon.com/workspaces/latest/adminguide/azs-workspaces.html).
- The L2 `ec2.Subnet` / `PrivateSubnet` take `availabilityZone` (a name) only. Use L1 `CfnSubnet` with
  `availabilityZoneId`, then wrap it with `ec2.Subnet.fromSubnetAttributes({ subnetId, availabilityZone:
  cfnSubnet.attrAvailabilityZone, routeTableId })`. `ec2.Instance` placed in such a subnet gets
  `AvailabilityZone: Fn::GetAtt` (cross-stack import), which synthesizes and validates cleanly.
- `new ec2.Vpc(..., { subnetConfiguration: [], natGateways: 0 })` creates a VPC with no subnets, no IGW and
  no NAT (confirmed in the synthesized template: 0 `AWS::EC2::InternetGateway` / `NatGateway` /
  `VPCGatewayAttachment`).

## Windows Server 2025 bundles exist in Tokyo

`aws workspaces describe-workspace-bundles --owner AMAZON --region ap-northeast-1` (2026-11-16) returned
Windows Server 2025 bundles, e.g. `wsb-jg3rsnz01` *Standard with Windows Server 2025 (Japanese)* (80 + 50 GB),
`wsb-k7k3z20bg` *Performance ... (Japanese)* (80 + 100 GB), `wsb-9st2dbm97` *Power ... (Japanese)*
(175 + 100 GB). Their description reads "Windows Server with TPM with No Streaming Protocol"; the protocol
is chosen when the WorkSpace is created. Announcement: What's New 2026-03 "Amazon WorkSpaces now supports
Microsoft Windows Server 2025".

Workloads that use WSL2 / Docker need nested virtualization, which requires DCV or BYOP and is recommended
on Power or larger ([blog](https://aws.amazon.com/blogs/desktop-and-application-streaming/working-with-nested-virtualization-on-amazon-workspaces/)).

## CloudFormation / CDK coverage gaps

- **aws-cdk-lib 2.273.0 has no `CfnDirectory`** in `aws-workspaces` (only `CfnConnectionAlias`,
  `CfnWorkspace`, `CfnWorkspaceIpGroup`, `CfnWorkspacesPool`), although the CloudFormation reference lists
  `AWS::WorkSpaces::Directory`. That resource's documented properties have no `DirectoryId` input, so it
  could not be used to register an existing Managed AD; registration was done with a custom resource
  (`RegisterWorkspaceDirectory` + `isComplete` until `REGISTERED`, then the `Modify*` calls).
- **`AWS::WorkSpaces::Workspace` `WorkspaceProperties` has no protocol property** (only compute type,
  volume sizes, running mode, auto-stop timeout). The API's `Protocols` takes `PCOIP` or `WSP` (`WSP` = DCV).
  PCoIP-based WorkSpaces Personal reaches end of support on 2027-10-31.
- **cfn-lint F3006 false positive for `AWS::WorkSpaces::WorkspaceIpGroup` in ap-northeast-1.** `cdk
  validate` reported "Resource type ... does not exist in 'ap-northeast-1'", but
  `aws cloudformation describe-type --type RESOURCE --type-name AWS::WorkSpaces::WorkspaceIpGroup
  --region ap-northeast-1` returns `Visibility: PUBLIC`, `DeprecatedStatus: LIVE`. Acknowledge it with
  `cdk.Validations.of(ipGroup).acknowledge({ id: 'CloudFormation-Validate::F3006', reason })` (same pattern as
  [ecs-gateway.md](ecs-gateway.md)).

## IP access control groups

From [IP access control groups for WorkSpaces Personal](https://docs.aws.amazon.com/workspaces/latest/adminguide/amazon-workspaces-ip-access-control-groups.html):

- Up to 30 rules per group, 140 groups per Region per account, 35 groups per directory. IPv4 only.
- Dynamic NAT IPs are not supported; the client's egress must be a fixed IP for the whole session (UDP
  included).
- They control **streaming** only — restart / rebuild / shutdown through the WorkSpaces API work from any IP.
  Restrict those with IAM.
- Do not associate an IP access control group with a directory that uses a VPC endpoint for streaming.
- Associating a group removes the default (allow-all) group from the directory.

## AWS Managed Microsoft AD

- **Simple AD is closed to new customers after 2026-07-30**
  ([Create a Simple AD directory for WorkSpaces Personal](https://docs.aws.amazon.com/workspaces/latest/adminguide/launch-workspace-simple-ad.html)).
  Use Managed AD (or AD Connector to an existing AD).
- **ds-data cannot create OUs, and `CreateUser` has no target OU.** Directory Service Data writes users,
  groups and memberships only, inside the customer's delegated OU; `CreateUser` takes `SAMAccountName`,
  names, email and `OtherAttributes` but no OU, so new users land in the delegated `Users` OU. Operations on
  objects outside the OU return `AccessDeniedException`
  ([API reference](https://docs.aws.amazon.com/directoryservicedata/latest/DirectoryServiceDataAPIReference/API_CreateUser.html)).
  OUs, GPOs and moving users need a domain-joined Windows instance. ds-data must be enabled per directory
  with `ds:EnableDirectoryDataAccess` (no CloudFormation property; an `AwsCustomResource` works).
- The default domain policy cannot be edited; Managed AD pre-creates fine-grained password policies to edit
  and apply to groups. *Unverified*: the pre-created PSO name (`CustomerPSO-01` assumed).
- *Unverified*: the GroupPolicy cmdlets have no `-Credential` parameter, so a bootstrap running as
  LocalSystem through SSM must run its GPO part in a real logon of a domain admin (this workspace uses a
  one-shot scheduled task registered as `<NetBIOS>\Admin`).

## DCV Group Policy templates come from a running WorkSpace

`wsp.admx` / `wsp.adml` are not downloadable; copy them from `C:\Program Files\Amazon\WSP` on a running
Windows WorkSpace into the Central Store (`\\<FQDN>\SYSVOL\<FQDN>\Policies\PolicyDefinitions`)
([docs](https://docs.aws.amazon.com/workspaces/latest/adminguide/group_policy.html)). GPOs for DCV clipboard /
printer / USB settings therefore cannot be fully created before the first WorkSpace exists. Once a Central
Store exists GPMC reads ADMX only from it, so seed it with the OS's `PolicyDefinitions` first.

## Last connection time

`DescribeWorkspacesConnectionStatus` returns `LastKnownUserConnectionTimestamp` per WorkSpace and accepts
up to 25 WorkSpace IDs per call; neither it nor `DescribeWorkspaces` supports resource-level IAM
permissions (`Resource: *`).

## Tokyo pricing (AWS price list, 2026-11)

| Item | Price |
| --- | --- |
| WorkSpaces Standard (Windows, license included, 80 + 50 GB) | AlwaysOn $47/month; AutoStop $14/month + $0.40/hour |
| WorkSpaces Performance (80 + 100 GB) | AlwaysOn $65; AutoStop $19 + $0.61/hour |
| WorkSpaces Power (175 + 100 GB) | AlwaysOn $118; AutoStop $26 + $0.89/hour |
| Managed AD Standard | $0.073 per domain controller hour (2 DCs = $0.146/hour) |
| Simple AD small / AD Connector small | $0.08/hour (free while used with WorkSpaces) |
| Interface VPC endpoint | $0.014 per AZ hour |
| t3.medium Windows | $0.0728/hour |

The WorkSpaces monthly fee is prorated in the first month only (WorkSpaces FAQ). The public offer file
`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonWorkSpaces/current/ap-northeast-1/index.csv`
needs no credentials, which helps when the AWS MCP credentials have expired.

## CDK testing: jest does not read `cdk.json` feature flags

`new cdk.App()` in a jest test does not load the `context` of `cdk.json`, so feature flags such as
`@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy` are off in tests while on in `cdk synth`. An access-log
bucket with `objectOwnership: BUCKET_OWNER_ENFORCED` then failed **only in jest** with
`«MustBeObjectownershipAccesscontrol» objectOwnership must be set to "ObjectWriter" when accessControl is
"LogDeliveryWrite"`. Fix: `new cdk.App({ context: cdkJson.context })` (import `cdk.json`; the workspaces'
`jest.config.js` already maps `^cdk\.json$`), so tests synthesize the same template as the CLI.
