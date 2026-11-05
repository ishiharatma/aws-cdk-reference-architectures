import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/**
 * JSON response that CloudFront must never store: it can carry tokens and per-user state.
 */
export function jsonResponse(statusCode: number, body: unknown, cookies?: string[]): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
    ...(cookies ? { cookies } : {}),
  };
}

/**
 * Extracts the Cognito subject (unique user id) from the HTTP API's JWT
 * authorizer context so sessions can be scoped to their owner.
 */
export function getOwnerId(event: APIGatewayProxyEventV2WithJWTAuthorizer): string {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('Missing sub claim in authorizer context');
  }
  return sub;
}

/**
 * Parses a JSON request body, returning an empty object when it is absent or malformed.
 */
export function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
