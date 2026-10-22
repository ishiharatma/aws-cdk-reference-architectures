import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { STATUS_INDEX_NAME } from './types';
import type {
  ApprovalDecision,
  ApprovalRequestInput,
  RequestStatus,
  TerminalStatus,
} from './types';

/** One request as stored in the table. `callbackId` is internal and never returned by the API. */
export interface RequestItem extends ApprovalRequestInput {
  readonly status: RequestStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly callbackId?: string;
  readonly decision?: ApprovalDecision;
  readonly fulfillmentId?: string;
}

const isConditionalFailure = (error: unknown): boolean =>
  error instanceof ConditionalCheckFailedException;

/**
 * Status projection of the durable executions.
 *
 * The durable execution state itself is only reachable through GetDurableExecution
 * (30 requests per second per Region), so the API reads this table instead. Every write
 * is conditional or idempotent because the workflow steps that call it run at least once.
 */
export class RequestsRepository {
  /**
   * Bind the repository to one table.
   * @param doc DynamoDB document client
   * @param tableName requests table name
   */
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  /** Read one request (including the internal callback ID). */
  async get(requestId: string): Promise<RequestItem | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { requestId } })
    );
    return res.Item as RequestItem | undefined;
  }

  /** Newest requests in one status (including the internal callback ID). */
  async listByStatus(status: RequestStatus, limit: number): Promise<RequestItem[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: STATUS_INDEX_NAME,
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status },
        ScanIndexForward: false,
        Limit: limit,
      })
    );
    return (res.Items ?? []) as RequestItem[];
  }

  /** Insert the request once; a replayed or retried step finds it already there. */
  async createIfAbsent(input: ApprovalRequestInput, now: string): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...input, status: 'SUBMITTED', createdAt: now, updatedAt: now },
          ConditionExpression: 'attribute_not_exists(requestId)',
        })
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  /** Store the callback ID so the decision API can complete the waiting callback. */
  async markWaitingApproval(requestId: string, callbackId: string, now: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { requestId },
        UpdateExpression: 'SET #status = :waiting, callbackId = :cb, updatedAt = :now',
        ConditionExpression: '#status IN (:submitted, :waiting)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':waiting': 'WAITING_APPROVAL',
          ':submitted': 'SUBMITTED',
          ':cb': callbackId,
          ':now': now,
        },
      })
    );
  }

  /**
   * Claim the right to decide. Only one caller wins, so a second decision (or a double click)
   * cannot complete the callback twice with different results.
   */
  async claimDecision(
    requestId: string,
    callbackId: string,
    decision: ApprovalDecision,
    now: string
  ): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { requestId },
          UpdateExpression: 'SET #status = :received, decision = :decision, updatedAt = :now',
          ConditionExpression: '#status = :waiting AND callbackId = :cb',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':received': 'DECISION_RECEIVED',
            ':waiting': 'WAITING_APPROVAL',
            ':cb': callbackId,
            ':decision': decision,
            ':now': now,
          },
        })
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  /** Undo a claim when sending the callback failed, so the approver can retry. */
  async releaseDecision(requestId: string, now: string): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { requestId },
          UpdateExpression: 'SET #status = :waiting, updatedAt = :now REMOVE decision',
          ConditionExpression: '#status = :received',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':waiting': 'WAITING_APPROVAL',
            ':received': 'DECISION_RECEIVED',
            ':now': now,
          },
        })
      );
    } catch (error) {
      // The workflow already moved on (for example, the approval timed out): nothing to release.
      if (!isConditionalFailure(error)) throw error;
    }
  }

  /** Idempotent: a retried step keeps the first fulfillment ID. */
  async recordFulfillment(requestId: string, fulfillmentId: string, now: string): Promise<string> {
    const res = await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { requestId },
        UpdateExpression: 'SET fulfillmentId = if_not_exists(fulfillmentId, :f), updatedAt = :now',
        ExpressionAttributeValues: { ':f': fulfillmentId, ':now': now },
        ReturnValues: 'ALL_NEW',
      })
    );
    return (res.Attributes as RequestItem).fulfillmentId ?? fulfillmentId;
  }

  /** Move to a terminal status and drop the callback ID, which is useless from now on. */
  async complete(requestId: string, status: TerminalStatus, now: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { requestId },
        UpdateExpression: 'SET #status = :status, updatedAt = :now REMOVE callbackId',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status, ':now': now },
      })
    );
  }
}
