# Cognito + API Gateway Authorization — Gotchas Worth Knowing

Verified while building and deploy-verifying `cognito-apigw-auth` (ap-northeast-1, aws-cdk-lib
2.270, REST API + `CognitoUserPoolsAuthorizer`, September 2026). Every status code below was
observed against a real deployment.

## The authorizer takes an ID token *or* an access token, depending on the method

A method **without** `authorizationScopes` accepts only an **ID token**; a method **with**
`authorizationScopes` accepts only an **access token**. Sending the other kind is `401
{"message":"Unauthorized"}` — indistinguishable from a bad signature. Decode the token
(`cut -d. -f2 | base64 -d`) and check `token_use` (`id` / `access`).

## Custom scopes are absent from tokens issued by `InitiateAuth`

An access token from `InitiateAuth` (`USER_PASSWORD_AUTH`, SRP) carries only
`aws.cognito.signin.user.admin`. Custom resource-server scopes (`notes/read`) appear only in
access tokens issued by an **OAuth flow** (authorization code via the hosted UI, or
`client_credentials`). A scoped method called with an `InitiateAuth` token is `401`, even though
the user is fully authenticated. Interactive users therefore need the hosted-UI code flow.

## A valid token missing the method's scope is `401`, not `403`

A machine token (`notes/read` only) calling a method that requires `notes/write` returned `401`.
Reserve `403` for checks your Lambda performs itself.

## `cognito:groups` is a flattened string in REST API proxy events

`event.requestContext.authorizer.claims['cognito:groups']` is `admin` or `[admin member]` — a
string, not an array. Parse both shapes. The authorizer never checks groups; enforce them in the
function (or a Lambda authorizer).

## Scripting the hosted-UI code flow with curl (no browser)

1. `GET <domain>/oauth2/authorize?client_id=…&response_type=code&scope=openid+email+<scopes>&redirect_uri=…&code_challenge=…&code_challenge_method=S256`
   with `-L -c jar -b jar -w '%{url_effective}'` — lands on `/login?…` and sets the CSRF cookie.
2. Read `_csrf` from the form (`name="_csrf" value="…"`), then `POST` `username`, `password`, `_csrf`
   to the effective URL (same cookie jar, `-D -`). The `302 Location` is
   `<redirect_uri>?code=…` — do not follow it; take `code`.
3. `POST <domain>/oauth2/token` with `grant_type=authorization_code`, `client_id`, `code`,
   `redirect_uri`, `code_verifier` (PKCE). The response has `id_token`, `access_token`,
   `refresh_token`; `grant_type=refresh_token` later returns an access token that keeps the scopes.

The redirect URI must be one of the client's `callbackUrls` but nothing needs to listen there.

## `sub` is a DynamoDB reserved word

`KeyConditionExpression: 'sub = :sub'` fails with `ValidationException: … reserved keyword: sub`
(surfaced as a 502 through API Gateway). Use `ExpressionAttributeNames: {'#sub': 'sub'}`. Unit
tests with mocked clients cannot catch it; only an end-to-end call does.

## CDK Nag: COG8 (Plus plan) alongside COG3

Current cdk-nag reports `AwsSolutions-COG8` ("not on the plus tier / feature plan") in addition to
`COG3` (advanced security) for a user pool on the default plan. Both need suppressions with a cost
reason unless you buy the Plus plan.

## Identity pool credentials: every user of a role has the same ARN

Verified while deploy-verifying `lambda-durable-functions-approval` (IAM-authorized REST API called
from a browser with identity pool credentials, October 2026). Credentials from
`GetCredentialsForIdentity` (enhanced flow, role from `cognito:preferred_role`) are an assumed-role
session named **`CognitoIdentityCredentials`** for every user:

```text
arn:aws:sts::<account>:assumed-role/<group-role>/CognitoIdentityCredentials
```

So `event.requestContext.identity.userArn` identifies the role, not the user. Any per-user logic
(owner checks, separation of duties) must use `requestContext.identity.cognitoIdentityId` (present
only for identity pool callers) instead. Confirmed with `aws sts get-caller-identity` on the
credentials of two different users and with the IAM denial message from API Gateway.

## Calling an IAM-authorized REST API from a browser

- An IAM denial is a 403 produced by API Gateway, not by your Lambda. Without a `DEFAULT_4XX`
  gateway response that adds `Access-Control-Allow-Origin`, the browser hides it as a network
  error. With `api.addGatewayResponse` for `DEFAULT_4XX` / `DEFAULT_5XX`, the 403 body
  (`User: ... is not authorized to perform: execute-api:Invoke ...`) is readable.
- `@smithy/signature-v4` adds `x-amz-content-sha256`; allow it (and any custom header such as
  `Idempotency-Key`) in the CORS preflight. `Resource.addCorsPreflight` creates the OPTIONS
  method with `AuthorizationType: NONE` even when the API default is `AWS_IAM`.
- `@aws-sdk/credential-providers` does not bundle for the browser (it imports
  `node:child_process`); use `@aws-sdk/credential-provider-cognito-identity` with
  `@aws-sdk/client-cognito-identity`. Its provider calls `GetId` + `GetCredentialsForIdentity` on
  every invocation, and `SignatureV4` asks for credentials on every request, so cache them until
  shortly before `expiration`.

## Managed login (v2) cannot be driven with curl

The curl recipe above (read `_csrf` from the form, POST username/password) works for the classic
hosted UI. The managed login v2 page renders with JavaScript: the HTML has no `_csrf` form field
and the POST does not redirect with a code. For command-line verification of what happens *after*
sign-in, temporarily add `ALLOW_ADMIN_USER_PASSWORD_AUTH` to the same app client
(`update-user-pool-client` overwrites unspecified settings, so send the full current config) and
use `admin-initiate-auth`; the ID token is equivalent for the identity pool. Revert afterwards.

## Managed login language follows `lang`, not the browser

The managed login (v2) page rendered in English for a headless Chromium with locale `ja-JP`.
Adding `lang=ja` to the `/oauth2/authorize` URL rendered it in Japanese ("サインイン",
"E メールアドレス"). Pass the app's UI language as `lang` when building the authorize URL.
