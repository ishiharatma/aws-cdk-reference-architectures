import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

/**
 * JSON response. When the demo web UI is deployed, `CORS_ALLOW_ORIGIN` holds its CloudFront
 * origin; browsers read cross-origin responses only when this header is present.
 */
export const json = (statusCode: number, body: unknown): APIGatewayProxyResult => {
  const allowOrigin = process.env.CORS_ALLOW_ORIGIN;
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin, Vary: 'Origin' } : {}),
    },
    body: JSON.stringify(body),
  };
};

/** Parse a JSON request body; returns undefined when it is missing or malformed. */
export function parseBody(event: APIGatewayProxyEvent): Record<string, unknown> | undefined {
  if (!event.body) return undefined;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Case-insensitive header lookup. */
export function header(event: APIGatewayProxyEvent, name: string): string | undefined {
  const key = Object.keys(event.headers ?? {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? (event.headers[key] ?? undefined) : undefined;
}

/**
 * Caller identity from API Gateway IAM authorization.
 *
 * Credentials from a Cognito identity pool are an assumed-role session whose ARN does not
 * identify the user, so every signed-in user of one role would look like the same caller.
 * For those callers the Cognito identity ID is the per-user identity.
 */
export const callerId = (event: APIGatewayProxyEvent): string => {
  const identity = event.requestContext.identity;
  if (identity?.cognitoIdentityId) {
    return `cognito-identity:${identity.cognitoIdentityId}`;
  }
  return identity?.userArn ?? 'unknown';
};
