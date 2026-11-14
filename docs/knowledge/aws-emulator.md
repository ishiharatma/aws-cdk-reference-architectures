# AWS Emulator — Gotchas with CDK Apps

Verified by deploying `eventbridge-custom-bus` and `sqs-lambda-firehose` to AWS Emulator with the
CDK CLI and with cdkd, and running the same scripts on real AWS (ap-northeast-1), November 2026.
AWS Emulator 1.0.343 / 1.0.348 (local) and 1.0.352 (GitHub Actions), `@cdkd/cli` 0.350.1.
AWS Emulator ships several releases a day; re-check before relying on any entry below.

The repository's tooling for this lives in `infrastructure/common/aspects/emulator-compat-aspect.ts`,
`scripts/aws-emulator/` and `.github/workflows/aws-emulator-integration.yml`.

## The installable version is not the latest GitHub release

GitHub releases (`aws/aws-emulator`) carry no packages (only `scores.json.gz`). The deb/rpm come
from `https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/`, which lagged:
GitHub showed 1.0.351 while `LTS/latest` served 1.0.348, and a CI run a few hours later got 1.0.352.
There is no versioned download path to pin, so print `aws-emulator -v` in every CI log. Verify the
package with `gpg --verify` against the key at `https://downloads.aws.com/keys/gpg/current.asc`
(fingerprint `98BC F336 A3BE 53B7 34E9 67C5 2E5B F49B D940 F624`).

## `aws:SecureTransport` is never in the request context — `enforceSSL` denies what AWS allows

Symptom with `new sqs.Queue(..., { enforceSSL: true })` and an SQS event source:
**`The function execution role does not have permissions to call ReceiveMessage on SQS`**
(`CREATE_FAILED` on `AWS::Lambda::EventSourceMapping`) although the role grants
`sqs:ReceiveMessage`. With two identical queue → function pairs, the same one of the two failed on
every CDK CLI run; cdkd failed both every time (it treats the error as IAM propagation and retries
~48 s first).

Root cause: the emulator evaluates the queue policy without `aws:SecureTransport`; a condition on a
missing key is undecided and fails closed, so `Deny sqs:* if aws:SecureTransport=false` applies.
The mapping has no dependency on `AWS::SQS::QueuePolicy`, so whether the policy exists yet depends
on creation order. Reproduced with plain CLI calls (`create-event-source-mapping` succeeds, then
`set-queue-attributes` with the DenyInsecureTransport statement, then it is refused). Real Lambda
creates the mapping with the same policy, even immediately after `SetQueueAttributes`.

