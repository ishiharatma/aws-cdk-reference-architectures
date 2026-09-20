import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetMicrovmCommand, LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { jsonResponse, getOwnerId } from './lib/http';
import { getSession, updateSessionState, SessionState } from './lib/session-store';

const microvmClient = new LambdaMicrovmsClient({});

/**
 * GET /sessions/{sessionId}
 *
 * Returns the session's current state, refreshing it from the MicroVM
 * data-plane (GetMicrovm) so a client polling this endpoint observes
 * PENDING -> RUNNING and RUNNING -> SUSPENDED transitions it did not itself
 * trigger (for example, an idlePolicy auto-suspend).
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

  const microvm = await microvmClient.send(new GetMicrovmCommand({ microvmIdentifier: session.microvmId }));
  if (microvm.state && microvm.state !== session.state) {
    await updateSessionState(sessionId, microvm.state as SessionState);
  }

  return jsonResponse(200, {
    sessionId,
    state: microvm.state ?? session.state,
    endpoint: microvm.endpoint ?? session.endpoint,
  });
}
