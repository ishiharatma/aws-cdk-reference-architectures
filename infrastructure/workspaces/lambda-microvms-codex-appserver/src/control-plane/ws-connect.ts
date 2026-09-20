import type {
  APIGatewayEventWebsocketRequestContextV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2WithRequestContext,
} from 'aws-lambda';
import { getSession } from './lib/session-store';
import { putConnection } from './lib/connections-store';

interface ConnectRequestContext extends APIGatewayEventWebsocketRequestContextV2 {
  // Populated by ws-authorizer.ts's policy context.
  authorizer: { sub: string };
}
type ConnectEvent = APIGatewayProxyWebsocketEventV2WithRequestContext<ConnectRequestContext>;

/**
 * WebSocket $connect route.
 *
 * The client connects with `?sessionId=...&token=...` (the ID token is
 * consumed by ws-authorizer.ts before this handler runs). Registers the
 * connection against that session, scoped to the authenticated owner, so
 * forward-event.ts knows to push this session's future EventsTable writes
 * here.
 */
export async function handler(event: ConnectEvent): Promise<APIGatewayProxyResultV2> {
  const ownerId = event.requestContext.authorizer.sub;
  const sessionId = event.queryStringParameters?.sessionId;
  if (!sessionId) {
    return { statusCode: 400, body: 'Missing sessionId query parameter' };
  }

  const session = await getSession(sessionId);
  if (!session || session.ownerId !== ownerId) {
    return { statusCode: 404, body: 'Session not found' };
  }

  await putConnection({ sessionId, connectionId: event.requestContext.connectionId, ownerId });
  return { statusCode: 200, body: 'Connected' };
}
