import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME ?? '';
const CONNECTION_TTL_HOURS = 24;

export interface ConnectionRecord {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly ownerId: string;
}

export async function putConnection(record: ConnectionRecord): Promise<void> {
  await ddbClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...record,
        connectedAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + CONNECTION_TTL_HOURS * 60 * 60,
      },
    }),
  );
}

/** Every connection currently watching a session, for forward-event.ts to push to. */
export async function listConnectionsForSession(sessionId: string): Promise<ConnectionRecord[]> {
  const result = await ddbClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'sessionId = :sessionId',
      ExpressionAttributeValues: { ':sessionId': sessionId },
    }),
  );
  return (result.Items ?? []) as ConnectionRecord[];
}

/**
 * ws-disconnect.ts only receives connectionId from API Gateway, so it must
 * look up the session via the ByConnectionId GSI before it can delete the
 * (sessionId, connectionId) item.
 */
export async function findConnectionById(connectionId: string): Promise<ConnectionRecord | undefined> {
  const result = await ddbClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'ByConnectionId',
      KeyConditionExpression: 'connectionId = :connectionId',
      ExpressionAttributeValues: { ':connectionId': connectionId },
      Limit: 1,
    }),
  );
  return (result.Items ?? [])[0] as ConnectionRecord | undefined;
}

export async function deleteConnection(sessionId: string, connectionId: string): Promise<void> {
  await ddbClient.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { sessionId, connectionId },
    }),
  );
}
