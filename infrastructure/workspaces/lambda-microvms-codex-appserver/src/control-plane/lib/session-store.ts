import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.SESSIONS_TABLE_NAME ?? '';

export type SessionState = 'PENDING' | 'RUNNING' | 'SUSPENDED' | 'SUSPENDING' | 'TERMINATED' | 'TERMINATING';

export interface SessionRecord {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly microvmId: string;
  readonly imageArn: string;
  readonly endpoint: string;
  readonly state: SessionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Epoch seconds. DynamoDB TTL attribute; see lib/stacks for the table definition. */
  readonly expiresAt: number;
}

export async function putSession(record: SessionRecord): Promise<void> {
  await ddbClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
    }),
  );
}

export async function getSession(sessionId: string): Promise<SessionRecord | undefined> {
  const result = await ddbClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { sessionId },
    }),
  );
  return result.Item as SessionRecord | undefined;
}

export async function updateSessionState(sessionId: string, state: SessionState): Promise<void> {
  await ddbClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { sessionId },
      UpdateExpression: 'SET #state = :state, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':state': state,
        ':updatedAt': new Date().toISOString(),
      },
    }),
  );
}
