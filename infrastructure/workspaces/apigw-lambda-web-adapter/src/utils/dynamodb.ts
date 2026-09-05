import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const dynamoDbClient = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(dynamoDbClient);
export const TABLE_NAME = process.env.TABLE_NAME!;
