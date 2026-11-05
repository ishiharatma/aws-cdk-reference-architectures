import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CreateMicrovmAuthTokenCommand, LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { SSMClient, StartSessionCommand } from '@aws-sdk/client-ssm';
import { getOwnerId, jsonResponse, parseBody } from './lib/http';
import { getOwnedSession, SessionRecord } from './lib/session-store';

const microvms = new LambdaMicrovmsClient({});
const ssm = new SSMClient({});

const CODE_SERVER_PORT = Number(process.env.CODE_SERVER_PORT ?? '8080');
const AUTH_TOKEN_MINUTES = Number(process.env.AUTH_TOKEN_MINUTES ?? '60');
// Browsers limit one cookie to about 4 KiB, name and attributes included.
const MAX_COOKIE_VALUE_BYTES = 3900;

async function issueToken(session: SessionRecord): Promise<string> {
  const result = await microvms.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: session.resourceId,
      expirationInMinutes: AUTH_TOKEN_MINUTES,
      allowedPorts: [{ port: CODE_SERVER_PORT }],
    }),
  );
  const token = result.authToken?.['X-aws-proxy-auth'];
  if (!token) throw new Error('CreateMicrovmAuthToken did not return a token');
  return token;
}

/**
 * Local relay: the token goes to the owner's own process, which adds it to every request.
 */
async function relayAccess(session: SessionRecord): Promise<APIGatewayProxyResultV2> {
  const token = await issueToken(session);
  return jsonResponse(200, { endpoint: session.endpoint, token, expiresInMinutes: AUTH_TOKEN_MINUTES });
}

/**
 * Browser only: the same token, in a cookie page scripts cannot read. Lambda@Edge turns it back into
 * the header on each request. SameSite=Strict stops another site from opening the IDE's WebSocket.
 */
async function browserAccess(session: SessionRecord): Promise<APIGatewayProxyResultV2> {
  const value = `${session.endpoint}~${await issueToken(session)}`;
  if (Buffer.byteLength(value) > MAX_COOKIE_VALUE_BYTES) {
    return jsonResponse(502, { message: 'The endpoint token does not fit in a cookie' });
  }
  const cookie = `__Host-mvm=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${AUTH_TOKEN_MINUTES * 60}`;
  return jsonResponse(200, { url: '/', expiresInMinutes: AUTH_TOKEN_MINUTES }, [cookie]);
}

/**
 * EC2: the control plane opens the Session Manager port forward and hands back its stream token, so
 * the user needs session-manager-plugin but no AWS credentials or IAM permissions of their own.
 */
async function tunnelAccess(session: SessionRecord, localPort: unknown): Promise<APIGatewayProxyResultV2> {
  const port = Number(localPort ?? 8443);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return jsonResponse(400, { message: 'localPort must be an integer from 1024 to 65535' });
  }
  const documentName = 'AWS-StartPortForwardingSession';
  const parameters = { portNumber: [String(CODE_SERVER_PORT)], localPortNumber: [String(port)] };
  try {
    const result = await ssm.send(
      new StartSessionCommand({ Target: session.resourceId, DocumentName: documentName, Parameters: parameters, Reason: `session ${session.sessionId}` }),
    );
    return jsonResponse(200, {
      target: session.resourceId,
      documentName,
      parameters,
      ssmSession: { SessionId: result.SessionId, StreamUrl: result.StreamUrl, TokenValue: result.TokenValue },
    });
  } catch (err) {
    // The SSM agent registers only after the instance boots; the client retries on this status.
    if ((err as Error).name === 'TargetNotConnected') {
      return jsonResponse(409, { message: 'The instance is not connected to Session Manager yet' });
    }
    throw err;
  }
}

/**
 * POST /sessions/{sessionId}/access  body: { "type": "relay" | "browser" | "tunnel", "localPort"?: number }
 *
 * The one route that hands out a way in, and only to the session owner.
 */
export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const ownerId = getOwnerId(event);
  const sessionId = event.pathParameters?.sessionId;
  if (!sessionId) return jsonResponse(400, { message: 'Missing sessionId path parameter' });

  const session = await getOwnedSession(sessionId, ownerId);
  if (!session) return jsonResponse(404, { message: 'Session not found' });

  const { type, localPort } = parseBody(event);
  if (session.compute === 'ec2') {
    if (type !== 'tunnel') return jsonResponse(400, { message: 'An EC2 session is reached with type "tunnel"' });
    return tunnelAccess(session, localPort);
  }
  if (type === 'relay') return relayAccess(session);
  if (type === 'browser') return browserAccess(session);
  return jsonResponse(400, { message: 'A MicroVM session is reached with type "relay" or "browser"' });
}