The same root cause silently drops **EventBridge → SQS** deliveries: the target queue receives
nothing, the rule's DLQ stays empty, no error anywhere. It also breaks S3 → SQS notification setup
(`aws/aws-emulator#369`). Fix for emulator runs only: strip the `aws:SecureTransport=false` Deny
statements (not the whole policy — EventBridge's Allow lives in the same queue policy).
`EmulatorCompatAspect` does this. Known root cause upstream:
`issues/things-that-do-not-work/20261108T025233Z-iam-the-authorization-gate-publishes-no-request-context.md`.

## Resources created through CloudFormation or Cloud Control can be invisible to the service API

- A custom `AWS::Events::EventBus` created by a CloudFormation stack returns `Ref`/`Arn`, but
  `aws events describe-event-bus` says **`Event bus <name> does not exist.`**, so every
  `AWS::Events::Rule` on it fails. A two-resource template reproduces it; a bus created with the CLI
  works. Open upstream since 2026-10-25 (`20261025T002357Z-events-a-cloudformation-created-aws-events-eventbus-is-invisible.md`).
  Earlier write-ups that found EventBridge working with CDK used the default bus.
- cdkd creates the bus through the SDK, so rules work, but it provisions `AWS::Events::Archive`
  through Cloud Control (`provisionedBy: cc-api` in cdkd state). `aws cloudcontrol get-resource`
  returns it; `aws events list-archives` / `describe-archive` do not, so replay cannot be tested.

## Unsupported CloudFormation type: `AWS::Logs::Delivery*`

**`Template format error: Unrecognized resource types: [AWS::Logs::DeliverySource, AWS::Logs::DeliveryDestination, AWS::Logs::Delivery]`**
at change set creation (event bus log delivery, see [eventbridge-custom-bus.md](eventbridge-custom-bus.md)).
cdkd gets further but fails on `Fn::GetAtt DeliveryDestination.Arn` ("attributes are not enriched
for this resource type") — a cdkd gap, not an emulator one. Remove these three resources for
emulator runs.

## The Lambda runtimes are reimplementations, not the official runtimes

From a probe function on 1.0.343/1.0.348:

| | Python 3.13 / 3.14 | Node.js 22 / 24 |
| --- | --- | --- |
| Version string | `3.14.0.alpha ... [RustPython 0.6.0 ...]` | `v22.0.0` / `v24.0.0` |
| SDK | `boto3` at `/var/task/boto3`, no `botocore.__version__` (emulator shim) | `@aws-sdk/client-*` works |
| Missing | `asyncio` (`No module named '_signal'`), `http.client.IncompleteRead`, urllib3 | `https`, `zlib`, `fetch` |

Consequences:

- A function that bundles urllib3 2.x (Powertools with its tracer, a pinned botocore, requests)
  fails at import: **`Runtime.ImportModuleError: Unable to import module 'index': cannot import name 'IncompleteRead' from 'http.client'`**.
  Real Lambda python3.13 imports the same package (`aws/aws-emulator#408`).
- CDK custom resource handlers (`autoDeleteObjects`, `AwsCustomResource`, e.g. the one
  `targets.CloudWatchLogGroup` adds silently) fail with **`Cannot find module 'zlib'`**; the CDK CLI
  rollback then waits ~90 s and ends in `ROLLBACK_FAILED`.
- A function that uses only the runtime's SDK reaches the emulator with no environment variables
  added (no `AWS_ENDPOINT_URL`, no credentials). `NodejsFunction`'s default of excluding
  `@aws-sdk/*` from the bundle works; bundling the SDK pulls in `https` and fails.

## IAM: everyday grant mistakes are caught, boundaries are not

Despite the documentation's warning, 10 of 11 typical CDK permission mistakes (no grant, grant on
another resource, `grantRead*` then a write, ARN typo, missing `kms:GenerateDataKey` on a CMK queue,
identity-policy Deny, bucket-policy Deny, missing `lambda:InvokeFunction`, SNS grant for another
action) were denied with the same error code and reason clause as AWS
(`because no identity-based policy allows the <action> action`, `with an explicit deny in an
identity-based policy`, `with an explicit deny in a resource-based policy`). A permissions boundary
was **not** enforced: the emulator allowed the call, AWS denied it with
`because no permissions boundary allows the dynamodb:PutItem action`
(upstream `20261113T094431Z-cloudformation-iam-lambda-s3-a-lambda-execution-role.md`).

## cdkd `--aws-emulator`: custom resources run locally, with two prerequisites

cdkd runs custom resource handlers in the official Lambda runtime image on Docker, which makes
`autoDeleteObjects` and `AwsCustomResource` work. It needs:

1. The loopback forwarder image pulled beforehand. Otherwise:
   **`docker: Error response from daemon: No such image: public.ecr.aws/docker/library/node:22-alpine@sha256:...`**.
   The reference is defined in the `cdk-local` dependency (not in cdkd's own `dist/`), so grep the
   whole `@cdkd/cli` install directory for it.
2. The emulator reachable from containers through the Docker bridge gateway. Otherwise:
   **`containers cannot reach port 9297 on the host via <gateway>:9297 (ECONNREFUSED)`**. The native
   emulator binds one address; forward the gateway instead of binding `0.0.0.0`:
   `socat TCP-LISTEN:9297,bind=<gateway>,reuseaddr,fork TCP:127.0.0.1:9297`. Needed both in a
   Docker-in-Docker devcontainer and on `ubuntu-latest` runners.

`--no-local-custom-resources` runs the handler in the emulator's runtime and fails with `zlib`.

## Running the repo's existing test scripts against the emulator

- The scripts default to `--profile <project>-<env>`. Add the emulator's keys under that profile
  name in a separate `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` (`scripts/aws-emulator/env.sh`);
  the emulator writes new keys on every start, so regenerate after a restart.
- Scripts that read `aws cloudformation describe-stacks` outputs find nothing after a cdkd deploy
  (no CloudFormation stack). `scripts/aws-emulator/cfn-outputs-shim/aws` answers those queries from
  `cdkd deploy -O <file>` and passes every other call through.
- The bin files read `process.env.ENV` before `-c env=` (see
  [aws-cdk-deploy-operations.md](aws-cdk-deploy-operations.md)), and `EmulatorCompatAspect` must be
  added to the Stage, not the App (see [remote-access-vpn.md](remote-access-vpn.md)).
- Some scripts are committed without the exec bit (`100644`); call them with `bash` in CI.

## What matched real AWS

EventBridge patterns (numeric, prefix, anything-but, `source`), input transformers, EventBridge →
Lambda and → CloudWatch Logs targets, SQS redrive to a DLQ after `maxReceiveCount`, Firehose
buffering interval and its `timeZone` setting in the S3 prefix. Firehose `PutRecord` returned the
same `RecordId` for every record, unlike AWS.
