import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { resumeCompute, suspendCompute, terminateCompute } from './lib/compute';
import { getOwnerId, jsonResponse } from './lib/http';
import { getOwnedSession, updateSessionState } from './lib/session-store';

/**
 * POST /sessions/{sessionId}/suspend, POST /sessions/{sessionId}/resume, DELETE /sessions/{sessionId}
 *
 * Suspend keeps the session restorable: a MicroVM keeps memory and disk, an EC2 instance stops and
 * keeps its EBS volume. Delete ends it for good and discards a MicroVM's files or the instance's volume.
 */
export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const ownerId = getOwnerId(event);
  const sessionId = event.pathParameters?.sessionId;
  if (!sessionId) return jsonResponse(400, { message: 'Missing sessionId path parameter' });

  const session = await getOwnedSession(sessionId, ownerId);
  if (!session) return jsonResponse(404, { message: 'Session not found' });

  const routeKey = event.routeKey;
  if (routeKey.startsWith('DELETE')) {
    await terminateCompute(session);
    await updateSessionState(sessionId, 'TERMINATING');
    return jsonResponse(202, { sessionId, state: 'TERMINATING' });
  }
  if (routeKey.endsWith('/suspend')) {
    await suspendCompute(session);
    await updateSessionState(sessionId, 'SUSPENDING');
    return jsonResponse(202, { sessionId, state: 'SUSPENDING' });
  }
  await resumeCompute(session);
  await updateSessionState(sessionId, 'PENDING');
  return jsonResponse(202, { sessionId, state: 'PENDING' });
}
