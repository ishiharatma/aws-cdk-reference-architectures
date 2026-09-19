import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { LambdaMicrovmsClient, SuspendMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { jsonResponse, getOwnerId } from './lib/http';
import { getSession, updateSessionState } from './lib/session-store';

const microvmClient = new LambdaMicrovmsClient({});

/**
 * POST /sessions/{sessionId}/suspend
 *
 * Explicitly pauses a session's MicroVM ahead of the idlePolicy timeout
 * (for example, a client that knows the user just closed the tab), so
 * billing drops to snapshot storage immediately instead of waiting out the
 * idle window.
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

  await microvmClient.send(new SuspendMicrovmCommand({ microvmIdentifier: session.microvmId }));
  await updateSessionState(sessionId, 'SUSPENDING');

  return jsonResponse(202, { sessionId, state: 'SUSPENDING' });
}
