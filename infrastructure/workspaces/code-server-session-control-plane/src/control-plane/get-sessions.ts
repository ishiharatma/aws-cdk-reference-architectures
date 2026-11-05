import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { readState } from './lib/compute';
import { getOwnerId, jsonResponse } from './lib/http';
import { getOwnedSession, listOwnedSessions, SessionRecord, updateSessionState } from './lib/session-store';

async function refresh(session: SessionRecord) {
  const state = session.state === 'TERMINATED' ? session.state : await readState(session);
  if (state !== session.state) await updateSessionState(session.sessionId, state);
  return { sessionId: session.sessionId, compute: session.compute, state, createdAt: session.createdAt };
}

/**
 * GET /sessions and GET /sessions/{sessionId}
 *
 * Reports live state, because idle suspends and lifetime limits happen outside the control plane.
 * The endpoint host and tokens are not part of this response; they come from the access route.
 */
export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const ownerId = getOwnerId(event);
  const sessionId = event.pathParameters?.sessionId;

  if (!sessionId) {
    const sessions = await listOwnedSessions(ownerId);
    const active = sessions.filter((s) => s.state !== 'TERMINATED');
    return jsonResponse(200, { sessions: await Promise.all(active.map(refresh)) });
  }

  const session = await getOwnedSession(sessionId, ownerId);
  if (!session) return jsonResponse(404, { message: 'Session not found' });
  return jsonResponse(200, await refresh(session));
}
