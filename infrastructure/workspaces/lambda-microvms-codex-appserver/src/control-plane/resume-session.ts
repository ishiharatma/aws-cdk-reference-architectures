import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CreateMicrovmAuthTokenCommand, LambdaMicrovmsClient, ResumeMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { jsonResponse, getOwnerId } from './lib/http';
import { getSession, updateSessionState } from './lib/session-store';

const microvmClient = new LambdaMicrovmsClient({});

const APP_SERVER_PORT = Number(process.env.CODEX_APP_SERVER_PORT ?? '8080');
const AUTH_TOKEN_EXPIRATION_MINUTES = Number(process.env.AUTH_TOKEN_EXPIRATION_MINUTES ?? '15');

/**
 * POST /sessions/{sessionId}/resume
 *
 * Explicitly resumes a SUSPENDED session's MicroVM and issues a fresh auth
 * token, since any token issued before the suspend has likely expired.
 * codex app-server's process memory (open Thread/Turn/Item state) resumes
 * exactly where Firecracker paused it -- clients do not need to
 * re-`initialize`.
 */
export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const ownerId = getOwnerId(event);
  const sessionId = event.pathParameters?.sessionId;
  if (!sessionId) {
    return jsonResponse(400, { message: 'Missing sessionId path parameter' });
  }

  const session = await getSession(sessionId);
  if (!session || session.ownerId !== ownerId) {
    return jsonResponse(404, { message: 'Session not found' });
  }

  await microvmClient.send(new ResumeMicrovmCommand({ microvmIdentifier: session.microvmId }));
  await updateSessionState(sessionId, 'RUNNING');

  const authTokenResult = await microvmClient.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: session.microvmId,
      expirationInMinutes: AUTH_TOKEN_EXPIRATION_MINUTES,
      allowedPorts: [{ port: APP_SERVER_PORT }],
    }),
  );

  return jsonResponse(200, {
    sessionId,
    state: 'RUNNING',
    endpoint: session.endpoint,
    authToken: authTokenResult.authToken,
  });
}
