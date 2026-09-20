import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { deleteConnection, findConnectionById } from './lib/connections-store';

/**
 * WebSocket $disconnect route.
 *
 * API Gateway only hands this handler a connectionId (no query string or
 * authorizer context survives to $disconnect), so the session it belonged
 * to is looked up via the ByConnectionId GSI before the (sessionId,
 * connectionId) item can be deleted.
 */
export async function handler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;
  const connection = await findConnectionById(connectionId);
  if (connection) {
    await deleteConnection(connection.sessionId, connectionId);
  }
  return { statusCode: 200, body: 'Disconnected' };
}
