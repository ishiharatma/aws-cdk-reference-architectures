import { randomUUID } from 'node:crypto';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ddb, json, TABLE_NAME } from './utils/clients';

const CATEGORY_PATTERN = /^[a-z0-9-]{1,32}$/;

/**
 * POST /documents
 *
 * Stores the document and returns immediately. The embedding is NOT computed here: the DynamoDB
 * Stream triggers `embed-document` which calls Bedrock and writes the vector back. Keeping Bedrock
 * off the write path means slow or throttled embedding never fails or slows ingestion.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let payload: { title?: unknown; body?: unknown; category?: unknown };
  try {
    payload = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Request body must be valid JSON' });
  }

  const { title, body } = payload;
  const category = payload.category ?? 'general';
  if (typeof title !== 'string' || !title.trim() || typeof body !== 'string' || !body.trim()) {
    return json(400, { message: '`title` and `body` are required non-empty strings' });
  }
  if (typeof category !== 'string' || !CATEGORY_PATTERN.test(category)) {
    return json(400, { message: '`category` must match ^[a-z0-9-]{1,32}$' });
  }

  const docId = randomUUID();
  await ddb.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        docId: { S: docId },
        title: { S: title.trim() },
        body: { S: body.trim() },
        category: { S: category },
        createdAt: { S: new Date().toISOString() },
      },
      ConditionExpression: 'attribute_not_exists(docId)',
    }),
  );

  return json(202, { docId, category, embeddingStatus: 'pending' });
};
