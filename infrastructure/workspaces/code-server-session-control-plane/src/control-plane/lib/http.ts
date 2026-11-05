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
 * One JSON line per action, so the function logs answer who started or opened which session and when.
 * Role-based calls cannot answer that, because all sessions share one role.
 */
export function audit(action: string, event: APIGatewayProxyEventV2WithJWTAuthorizer, fields: Record<string, unknown>): void {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  console.log(JSON.stringify({ audit: action, ownerId: claims?.sub, email: claims?.email, sourceIp: event.requestContext.http?.sourceIp, ...fields }));
}

/**
 * The caller's sign-in address, used as the commit author inside the session.
 */
export function getOwnerEmail(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | undefined {
  const email = event.requestContext.authorizer?.jwt?.claims?.email;
  return typeof email === 'string' ? email : undefined;
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
