# RDS Multi-AZ vs Read Replica (PostgreSQL) — Measured Facts and Gotchas

Verified while deploy-verifying `rds-multiaz-vs-read-replica` (ap-northeast-1, RDS for PostgreSQL 17.9, `db.t4g.micro`,
aws-cdk-lib 2.270, October 2026).

## `ReplicaLag` climbs by 60 s per minute on an idle PostgreSQL primary

For PostgreSQL the metric is the time since the last replayed transaction. With no writes it grows without any actual
lag (observed 91, 151, 211, 271 s, then 16 s when a write arrived), and a lag alarm sits in `ALARM` on a healthy
replica. A heartbeat write once a minute bounds it, but the metric then reads between 0 and about 60 s (observed 21 to
51 s) while a marker written on the primary was visible on the replica in 7 ms (median). An alarm threshold must be above the
heartbeat interval; for a tighter alarm, write the heartbeat more often than the threshold.

## Measuring replica lag with a marker

Write a row on the primary, poll the replica until it appears: median 7 ms, p95 20 ms, max 21 ms over 30 samples on an idle,
same-Region replica. That is a measurement of replication delay; the CloudWatch metric is not.

## A Multi-AZ instance failover: the replica carries on

`reboot-db-instance --force-failover` on the Multi-AZ primary, with a new connection per second to both endpoints:
the primary endpoint was unreachable for 13 s (one window) and the instance moved from one AZ to the other; the read
replica endpoint answered 330 of 330 probes, and replication from the new primary resumed (20 of 20 new writes visible,
median 5 ms).

## A replica refuses writes with a read-only transaction error

`CREATE TABLE`/`INSERT` on the replica: `cannot execute CREATE TABLE in a read-only transaction`;
`pg_is_in_recovery()` is `true` on the replica and `false` on the primary. The Multi-AZ standby has no endpoint to ask.

## Promotion detaches the replica for good

After `promote-read-replica` the instance has no `ReadReplicaSourceDBInstanceIdentifier`, accepts writes, and a write to
the primary made 15 s later did not appear on it. A stack that contains the replica can still delete it.

## Timing

A stack with a Multi-AZ primary and its read replica took about 27 minutes to create (the replica is created after the
primary). An update that only changes the Lambda, the schedule rule or the alarm took about 2 minutes.

## Lambda in isolated subnets with a Secrets Manager interface endpoint

A VPC with isolated subnets only (no NAT) and a `SECRETS_MANAGER` interface endpoint is enough for a Lambda that reads a
secret and connects to RDS; the endpoint's security group admits HTTPS from the VPC CIDR.
