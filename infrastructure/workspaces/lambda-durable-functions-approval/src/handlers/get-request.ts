import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { requireEnv } from '../shared/env';
import { json } from '../shared/http';
import { RequestsRepository } from '../shared/requests-repository';
import { REQUEST_ID_PATTERN } from '../shared/types';

const repository = new RequestsRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  requireEnv('TABLE_NAME')
);

/** GET /requests/{requestId} — status from the DynamoDB projection, not GetDurableExecution. */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const requestId = event.pathParameters?.requestId ?? '';
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    return json(400, { message: 'Invalid request ID' });
  }
  const item = await repository.get(requestId);
  if (!item) {
    // Also returned briefly right after POST, before the first step has written the item.
    return json(404, { message: 'Request not found', requestId });
  }
  const { callbackId: _callbackId, ...publicView } = item;
  return json(200, publicView);
};
