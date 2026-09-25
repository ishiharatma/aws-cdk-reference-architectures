# Secrets Manager Rotation for Aurora — Gotchas Worth Knowing

Verified while building and deploy-verifying `secrets-rotation-aurora` (ap-northeast-1,
aws-cdk-lib 2.270, Aurora PostgreSQL 16.13 Serverless v2, hosted rotation, September 2026).

## RDS Data API caches the secret's credentials for a few minutes

After `AWSCURRENT` flipped to the other user, a consumer using the Data API (`secretArn`) kept
connecting as the **old** database user for **about 2 to 4 minutes** (three measurements: ~2.4,
~3.4 and ~3.7 minutes) before switching to the new one. Consequences:

- With **alternating-user** rotation the old credentials stay valid, so nothing failed during
  that window (every sample query succeeded as the old or the new user).
- With **single-user** rotation the same window would fail queries made with the cached, now
  wrong, password.
- Any consumer that caches credentials must re-read the secret on authentication failure (or on a
  timer shorter than the tolerance for stale credentials) and retry once.

## The alternating-user rotation flips the username in the secret

After one rotation the secret's `username` was `appuser_clone`; after two, `appuser` again. The
old role is never dropped. `AWSPREVIOUS` holds the previous version. Assert the flip by reading
`username` from `get-secret-value`, not by inferring it from the password change.

## The database role must exist before the first rotation

`rds.DatabaseSecret` (with `masterSecret`) creates a secret whose JSON carries `masterarn`, but
nothing creates the database role. Create it (e.g. through the Data API with the master credentials:
`CREATE ROLE appuser LOGIN PASSWORD '<secret password>'`, then `GRANT CONNECT` / `GRANT USAGE`)
before rotating; otherwise the rotation's `setSecret` step fails. Set
`rotateImmediatelyOnUpdate: false` so a deploy does not trigger a rotation that cannot succeed yet.

## Hosted rotation in isolated subnets needs a Secrets Manager interface endpoint

With no NAT gateway, the hosted rotation functions (run in the VPC) reach the Secrets Manager API
through `vpc.addInterfaceEndpoint(..., SECRETS_MANAGER)` (private DNS on). Give the rotation
functions their own security group and allow it to reach the endpoint on 443 and the database
port. Rotations completed in about 6 seconds once the network path was right.

## Secret names are reserved after deletion

CloudFormation deletes a secret with a recovery window; the name stays reserved, so redeploying the
same stack fails until the window ends. In dev, force-delete after the stack is gone:
`aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery`.

## Serverless v2 and the Data API

`enableDataApi: true` on an Aurora PostgreSQL 16.13 Serverless v2 cluster worked in
ap-northeast-1 (`SupportsHttpEndpoint` in `describe-db-engine-versions` shows `None` for these
versions, so do not use it to decide; try it). `RotationSchedule` renders
`ScheduleExpression: rate(30 days)` for `automaticallyAfter: Duration.days(30)`.
