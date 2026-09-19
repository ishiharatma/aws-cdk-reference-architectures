import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.EVENTS_TABLE_NAME ?? '';

export interface EventRecord {
  readonly sessionId: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly event: unknown;
}

/**
 * Fetches session events with `sequence > after`, ordered oldest-first, for
 * the control plane's polling get-events endpoint. Events are written by
 * the in-VM Event Handler (src/microvm-image/server/event-handler.mjs), so
 * this read path works whether the session's MicroVM is RUNNING,
 * SUSPENDED, or already terminated.
 */
export async function listEventsAfter(sessionId: string, after: number): Promise<EventRecord[]> {
  const result = await ddbClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'sessionId = :sessionId AND #seq > :after',
      ExpressionAttributeNames: { '#seq': 'sequence' },
      ExpressionAttributeValues: { ':sessionId': sessionId, ':after': after },
      ScanIndexForward: true,
    }),
  );
  return (result.Items ?? []) as EventRecord[];
}
