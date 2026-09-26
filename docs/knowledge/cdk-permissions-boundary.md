# CDK and IAM Permissions Boundaries — Governing IAM Privilege Escalation Under IaC

How to prevent IAM privilege escalation in an account where people deploy with CDK, what
breaks when the control is designed for humans instead of for IaC, and what was verified
against real accounts (2026-09-26, `ap-northeast-1`, CDK CLI 2.1138.0).

## Why the "deny `iam:CreateRole` unless the boundary is `PowerUserAccess`" SCP did not work

An organization SCP denied `iam:CreateRole` unless `iam:PermissionsBoundary` equalled
`arn:aws:iam::aws:policy/PowerUserAccess`. It was withdrawn because it does not fit how CDK
works:

- CloudFormation, not the user, creates the roles. CDK also creates roles nobody wrote
  (custom-resource Lambdas, `autoDeleteObjects`, log retention, pipeline roles), and
  every one of them needs the boundary.
- `PowerUserAccess` contains no `iam:*`, so as a boundary it also strips IAM actions from
  every role it is attached to, including the CDK bootstrap roles.
- The condition only checks that *a* boundary is present. It says nothing about who may
  remove or change it.

### The concrete failure: `deploy-role` cannot pass `cfn-exec-role`

With the bootstrap roles carrying `PowerUserAccess` as their boundary, the default
synthesizer fails at deploy time with

```
User: arn:aws:sts::<acct>:assumed-role/cdk-<q>-deploy-role-.../aws-cdk-node is not authorized
to perform: iam:PassRole on resource: arn:aws:iam::<acct>:role/cdk-<q>-cfn-exec-role-...
because no permissions boundary allows the iam:PassRole action
```

The workaround is `CliCredentialsStackSynthesizer`, which deploys with the caller's own
credentials and no bootstrap roles. In `ecs-fargate-alb-StackSynthesizer` it is enabled with
`CDK_USE_CALLER_ROLE=true` and was verified end to end (4 stacks, 12 roles, ALB 200).
**The synthesizer must be passed to every stack.** The `Cicd` stack was missing it, so it
alone went through the bootstrap roles and failed with the error above while the other
three stacks deployed.

## Recommended design: put the boundary on the deploy principal, not on every `CreateRole`

1. **Create a customer managed boundary policy** (allow all, plus the denies below) and
   bootstrap with `cdk bootstrap --custom-permissions-boundary <policy-name>`. The
   boundary is attached to `cdk-<q>-cfn-exec-role`, the role that actually creates
   resources. The deploy, file/image publishing and lookup roles get none.
2. **Deny escalation inside the boundary itself**:
   - `iam:CreateRole` / `CreateUser` / `Put*PermissionsBoundary` unless
     `iam:PermissionsBoundary` equals the boundary's own ARN
   - `iam:CreatePolicyVersion` / `DeletePolicy` / `DeletePolicyVersion` /
     `SetDefaultPolicyVersion` on the boundary policy
   - `iam:Delete*PermissionsBoundary`
3. **Apply the same boundary to every role the app creates** with
   `PermissionsBoundary.of(stage).apply(...)`. In
   `ecs-fargate-alb-StackSynthesizer` the policy name comes from
   `CDK_PERMISSIONS_BOUNDARY_POLICY_NAME` (default: `PowerUserAccess`).
4. **Check before and after deploy**: cdk-nag / CloudFormation Guard on the synthesized
   template (every `AWS::IAM::Role` has a boundary), AWS Config and IAM Access Analyzer
   for drift.
5. **Restrict `iam:PassRole`** by role and by `iam:PassedToService`. Escalation usually
   goes through passing a strong role, not through creating a weak one.

Because only the deploy principal is constrained, no SCP on `CreateRole` in general is
needed. An SCP is still useful for protecting the boundary policy and the bootstrap
roles from modification.

## What was verified (account with no SCP, qualifier `bndry`)

`iam:SimulatePrincipalPolicy` on `cdk-bndry-cfn-exec-role`:

| Action | `iam:PermissionsBoundary` context | Decision |
| ------ | --------------------------------- | -------- |
| `iam:CreateRole` | none | explicitDeny |
| `iam:CreateRole` | `arn:aws:iam::aws:policy/PowerUserAccess` | explicitDeny (boundary's deny statement) |
| `iam:CreateRole` | the custom boundary's ARN | allowed |
| `iam:DeleteRolePermissionsBoundary` | – | explicitDeny |

Real deploys agree. With the boundary on all roles: 4 stacks created, 12 of 12 roles carry
the custom boundary, ALB returned 200. With the wrong boundary (`PowerUserAccess`) on the
app's roles: the first `AWS::IAM::Role` fails and the stack rolls back.

## Gotchas hit while verifying

- **CloudFormation reports the boundary denial misleadingly.** The failed role shows
  `Encountered a permissions error performing a tagging operation, please add required tag
  permissions`, not an IAM boundary message. Two `cloudtrail lookup-events` queries for
  `CreateRole` errors did not surface the denial (CloudTrail lag, or it was paged out by
  the successful `CreateRole` events), so the cause was confirmed with
  `simulate-principal-policy`, which answers immediately.
- **`cdk bootstrap --example-permissions-boundary --qualifier <q>` failed** on CLI 2.1138.0
  with `Policy arn:aws:iam::<acct>:policy/cdk-<q>-permissions-boundary was not found`,
  before creating anything. Create the policy first (`aws iam create-policy`) and use
  `--custom-permissions-boundary <name>`. Not tested with the default qualifier.
- **Use a separate qualifier to test bootstrap changes** instead of updating the shared
  `CDKToolkit`: `--toolkit-stack-name CDKToolkit-<q> --qualifier <q>` at bootstrap,
  `-c '@aws-cdk/core:bootstrapQualifier=<q>'` at deploy. The existing bootstrap and its
  roles are untouched.
- **Tearing that bootstrap down**: deleting the stack fails on
  `ContainerAssetsRepository` if images were pushed (`aws ecr delete-repository --force`,
  then delete the stack again). The staging S3 bucket is retained, so empty all versions
  and delete it. Then delete the boundary policy.
- **`ManagedPolicy.fromManagedPolicyName` needs a `Stack` scope** (it resolves the account
  through the enclosing stack), and `PermissionsBoundary.of(stage)` is applied at `Stage`
  level. `ecs-fargate-alb-StackSynthesizer` therefore builds the ARN itself and uses
  `ManagedPolicy.fromManagedPolicyArn(stage, id, arn)`; the name-based form was not tried.
- **An existing bootstrap can carry a boundary you did not set in the parameters.** In one
  account `CDKToolkit` showed `InputPermissionsBoundary` empty and variant "Default
  Resources" while every bootstrap role had `PowerUserAccess` as its boundary (the repo's
  `infrastructure/bootstrap-template.yaml` hard-codes that boundary on its roles, the
  likely source; not confirmed which template was used). Check with
  `aws iam get-role --query Role.PermissionsBoundary`, not with the stack parameters.
