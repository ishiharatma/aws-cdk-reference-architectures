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
