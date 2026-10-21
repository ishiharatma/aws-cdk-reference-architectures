import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DurableExecutionAlreadyStartedException,
  InvokeCommand,
  LambdaClient,
} from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { requireEnv } from '../shared/env';
import { callerId, header, json, parseBody } from '../shared/http';
import { RequestsRepository } from '../shared/requests-repository';
import { REQUEST_ID_PATTERN, toExecutionName, type ApprovalRequestInput } from '../shared/types';

const lambda = new LambdaClient({});
/** Qualified ARN of the `live` alias. Durable functions reject unqualified ARNs. */
const workflowFunctionArn = requireEnv('WORKFLOW_FUNCTION_ARN');
const repository = new RequestsRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  requireEnv('TABLE_NAME')
);

/**
 * POST /requests — start one durable execution per request.
 *
 * The invocation is asynchronous: a synchronous invoke would cap the whole execution at
 * 15 minutes, far shorter than an approval wait. The request ID becomes the durable
 * execution name, so a client retry with the same `Idempotency-Key` and body attaches to
 * the existing execution instead of starting a second one.
 *
 * A reused key with a different body is not rejected by an asynchronous invoke: Invoke still
 * returns the existing execution ARN, and the event fails later with
 * "DurableExecutionAlreadyExists ... different payload" and lands in the DLQ. The projection
 * check below turns that into a 409 before invoking.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const body = parseBody(event);
  const title = body?.title;
  const amount = body?.amount;
  if (typeof title !== 'string' || title.length === 0 || title.length > 200) {
    return json(400, { message: '"title" must be a string of 1-200 characters' });
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return json(400, { message: '"amount" must be a positive number' });
  }

  const idempotencyKey = header(event, 'Idempotency-Key');
  if (idempotencyKey !== undefined && !REQUEST_ID_PATTERN.test(idempotencyKey)) {
    return json(400, { message: 'Idempotency-Key must be 1-55 characters of [A-Za-z0-9_-]' });
  }
  const requestId = idempotencyKey ?? randomUUID();

  // No timestamps in the payload: the execution-name idempotency check compares payloads,
  // so a retry must produce byte-identical input.
  const input: ApprovalRequestInput = { requestId, title, amount, requester: callerId(event) };

  const existing = idempotencyKey !== undefined ? await repository.get(requestId) : undefined;
  if (existing) {
    const sameRequest =
      existing.title === input.title &&
      existing.amount === input.amount &&
      existing.requester === input.requester;
    if (!sameRequest) {
      return json(409, {
        message: 'This Idempotency-Key was already used with a different request',
        requestId,
      });
    }
    return json(200, { requestId, status: existing.status, durableExecutionArn: null });
  }

  try {
    const res = await lambda.send(
      new InvokeCommand({
        FunctionName: workflowFunctionArn,
        InvocationType: 'Event',
        DurableExecutionName: toExecutionName(requestId),
        Payload: Buffer.from(JSON.stringify(input)),
      })
    );
    return json(202, {
      requestId,
      status: 'SUBMITTED',
      durableExecutionArn: res.DurableExecutionArn ?? null,
    });
  } catch (error) {
    // Synchronous-only safety net; see the note above for asynchronous invokes.
    if (error instanceof DurableExecutionAlreadyStartedException) {
      return json(409, {
        message: 'This Idempotency-Key was already used with a different request body',
        requestId,
      });
    }
    throw error;
  }
};
