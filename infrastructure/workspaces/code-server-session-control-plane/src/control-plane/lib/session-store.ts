import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.SESSIONS_TABLE_NAME ?? '';

export type Compute = 'microvm' | 'ec2';
export type SessionState = 'PENDING' | 'RUNNING' | 'SUSPENDING' | 'SUSPENDED' | 'TERMINATING' | 'TERMINATED';

export interface SessionRecord {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly compute: Compute;
  /** MicroVM ID or EC2 instance ID, depending on `compute`. */
  readonly resourceId: string;
  /** MicroVM endpoint host. Absent for EC2, which has no inbound path. */
  readonly endpoint?: string;
  readonly state: SessionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Epoch seconds. DynamoDB TTL attribute. */
  readonly expiresAt: number;
}

export async function putSession(record: SessionRecord): Promise<void> {
  await ddbClient.send(new PutCommand({ TableName: TABLE_NAME, Item: record }));
}

/**
 * Returns the session only when it belongs to `ownerId`, so another user's session looks missing.
 */
export async function getOwnedSession(sessionId: string, ownerId: string): Promise<SessionRecord | undefined> {
  const result = await ddbClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { sessionId } }));
  const session = result.Item as SessionRecord | undefined;
  return session?.ownerId === ownerId ? session : undefined;
}

export async function listOwnedSessions(ownerId: string): Promise<SessionRecord[]> {
  const result = await ddbClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'ByOwner',
      KeyConditionExpression: 'ownerId = :ownerId',
      ExpressionAttributeValues: { ':ownerId': ownerId },
    }),
  );
  return (result.Items ?? []) as SessionRecord[];
}

export async function updateSessionState(sessionId: string, state: SessionState): Promise<void> {
  await ddbClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { sessionId },
      UpdateExpression: 'SET #state = :state, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':state': state, ':updatedAt': new Date().toISOString() },
    }),
  );
}
