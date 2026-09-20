import type { APIGatewayAuthorizerResult, APIGatewayTokenAuthorizerEvent } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

// Browsers cannot set a custom Authorization header on a WebSocket
// handshake, so the ID token travels as a `token` query string parameter
// instead (WebSocketLambdaAuthorizer's identitySource points at it); the
// authorizer receives it as a bare TOKEN-type authorizer event.
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID ?? '',
  tokenUse: 'id',
  clientId: process.env.USER_POOL_CLIENT_ID ?? '',
});

function policy(principalId: string, effect: 'Allow' | 'Deny', resource: string, context?: Record<string, string>): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }],
    },
    context,
  };
}

/**
 * TOKEN Lambda Authorizer for the WebSocket API's $connect route.
 * Verifies the Cognito ID token carried in the `token` query string
 * parameter and, on success, forwards the token's `sub` claim into
 * ws-connect.ts via the authorizer context so events/sessions stay
 * owner-scoped the same way the HTTP API's JWT authorizer scopes them.
 */
export async function handler(event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  try {
    const claims = await verifier.verify(event.authorizationToken);
    return policy(claims.sub, 'Allow', event.methodArn, { sub: claims.sub });
  } catch (err) {
    console.error('[ws-authorizer] token verification failed', err);
    return policy('unauthorized', 'Deny', event.methodArn);
  }
}
