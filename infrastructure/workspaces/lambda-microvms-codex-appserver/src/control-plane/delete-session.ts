import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { LambdaMicrovmsClient, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { jsonResponse, getOwnerId } from './lib/http';
import { getSession, updateSessionState } from './lib/session-store';

const microvmClient = new LambdaMicrovmsClient({});

/**
 * DELETE /sessions/{sessionId}
 *
 * Ends a Codex session for good: terminates its MicroVM (releasing the
 * Firecracker VM and any suspended snapshot state) and marks the session
 * record TERMINATED. Use POST /sessions/{sessionId}/suspend instead to keep
 * the session resumable.
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

  await microvmClient.send(new TerminateMicrovmCommand({ microvmIdentifier: session.microvmId }));
  await updateSessionState(sessionId, 'TERMINATING');

  return jsonResponse(202, { sessionId, state: 'TERMINATING' });
}
