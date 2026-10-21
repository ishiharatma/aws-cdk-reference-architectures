import { randomUUID } from 'crypto';
import {
  DurableExecutionAlreadyStartedException,
  InvokeCommand,
  LambdaClient,
} from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { requireEnv } from '../shared/env';
import { callerArn, header, json, parseBody } from '../shared/http';
import { REQUEST_ID_PATTERN, toExecutionName, type ApprovalRequestInput } from '../shared/types';

const lambda = new LambdaClient({});
/** Qualified ARN of the `live` alias. Durable functions reject unqualified ARNs. */
const workflowFunctionArn = requireEnv('WORKFLOW_FUNCTION_ARN');

/**
 * POST /requests — start one durable execution per request.
 *
 * The invocation is asynchronous: a synchronous invoke would cap the whole execution at
 * 15 minutes, far shorter than an approval wait. The request ID becomes the durable
 * execution name, so a client retry with the same `Idempotency-Key` and body attaches to
 * the existing execution instead of starting a second one.
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
  const input: ApprovalRequestInput = { requestId, title, amount, requester: callerArn(event) };

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
    if (error instanceof DurableExecutionAlreadyStartedException) {
      return json(409, {
        message: 'This Idempotency-Key was already used with a different request body',
        requestId,
      });
    }
    throw error;
  }
};
