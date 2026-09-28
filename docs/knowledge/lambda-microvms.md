# AWS Lambda MicroVMs — Gotchas

Findings from deploy-verifying `lambda-microvms-codex-appserver` (a preview/limited-availability
service as of this writing). Six real, independently-confirmed bugs surfaced across the image
build and the session data plane — none caught by `cdk synth`, unit tests, or cdk-nag, since every
one of them is a live-service behavior no static check can see.

## Lifecycle hooks live under `/aws/lambda-microvms/runtime/v1/<hook-name>`, not bare paths

The single most consequential finding. The AWS Lambda MicroVMs Developer Guide's own OpenAPI spec
for the "Application Hook Interface" states `servers: [{ url: "/aws/lambda-microvms/runtime/v1" }]`
— every lifecycle hook (`ready`, `validate`, `run`, `suspend`, `resume`, `terminate`) is a **POST**
to that full path, e.g. `POST /aws/lambda-microvms/runtime/v1/ready`, not `GET /ready` or
`POST /ready`.

A server that only answers the bare path gets a silent 404 on every hook call from the platform.
There is no error surfaced anywhere obvious: the application container itself starts fine, prints
its own "listening" log line, and just sits there — the *build* eventually fails with
`AWS::Lambda::MicrovmImage ... did not stabilize` (`HandlerErrorCode: NotStabilized`), with **zero
application-level error in the logs**, because the 404 responses are never logged by the
application (it just doesn't recognize the path) and the platform's own retry/timeout behavior
isn't application-visible.

**Confirmed**: switching from `pathname === '/ready'` to
`` pathname === `${HOOK_PREFIX}/ready` `` (with `HOOK_PREFIX = '/aws/lambda-microvms/runtime/v1'`)
in the in-VM server was the single fix that took the image build from a two-attempts-both-timeout
failure to `state: CREATED` on the very next attempt, with nothing else changed.

Source: [AWS Lambda MicroVMs Developer Guide — "Lifecycle hooks"](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html),
which publishes the full OpenAPI spec inline.

## The `/run` hook body is `{ microvmId, runHookPayload }` — `runHookPayload` is a string, not an object

`RunMicrovmCommand.runHookPayload` (the string you pass at `RunMicrovm` time) is **not** delivered
to the `/run` hook directly as the request body — it's nested one level deeper:

```json
{ "microvmId": "mvm-...", "runHookPayload": "the-string-you-passed" }
```

If your own code does `JSON.stringify({ sessionId })` for `runHookPayload` (a common pattern for
passing structured per-session data through a string field), the `/run` handler needs to
`JSON.parse(body.runHookPayload)` — reading `body.sessionId` directly silently gets `undefined`
forever, since that key never exists at the top level.

## The IAM action prefix is `lambda:`, not `lambda-microvms:`

Despite the dedicated `@aws-sdk/client-lambda-microvms` SDK client and the `aws lambda-microvms
...` CLI command group, every MicroVM data-plane action (`RunMicrovm`, `GetMicrovm`,
`SuspendMicrovm`, `ResumeMicrovm`, `TerminateMicrovm`, `CreateMicrovmAuthToken`) is authorized
under IAM's **`lambda:`** namespace — matching the `AWS::Lambda::MicrovmImage` /
`AWS::Lambda::NetworkConnector` CloudFormation resource types, not the CLI/SDK grouping.

**Confirmed** via a real `AccessDeniedException`:
```
User: ...assumed-role/.../CreateSessionFunction... is not authorized to perform:
lambda:RunMicrovm ... because no identity-based policy allows the lambda:RunMicrovm action
```
— naming `lambda:RunMicrovm` as the missing action, when the deployed policy statement granted
`lambda-microvms:RunMicrovm`. IAM doesn't error on referencing a nonexistent action prefix in a
policy (it just silently never matches anything), so this class of mistake produces a plain
`AccessDeniedException` at call time, indistinguishable at a glance from a genuinely missing grant.

## `RunMicrovm` needs `lambda:PassRole` *and* `lambda:PassNetworkConnector` — for connectors you didn't even ask for

Passing `executionRoleArn` to `RunMicrovmCommand` requires the caller to hold `iam:PassRole` on
that role, same as any other AWS service that assumes a role on your behalf — unsurprising.

Less obvious: passing `egressNetworkConnectors` requires an analogous
**`lambda:PassNetworkConnector`** grant scoped to that connector's ARN. And even when
`ingressNetworkConnectors` is left unset entirely, `RunMicrovm` still implicitly attaches an
AWS-managed ingress connector to give the MicroVM its default per-instance HTTPS endpoint —
observed as `arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:HTTP_INGRESS` —
and the caller needs `PassNetworkConnector` on *that* ARN too, discovered only via a second,
separate `AccessDeniedException` naming it once the first (egress) grant was already in place.

**Fix**: grant `lambda:PassNetworkConnector` on both the customer-owned egress connector's ARN and
the AWS-managed connector ARN pattern:
```
arn:<partition>:lambda:<region>:aws:network-connector:aws-network-connector:*
```

## The build's `/ready`/`/validate` hooks run under the *build* role's credentials, not the execution role's

If your application resolves a secret (or does anything else requiring AWS credentials) during
startup — before the platform's `/ready` hook returns 200 — that startup code runs with the
**build role**'s permissions during image creation, not the execution role's, even though the
exact same application code will later run under the execution role once a real MicroVM is
launched from the finished image.

**Confirmed** via a real `AccessDeniedException` naming the build role
(`.../MicrovmImageBuildRole.../...`) as the caller denied `secretsmanager:GetSecretValue`, even
though the execution role already held that exact grant. Fix: grant the build role the same
read-time permissions the execution role needs for whatever your entrypoint touches before
signaling ready.

## `AWS::Lambda::MicrovmImage`'s CloudWatch log group needs an explicit write grant on the build role

Setting `logging.cloudWatch.logGroup` on the image doesn't imply the build role can write to it.
Without `logGroup.grantWrite(buildRole)`, a failed build produces **zero log streams at all** —
not an empty stream, no stream whatsoever — making the actual root cause of a build failure
invisible. This is easy to misdiagnose as "the platform doesn't log anything for this failure
type" when it's actually a straightforward missing IAM grant on the log destination itself.

## Miscellaneous, confirmed facts

- **The base image ARN format is `arn:aws:lambda:<region>:aws:microvm-image:<name>-<version>`**
  (e.g. `arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1`), under the `lambda:`
  namespace with an `aws:` account segment — not `arn:aws:lambda-microvms:...:image/...` as a
  plausible-looking placeholder might suggest. Discover real values with
  `aws lambda-microvms list-managed-microvm-images` /
  `list-managed-microvm-image-versions --image-identifier <arn>`.
- **The Dockerfile-based build genuinely runs `docker build`** inside a Lambda-managed build
  MicroVM (confirmed via real CloudWatch build logs showing standard BuildKit output:
  `apt-get install`, `npm install`, layer export) — a packaged `Dockerfile` isn't just inert
  documentation; `RUN npm install` at build time really does install and bake in dependencies
  (e.g. `@openai/codex`) so they're present without any network access at MicroVM runtime.
- **`ENV CODEX_HOME=/some/path` in a Dockerfile does not create that directory.** `codex
  app-server` refuses to start at all if `CODEX_HOME` doesn't already exist on disk
  (`Error: CODEX_HOME points to "..." but that path does not exist`), so a `RUN mkdir -p
  "$CODEX_HOME"` step is required after setting the env var. This isn't Lambda MicroVMs-specific,
  but it's exactly the kind of small omission that only a real build (not `cdk synth`) surfaces.
- Once the above are all fixed, the full pipeline is genuinely solid: `RunMicrovm` →
  `CreateMicrovmAuthToken` → a client `POST {endpoint}/rpc` with `X-aws-proxy-auth` reaches the
  in-VM server, which relays to `codex app-server` over stdio and gets a real JSON-RPC response
  back (confirmed with a real `initialize` handshake returning `codexHome`/`platformOs`/etc.), and
  DynamoDB Streams-based event persistence + polling both work as documented.
- **IAM policy propagation lag is real and can exceed what `GetRolePolicy` shows.** After a stack
  `UPDATE_COMPLETE` that adds a new `PassNetworkConnector`/`PassRole` grant, `aws iam
  get-role-policy` can already show the new statement while the *authorization* decision used by
  the actual service call still evaluates the old policy for some seconds afterward. Don't
  conclude a fix didn't deploy just because a retry immediately after `UPDATE_COMPLETE` still
  fails with the exact same `AccessDeniedException` — confirm the deployed CloudFormation
  template's `IAM::Policy` resource (`aws cloudformation get-template`) matches your code first,
  then retry after a short wait before assuming the fix itself is wrong.
