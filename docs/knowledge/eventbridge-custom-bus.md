# EventBridge Custom Bus — Gotchas Worth Knowing

Verified while building and deploy-verifying `eventbridge-custom-bus` (ap-northeast-1,
aws-cdk-lib 2.270, September 2026).

## `logConfig` alone writes no logs

Setting `LogConfig` (`Level`, `IncludeDetail`) on an event bus only chooses what would be logged.
With no delivery configured, no log group is created and nothing is written. Create a CloudWatch
Logs delivery: `AWS::Logs::DeliverySource` (`ResourceArn` = bus ARN, `LogType` = `INFO_LOGS`),
`AWS::Logs::DeliveryDestination` (`DestinationResourceArn` = log group ARN, `OutputFormat: json`)
and `AWS::Logs::Delivery` linking them. With a log group named
`/aws/vendedlogs/events/event-bus/<bus>` the records (`resource_arn`, `event_id`, `request_id`, …)
appeared within seconds of the first event.

## A rule needs the `source` filter, or foreign producers match

An `OrderPlaced` published with `Source: other.app` matched none of four rules that each pinned
`source: ["app.orders"]`, and was absent from the archive and the audit log. Without the source
filter it would have hit every rule sharing the detail-type.

## Numeric, prefix and anything-but patterns behave as documented

Verified with real events: `{"numeric":[">=",1000]}` (needs a JSON number in `detail`),
`{"prefix":"eu-"}`, `{"anything-but":["user_cancelled"]}`. `detail` is matched on parsed JSON, so
`Detail` must be valid JSON.

## Archive: `EventCount` lags the live bus by several minutes

Right after publishing, `describe-archive` reported `EventCount: 0` for about 4-8 minutes before
jumping to the full count. Do not start a replay (or assert an archive count) immediately; poll
`EventCount` first.

## Replay: restrict it with `FilterArns`, and allow time for delivery

`start-replay --destination '{"Arn":"<bus arn>","FilterArns":["<rule arn>"]}'` re-sent archived
events only to that rule's target; the audit rule and the Lambda rule were not invoked. `State`
goes `STARTING` (several polls) → `COMPLETED`. In one run only one of two replayed events had
reached the target queue within two minutes of `COMPLETED`; a second run got both. Poll the target
for longer than you think you need.

## The target DLQ only covers delivery failures

Events EventBridge cannot deliver to a target (after `retryAttempts` / `maxEventAge`) go to the
target's `deadLetterQueue`. Errors thrown inside a Lambda target are governed by the function's own
asynchronous-invocation configuration, not this DLQ.

## Input transformer with `EventField.fromPath`

`RuleTargetInput.fromObject({ orderId: EventField.fromPath('$.detail.orderId'), … , tier: 'high-value' })`
produced the compact payload `{"orderId":…,"amount":…,"region":…,"tier":"high-value"}` in the SQS
body (no envelope). Only reference paths that are always present on matching events.
