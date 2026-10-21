import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient, SendDurableExecutionCallbackSuccessCommand } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { requireEnv } from '../shared/env';
import { callerArn, json, parseBody } from '../shared/http';
import { RequestsRepository } from '../shared/requests-repository';
import { REQUEST_ID_PATTERN, type ApprovalDecision } from '../shared/types';

const lambda = new LambdaClient({});
const repository = new RequestsRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  requireEnv('TABLE_NAME')
);

/**
 * POST /requests/{requestId}/decision — resume the waiting execution.
 *
 * Approvers address requests by ID; the callback ID stays server-side. The DynamoDB claim
 * makes the decision single-shot before the callback is sent.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const requestId = event.pathParameters?.requestId ?? '';
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    return json(400, { message: 'Invalid request ID' });
  }
  const body = parseBody(event);
  if (typeof body?.approved !== 'boolean') {
    return json(400, { message: '"approved" must be a boolean' });
  }
  if (
    body.comment !== undefined &&
    (typeof body.comment !== 'string' || body.comment.length > 1000)
  ) {
    return json(400, { message: '"comment" must be a string of up to 1000 characters' });
  }

  const item = await repository.get(requestId);
  if (!item) return json(404, { message: 'Request not found', requestId });
  if (item.status !== 'WAITING_APPROVAL' || !item.callbackId) {
    return json(409, { message: `Request is ${item.status}, not waiting for approval`, requestId });
  }

  const approver = callerArn(event);
  // Separation of duties: the requester cannot approve their own request.
  if (approver === item.requester) {
    return json(403, { message: 'The requester cannot decide on their own request', requestId });
  }

  const decision: ApprovalDecision = {
    approved: body.approved,
    approver,
    ...(typeof body.comment === 'string' ? { comment: body.comment } : {}),
  };
  if (
    !(await repository.claimDecision(
      requestId,
      item.callbackId,
      decision,
      new Date().toISOString()
    ))
  ) {
    return json(409, { message: 'A decision was already submitted', requestId });
  }

  try {
    await lambda.send(
      new SendDurableExecutionCallbackSuccessCommand({
        CallbackId: item.callbackId,
        Result: Buffer.from(JSON.stringify(decision)),
      })
    );
  } catch (error) {
    // Typically the callback already timed out. Release the claim so the state stays truthful.
    await repository.releaseDecision(requestId, new Date().toISOString());
    console.error(
      JSON.stringify({
        message: 'SendDurableExecutionCallbackSuccess failed',
        requestId,
        error: String(error),
      })
    );
    return json(409, { message: 'The request can no longer be decided', requestId });
  }

  return json(202, { requestId, status: 'DECISION_RECEIVED', approved: decision.approved });
};
