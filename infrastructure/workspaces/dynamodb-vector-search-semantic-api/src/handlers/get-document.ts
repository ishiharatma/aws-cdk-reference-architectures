import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ddb, json, TABLE_NAME } from './utils/clients';

/**
 * GET /documents/{docId}
 *
 * Reports whether the asynchronous embedding has completed. The raw vector is deliberately not
 * projected (it is ~5 KB of floats); `embeddedAt` is written together with it and acts as the flag.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const docId = event.pathParameters?.docId;
  if (!docId) return json(400, { message: 'docId is required' });

  const { Item } = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { docId: { S: docId } },
      ProjectionExpression: 'docId, title, category, createdAt, embeddedAt, embeddingModel',
    }),
  );
  if (!Item) return json(404, { message: 'Document not found' });

  return json(200, {
    docId: Item.docId?.S,
    title: Item.title?.S,
    category: Item.category?.S,
    createdAt: Item.createdAt?.S,
    embeddingStatus: Item.embeddedAt ? 'ready' : 'pending',
    embeddedAt: Item.embeddedAt?.S,
    embeddingModel: Item.embeddingModel?.S,
  });
};
