import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { requireEnv } from '../shared/env';
import { RequestsRepository } from '../shared/requests-repository';
import type { ApprovalRequestInput, WorkflowResult } from '../shared/types';
import { createApprovalWorkflow } from '../workflow/approval-workflow';

const repository = new RequestsRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  requireEnv('TABLE_NAME')
);
const sns = new SNSClient({});
const topicArn = requireEnv('APPROVAL_TOPIC_ARN');
const approvalTimeoutMinutes = Number(requireEnv('APPROVAL_TIMEOUT_MINUTES'));

/** Durable function entry point. Invoke it only through the `live` alias (a published version). */
export const handler = withDurableExecution<ApprovalRequestInput, WorkflowResult>(
  createApprovalWorkflow({
    repository,
    approvalTimeoutMinutes,
    notifyApprovers: async (input) => {
      await sns.send(
        new PublishCommand({
          TopicArn: topicArn,
          Subject: `Approval needed: ${input.title}`.slice(0, 100),
          // The callback ID is not included: approvers decide through the API by request ID.
          Message: [
            `Request ID : ${input.requestId}`,
            `Title      : ${input.title}`,
            `Amount     : ${input.amount}`,
            `Requester  : ${input.requester}`,
            `Expires in : ${approvalTimeoutMinutes} minutes`,
            '',
            `POST /requests/${input.requestId}/decision  {"approved": true|false, "comment": "..."}`,
          ].join('\n'),
        })
      );
    },
    // Stand-in for the real business action (provisioning, ordering, ...). Deterministic ID +
    // if_not_exists keep it idempotent under step retries.
    fulfill: async (input) =>
      repository.recordFulfillment(
        input.requestId,
        `ful-${input.requestId}`,
        new Date().toISOString()
      ),
  })
);
