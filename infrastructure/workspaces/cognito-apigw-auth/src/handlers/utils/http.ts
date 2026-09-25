import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export type Claims = Record<string, string | undefined>;

/**
 * Claims verified by the API Gateway Cognito authorizer. The function never validates the JWT
 * itself: reaching it means the signature, issuer, audience/client and expiry already passed.
 */
export function claimsOf(event: APIGatewayProxyEvent): Claims {
  return (event.requestContext.authorizer?.claims ?? {}) as Claims;
}

/**
 * `cognito:groups` reaches REST API Lambda proxy integrations as a flattened string
 * (`admin`, or `[admin member]` for several groups), not as an array.
 */
export function groupsOf(claims: Claims): string[] {
  const raw = claims['cognito:groups'];
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);
}
