import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

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

/** Caller identity from API Gateway IAM authorization. */
export const callerArn = (event: APIGatewayProxyEvent): string =>
  event.requestContext.identity?.userArn ?? 'unknown';
