# Transfer Family SFTP with a Lambda Custom IdP: Gotchas Worth Knowing

Verified while building and deploy-verifying `transfer-sftp-custom-idp`
(ap-northeast-1, aws-cdk-lib 2.265+, October 2026, PUBLIC endpoint, SFTP, key-only).

## User role trust: `aws:SourceArn` must be the *user* ARN

With a custom IdP, authentication succeeds and `sftp` connects, but the first file operation
fails (`dest open "/x": Permission denied`). The Transfer structured log shows
`"message":"Unable to AssumeRole for user"`. The cause was a trust policy condition on the server ARN
(`arn:aws:transfer:<region>:<acct>:server/*`). Transfer Family assumes a user's role with the
**user** ARN as the source:

```typescript
new iam.ServicePrincipal('transfer.amazonaws.com', {
  conditions: {
    StringEquals: { 'aws:SourceAccount': this.account },
    ArnLike: { 'aws:SourceArn': `arn:${this.partition}:transfer:${this.region}:${this.account}:user/${server.attrServerId}/*` },
  },
});
```

An `ls` after login can still succeed with a broken role in some cases, so test an upload (`put`), not only a listing.

## Key-only server: `SftpAuthenticationMethods: PUBLIC_KEY`

`CfnServer.identityProviderDetails.sftpAuthenticationMethods: 'PUBLIC_KEY'` makes Transfer Family call the
Lambda without a `password` field. The Lambda returns `PublicKeys` (a list of `"<type> <base64>"` strings)
and Transfer verifies the signature. Returning `{}` (no `Role`) is the rejection signal. Comments in the
key line are not needed; the scripts store `<type> <base64>`.

## Per-user isolation without per-user roles

Return `HomeDirectoryType: "LOGICAL"`, `HomeDirectoryDetails: JSON.stringify([{Entry:"/",Target:"/bucket/prefix"}])`
and a session `Policy` scoped to `arn:aws:s3:::bucket/prefix/*` (plus `s3:ListBucket` with
`s3:prefix` `StringLike` `["prefix/*","prefix"]`). A shared role then yields the intersection. In the test,
`ls /other-user` failed because the other prefix does not exist in the logical view.

## Testing without a client

`aws transfer test-identity-provider --server-id s-... --user-name u --server-protocol SFTP --source-ip 1.2.3.4`
invokes the IdP Lambda with the given `sourceIp` and protocol. It is the way to test a non-matching source IP
(a real connection always carries the client's real IP). `Response` contains `Role` when authentication
succeeds and is empty otherwise.

## Source IP is checked at authentication, not at the network

The PUBLIC endpoint has no Security Group; TCP/22 is open to the internet. The IdP only rejects after Transfer
Family has started the handshake and called the Lambda. Document it as authentication-time filtering.

## DynamoDB string set inside a map

`UpdateExpression: "ADD config.PublicKeys :k"` and `"DELETE config.PublicKeys :k"` work on a string set nested
in the `config` map and do not touch other attributes. Reject removals that would leave the set empty before calling
DynamoDB (an empty set cannot be stored; deleting the last element removes the attribute).

## A stopped server is still billed: recycle by delete / create

`StopServer` puts the server OFFLINE but billing continues; the documentation says to delete the server to stop
charges. A Lambda can create and delete the server (`CreateServer` / `DeleteServer`) and everything that matters
survives because users live in DynamoDB and files in S3. Verified in ap-northeast-1:

- A new server becomes `ONLINE` in about 2 to 3 minutes; its new `<id>.server.transfer...` name needs about a minute more before it resolves
- The host key changes on every re-creation unless `CreateServer` gets `HostKey` (the OpenSSH private key text, e.g. from a Secrets Manager secret). With it, the ED25519 fingerprint stayed identical
- `CreateServer` with `StructuredLogDestinations` requires these permissions of the **caller**, on `*`: `logs:CreateLogDelivery`, `DeleteLogDelivery`, `GetLogDelivery`, `UpdateLogDelivery`, `ListLogDeliveries`, `DescribeLogGroups`, `DescribeResourcePolicies`, `PutResourcePolicy`. Without them: `Unable to enable logging. User does not have permission to configure log destination resource`
- Lambda `ReservedConcurrentExecutions` can fail with `Specified ReservedConcurrentExecutions ... decreases account's UnreservedConcurrentExecution below its minimum` in accounts with the default low limit. Do not rely on it for mutual exclusion; make the controller converge (tag lookup, keep the lowest server ID)
- Servers can be found by a tag (`ListServers` + `ListTagsForResource`) and `DeleteServer` / `DescribeServer` can be limited with `aws:ResourceTag`; `CreateServer` / `ListServers` can not be restricted by resource
- The IdP Lambda permission (`sourceArn`) and the access role trust (`user/...`) can not name a server that does not exist yet; use `server/*` and `user/*` with `aws:SourceAccount`

## Alarms

- Transfer structured logs contain `"activity-type":"AUTH_FAILURE"`; a plain term metric filter (`"AUTH_FAILURE"`) on the log group works
- `AWS/Transfer` metrics `BytesIn` / `BytesOut` have the dimension `ServerId`, so an on-demand server needs alarms created after each start (the metric alarm fired about 4 minutes after a 3 MB upload with a 5-minute period)
- A CloudWatch alarm can not publish to an SNS topic encrypted with `alias/aws/sns`. Use a customer managed key whose policy allows `cloudwatch.amazonaws.com` (`kms:Decrypt`, `kms:GenerateDataKey*`); the alarm history then shows `Successfully executed action`

## Misc

- Transfer Family server cost is $0.30 per hour per server ($219 for a 730-hour month), plus $0.04/GB.
- cdk-nag `AwsSolutions-L1` flagged Python 3.13 once 3.14 was available in `aws-cdk-lib`; use the newest `lambda.Runtime.PYTHON_3_x`.
- The structured log destination (`structuredLogDestinations`) plus `loggingRole` writes `AUTH_FAILURE` and `ERROR` events with user and source IP; no extra configuration is needed for those.
