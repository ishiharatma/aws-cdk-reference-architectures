import { Router, Request, Response, NextFunction } from 'express';
import { ScanCommand, PutCommand, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient, TABLE_NAME } from '../utils/dynamodb';
import { validateTodoInput } from '../utils/validation';

const router = Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAME }));
    res.json(result.Items ?? []);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Without API Gateway in front, request validation is the application's job.
    const input = validateTodoInput(req.body, { requireTitle: true });
    if (!input.ok) {
      res.status(400).json({ message: input.message });
      return;
    }
    const now = new Date().toISOString();
    const todo = {
      todoId: uuidv4(),
      title: input.value.title,
      completed: input.value.completed ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: todo }));
    res.status(201).json(todo);
  } catch (err) {
    next(err);
  }
});

router.get('/:todoId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { todoId } = req.params;
    const result = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { todoId } }));
    if (!result.Item) {
      res.status(404).json({ message: 'Todo not found' });
      return;
    }
    res.json(result.Item);
  } catch (err) {
    next(err);
  }
});

router.put('/:todoId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { todoId } = req.params;
    const input = validateTodoInput(req.body, { requireTitle: true });
    if (!input.ok) {
      res.status(400).json({ message: input.message });
      return;
    }
    const now = new Date().toISOString();
    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { todoId },
        UpdateExpression: 'SET title = :title, completed = :completed, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(todoId)',
        ExpressionAttributeValues: {
          ':title': input.value.title,
          ':completed': input.value.completed ?? false,
          ':updatedAt': now,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    res.json(result.Attributes);
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      res.status(404).json({ message: 'Todo not found' });
      return;
    }
    next(err);
  }
});

router.delete('/:todoId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { todoId } = req.params;
    await docClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { todoId } }));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
