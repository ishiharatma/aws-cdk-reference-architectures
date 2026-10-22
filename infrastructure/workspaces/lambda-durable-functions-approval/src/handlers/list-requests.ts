import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { requireEnv } from '../shared/env';
import { json } from '../shared/http';
import { RequestsRepository } from '../shared/requests-repository';
import { isRequestStatus } from '../shared/types';

const repository = new RequestsRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  requireEnv('TABLE_NAME')
);

const MAX_ITEMS = 50;

/**
 * GET /requests?status=WAITING_APPROVAL — the approvers' work list.
 *
 * Reads the status GSI of the projection table (newest first, at most 50 items). Like
 * GET /requests/{id}, it never touches the durable execution APIs.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const status = event.queryStringParameters?.status ?? 'WAITING_APPROVAL';
  if (!isRequestStatus(status)) {
    return json(400, { message: `Unknown status: ${status}` });
  }
  const items = await repository.listByStatus(status, MAX_ITEMS);
  return json(200, {
    items: items.map(({ callbackId: _callbackId, ...publicView }) => publicView),
  });
};
