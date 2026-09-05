import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './utils/dynamodb';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const todoId = event.pathParameters?.todoId;
  const body = JSON.parse(event.body ?? '{}');
  const now = new Date().toISOString();
  const result = await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { todoId },
    UpdateExpression: 'SET title = :title, completed = :completed, updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':title': body.title,
      ':completed': body.completed ?? false,
      ':updatedAt': now,
    },
    ReturnValues: 'ALL_NEW',
  }));
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result.Attributes),
  };
};
