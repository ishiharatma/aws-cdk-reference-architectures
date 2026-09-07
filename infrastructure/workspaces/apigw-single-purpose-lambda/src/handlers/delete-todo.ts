import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './utils/dynamodb';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const todoId = event.pathParameters?.todoId;
  await docClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { todoId } }));
  return { statusCode: 204, body: '' };
};
