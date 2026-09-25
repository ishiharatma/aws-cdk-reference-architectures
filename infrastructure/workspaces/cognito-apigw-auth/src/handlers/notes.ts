import { randomUUID } from 'node:crypto';
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { claimsOf, json } from './utils/http';

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME ?? '';

/**
 * GET /notes (scope notes/read) and POST /notes (scope notes/write).
 *
 * Data isolation: the partition key is the token's `sub`, taken from verified claims, never from
 * the request. A caller can only ever read or write their own partition. For a machine client
 * (client_credentials) `sub` is the client ID, so machines get their own partition too.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const sub = claimsOf(event).sub;
  if (!sub) return json(401, { message: 'Missing subject' });

  if (event.httpMethod === 'POST') {
    let text: unknown;
    try {
      text = JSON.parse(event.body ?? '{}').text;
    } catch {
      return json(400, { message: 'Body must be JSON' });
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 500) {
      return json(400, { message: '`text` must be a non-empty string of at most 500 characters' });
    }
    const noteId = randomUUID();
    await ddb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: { sub: { S: sub }, noteId: { S: noteId }, text: { S: text.trim() }, createdAt: { S: new Date().toISOString() } },
      }),
    );
    return json(201, { noteId, text: text.trim() });
  }

  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      // `sub` is a DynamoDB reserved word, so it must be aliased in expressions.
      KeyConditionExpression: '#sub = :sub',
      ExpressionAttributeNames: { '#sub': 'sub' },
      ExpressionAttributeValues: { ':sub': { S: sub } },
      Limit: 50,
    }),
  );
  return json(200, { notes: Items.map((i) => ({ noteId: i.noteId?.S, text: i.text?.S, createdAt: i.createdAt?.S })) });
};
