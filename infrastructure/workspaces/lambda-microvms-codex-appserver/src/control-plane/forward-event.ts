import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { deleteConnection, listConnectionsForSession } from './lib/connections-store';

const managementClient = new ApiGatewayManagementApiClient({ endpoint: process.env.WEBSOCKET_CALLBACK_URL });

interface EventItem {
  readonly sessionId: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly event: unknown;
}

async function forwardRecord(record: DynamoDBRecord): Promise<void> {
  if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) return;

  const item = unmarshall(record.dynamodb.NewImage as Record<string, never>) as EventItem;
  const connections = await listConnectionsForSession(item.sessionId);
  if (connections.length === 0) return;

  const body = Buffer.from(
    JSON.stringify({ sessionId: item.sessionId, sequence: item.sequence, recordedAt: item.recordedAt, event: item.event }),
  );

  await Promise.all(
    connections.map(async (connection) => {
      try {
        await managementClient.send(new PostToConnectionCommand({ ConnectionId: connection.connectionId, Data: body }));
      } catch (err) {
        if (err instanceof GoneException) {
          // The client disconnected without $disconnect ever firing (e.g. a
          // dropped network); clean up the stale registration.
          await deleteConnection(item.sessionId, connection.connectionId);
        } else {
          console.error('[forward-event] failed to push to connection', connection.connectionId, err);
        }
      }
    }),
  );
}

/**
 * DynamoDB Streams trigger on EventsTable.
 *
 * Pushes every newly written codex app-server output line to whichever
 * WebSocket connections are currently watching that session
 * (ConnectionsTable), in near-real-time. This is additive to -- not a
 * replacement for -- get-events's pull-based read: a client should still
 * fetch existing events after connecting to cover anything written before
 * (or between) its WebSocket connection.
 */
export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  await Promise.all(event.Records.map(forwardRecord));
}
