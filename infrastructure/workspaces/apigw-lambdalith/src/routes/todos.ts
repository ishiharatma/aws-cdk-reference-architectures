import { Hono } from 'hono';
import { ScanCommand, PutCommand, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient, TABLE_NAME } from '../utils/dynamodb';

const todos = new Hono();

todos.get('/', async (c) => {
  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAME }));
  return c.json(result.Items ?? []);
});

todos.post('/', async (c) => {
  const body = await c.req.json<{ title?: string }>();
  const now = new Date().toISOString();
  const todo = {
    todoId: uuidv4(),
    title: body.title ?? '',
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: todo }));
  return c.json(todo, 201);
});

todos.get('/:todoId', async (c) => {
  const todoId = c.req.param('todoId');
  const result = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { todoId } }));
  if (!result.Item) return c.json({ message: 'Todo not found' }, 404);
  return c.json(result.Item);
});

todos.put('/:todoId', async (c) => {
  const todoId = c.req.param('todoId');
  const body = await c.req.json<{ title?: string; completed?: boolean }>();
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
  return c.json(result.Attributes);
});

todos.delete('/:todoId', async (c) => {
  const todoId = c.req.param('todoId');
  await docClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { todoId } }));
  return c.body(null, 204);
});

export default todos;
