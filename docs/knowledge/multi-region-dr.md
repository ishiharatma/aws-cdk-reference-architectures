# Multi-Region DR (Tokyo → Osaka) — Measured Facts and Gotchas

Verified while deploy-verifying `multi-region-dr-strategies` (ap-northeast-1 → ap-northeast-3,
aws-cdk-lib 2.270, October 2026). Numbers are from a tiny dataset; the ordering matters more than the
absolute values.

## Measured recovery numbers

| Item | Measured |
|---|---|
| DynamoDB global table replication (write acknowledged → readable in the other region) | 0.2 to 1.6 s |
| Route 53 failover record switch (10 s check interval, threshold 2, TTL 10 s) | 28 s |
| Route 53 weighted record dropping a failed side | 34 s |
| Lambda reserved concurrency 0 → serving after `delete-function-concurrency` | seconds (within the 36 s total with DNS) |
| `cdk deploy` of a one-function stack in the DR region, to first served request | 84 s |
| AWS Backup on-demand backup of a near-empty DynamoDB table | 197 s |
| AWS Backup cross-region copy of it | about 740 s |
| AWS Backup restore of it in the DR region | 256 s |

## Lambda reserved concurrency 0 answers HTTP 429 on a function URL

A function with `reservedConcurrentExecutions: 0` is deployed and configured but throttles every call;
the function URL returns `429`. It is a cheap "scaled to zero" warm standby. Scale up with
`aws lambda delete-function-concurrency`.

## A backup vault with recovery points cannot be destroyed

`cdk destroy` fails on `AWS::Backup::BackupVault` while it holds recovery points, including the ones an
on-demand backup or a cross-region copy created. Delete the recovery points in both vaults first
(`aws backup delete-recovery-point`).

## Select one stack inside a Stage with `'**/*Name*'`

Stacks in a `cdk.Stage` have the path `Stage/Stack`. `cdk deploy "*Name*"` matches nothing because `*`
does not cross `/`; use `'**/*Name*'`. A stack that is only synthesized under a context flag (for example
`-c includeRecoveryStack=true`) also needs that flag on the deploy command.

## `npm run bootstrap` bootstraps every region the app uses

The workspace `bootstrap` script runs `cdk bootstrap` with no environment argument, which bootstraps the
environments of all stacks in the app. A two-region app therefore bootstraps the DR region too; bootstrap
it before the first deploy (`cross-region references` and the DR stack both need it).
