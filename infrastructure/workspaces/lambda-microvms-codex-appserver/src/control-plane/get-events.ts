import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { jsonResponse, getOwnerId } from './lib/http';
import { getSession } from './lib/session-store';
import { listEventsAfter } from './lib/events-store';

/**
 * GET /sessions/{sessionId}/events?after={sequence}
 *
 * Returns codex app-server output recorded by the in-VM Event Handler,
 * with sequence > `after` (default 0, i.e. everything). The Web UI polls
 * this endpoint repeatedly until a Turn completes -- unlike GET
 * /sessions/{sessionId}, this never talks to the MicroVM data plane, so it
 * keeps working after the session's MicroVM has been SUSPENDED or
 * terminated.
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

  const afterParam = event.queryStringParameters?.after;
  const after = afterParam ? Number(afterParam) : 0;
  if (Number.isNaN(after)) {
    return jsonResponse(400, { message: 'Query parameter "after" must be a number' });
  }

  const events = await listEventsAfter(sessionId, after);
  return jsonResponse(200, { sessionId, events });
}
