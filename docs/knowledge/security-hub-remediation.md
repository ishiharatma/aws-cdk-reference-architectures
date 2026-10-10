# Security Hub Automatic Remediation — Gotchas Worth Knowing

Verified while deploy-verifying the remediation added to `security-baseline` (ap-northeast-1, aws-cdk-lib 2.270,
October 2026).

## Lambda `ReservedConcurrentExecutions` fails in an account with the default quota

With the default account concurrency quota of 10, `ReservedConcurrentExecutions: 5` fails the stack:
"Specified ReservedConcurrentExecutions for function decreases account's UnreservedConcurrentExecution below its
minimum value of [10]". The account must always keep 10 unreserved. Make the reservation an optional parameter or
raise the quota first.

## Test a Security Hub rule with real resources and `BatchImportFindings`

A control or GuardDuty finding for a real misconfiguration can take a long time to appear. To exercise an
EventBridge rule and a remediation deterministically, create the real resource in the bad state and import a finding
for it with `aws securityhub batch-import-findings` (ProductArn `arn:aws:securityhub:<region>:<account>:product/<account>/default`,
`Compliance.SecurityControlId`, `Resources[].Type/Id`). It arrives as `Security Hub Findings - Imported` with
`ProductName: Default` and `Workflow.Status: NEW`, so a rule must trust `Default` for this to work — keep that off
outside development, because anyone who can import findings could then trigger a remediation.

## Control findings carry the control ID in `Compliance.SecurityControlId`

Match a rule on `detail.findings.Compliance.SecurityControlId` (for example `S3.8`, `EC2.53`) together with
`Compliance.Status: FAILED`, `RecordState: ACTIVE` and `Workflow.Status: NEW`. A remediated finding set to `RESOLVED`
through `BatchUpdateFindings` no longer matches `Workflow.Status: NEW`, which keeps the rule from firing again on it.

## GuardDuty sample findings reach the real rule but point at nonexistent resources

`aws guardduty create-sample-findings` produces findings for fake resources (an instance `i-99999999`). They flow
through Security Hub to the rule, so they prove the delivery path, and the remediation must treat "instance not
found" as a skip, not an error. GuardDuty updates a sample finding it already holds instead of creating a new one, so a
repeated call may produce no new event.

## Quarantining an instance: a new security group allows all outbound traffic

`CreateSecurityGroup` adds an allow-all egress rule. A quarantine group must `RevokeSecurityGroupEgress` that rule
(`IpProtocol: -1`, `0.0.0.0/0` and `::/0`) or the isolated instance can still reach out. Keep the original group IDs
in a tag so the change can be undone.

## A throttled Config recorder deletion can leave the stack in `ROLLBACK_FAILED`

A failed first deploy rolled back, and deleting the Config recorder custom resource hit `Rate exceeded`, leaving the
stack in `ROLLBACK_FAILED`. Running `delete-stack` again completed the deletion.
