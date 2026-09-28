# AWS Amplify Hosting — Gotchas

Findings from deploy-verifying `s3-amplify-static-website` (manual/Git-less deployment
mode, zip source in S3).

## `amplify:StartDeployment` with an `s3://` `sourceUrl` needs a bucket policy, not just an IAM grant on the caller or `iamServiceRole`

Passing `sourceUrl: s3://<bucket>/<key>`, `sourceUrlType: 'ZIP'` to `StartDeployment`
does **not** work just because the calling principal (e.g., a custom resource's Lambda
role) has `s3:GetObject`/`s3:GetObjectAcl`/`s3:PutObjectAcl` on the object, and does
**not** work just because the Amplify App's `iamServiceRole` has read access to the
object either. AWS's own documentation
([Creating a bucket policy to deploy a static website from S3](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-with-sdks.html))
states plainly: *"If you deploy your website using an SDK, you must create your own
bucket policy that grants Amplify Hosting permission to retrieve the objects in your
S3 bucket"* — a **resource-based** policy on the bucket itself, granting the
`amplify.amazonaws.com` service principal `s3:ListBucket` and `s3:GetObject`, scoped
with `aws:SourceAccount` and a URL-encoded `aws:SourceArn` (the app/branch ARN)
condition.

**Confirmed failure progression** (each fix only got one step further, in this order):
1. `s3://` sourceUrl + no extra grants → caller role denied `s3:GetObjectAcl`
   (`AccessDenied ... not authorized to perform: s3:GetObjectAcl`).
2. Add `s3:GetObjectAcl` (via `Asset.grantRead`) → caller role then denied
   `s3:PutObjectAcl` on the same object (`StartDeployment` itself calls
   `PutObjectAcl` on the object using the caller's credentials, apparently to try to
   grant itself read access via ACL as a fallback to a bucket policy).
3. Add `s3:PutObjectAcl` too → the IAM-layer `AccessDenied` disappears, but Amplify's
   own API then returns a **still-failing** custom-resource response: *"The bucket
   policy is either missing or has insufficient permissions for this operation"* —
   confirming the requirement is a bucket policy, not any combination of
   identity-based grants.

**Why a bucket policy often isn't an option**: if the zip is staged via a CDK `Asset`
(`aws-cdk-lib/aws-s3-assets`), it lives in the *shared* CDK bootstrap bucket
(`cdk-hnb659fds-assets-<account>-<region>`), not a bucket this stack owns.
`Asset.bucket` is `s3.Bucket.fromBucketAttributes(...)` — an **imported** `IBucket` —
so `addToResourcePolicy(...)` on it is a silent no-op (CDK doesn't manage a policy
resource for a bucket it didn't create), and manually editing the bootstrap stack's
bucket policy from an unrelated workspace stack is the wrong layer to solve this at
even if it were technically wired up.

**Fix that avoids a bucket policy entirely**: don't pass an `s3://` URL. Generate a
**presigned HTTPS GET URL** for the object (`@aws-sdk/s3-request-presigner`'s
`getSignedUrl` against a `GetObjectCommand`) inside your own custom-resource Lambda,
and pass that as `sourceUrl` with `sourceUrlType: 'ZIP'` instead. Amplify then just
performs a plain HTTP GET — no bucket policy, no `iamServiceRole`, needed at all. Only
the Lambda's own role needs `s3:GetObject` on the object (an ordinary identity-based
grant, since presigning is done with the Lambda's own credentials and doesn't require
a live API call to S3).

Note this requires a **real Lambda-backed custom resource** (`cr.Provider` +
`CustomResource`), not `cr.AwsCustomResource` — the latter's `parameters` are static
JSON serialized at synth time, so it has no way to compute a presigned URL (which
must be signed at deploy/invoke time, not baked into the template).

**Verified**: deploy-verified in `s3-amplify-static-website` on 2026-09-27 — after
switching to the presigned-URL approach, `aws amplify list-jobs` showed the deployment
job's status as `SUCCEED`, and `curl https://main.<app-id>.amplifyapp.com/` returned a
real `HTTP 200` with the actual deployed page content.

## `CfnApp.iamServiceRole` isn't required for a pure static manual/zip deploy

If nothing in the app needs Amplify to call another AWS service on your behalf (no
SSR compute, no backend environment secrets pulled at build time, and — per the
finding above — no S3 fetch via an assumed role either), `iamServiceRole` can simply
be omitted from `CfnApp`. Keeping an unused role with a stale S3-read grant around
(from an earlier design that assumed Amplify would use it to fetch the zip) is dead
permission surface with no function.
