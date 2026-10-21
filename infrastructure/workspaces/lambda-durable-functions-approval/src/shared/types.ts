/** Lifecycle of an approval request as projected into DynamoDB. */
export type RequestStatus =
  'SUBMITTED' | 'WAITING_APPROVAL' | 'DECISION_RECEIVED' | 'COMPLETED' | 'REJECTED' | 'EXPIRED';

/** Statuses after which the durable execution has ended. */
export type TerminalStatus = Extract<RequestStatus, 'COMPLETED' | 'REJECTED' | 'EXPIRED'>;

/** Payload of one durable execution. Keep it small: it is stored once and read on every replay. */
export interface ApprovalRequestInput {
  readonly requestId: string;
  readonly title: string;
  readonly amount: number;
  /** IAM principal that submitted the request (API Gateway IAM auth). */
  readonly requester: string;
}

/** Result the approver sends back through SendDurableExecutionCallbackSuccess. */
export interface ApprovalDecision {
  readonly approved: boolean;
  readonly approver: string;
  readonly comment?: string;
}

/** Return value of the durable execution (visible in GetDurableExecution). */
export interface WorkflowResult {
  readonly requestId: string;
  readonly status: TerminalStatus;
  readonly fulfillmentId?: string;
}

const EXECUTION_NAME_PREFIX = 'approval-';

/**
 * Request IDs double as the durable execution name, which allows 1-64 characters of
 * `[a-zA-Z0-9-_]`. The prefix takes 9 of them.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,55}$/;

/** Durable execution name for a request; the idempotency key of the execution start. */
export const toExecutionName = (requestId: string): string =>
  `${EXECUTION_NAME_PREFIX}${requestId}`;

/** Parse the raw callback result. Throws on anything that is not a well-formed decision. */
export function parseDecision(raw: string): ApprovalDecision {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) {
    throw new Error('Decision must be a JSON object');
  }
  const { approved, approver, comment } = value as Record<string, unknown>;
  if (typeof approved !== 'boolean' || typeof approver !== 'string' || approver.length === 0) {
    throw new Error('Decision requires boolean "approved" and non-empty "approver"');
  }
  if (comment !== undefined && typeof comment !== 'string') {
    throw new Error('"comment" must be a string');
  }
  return { approved, approver, ...(comment !== undefined ? { comment } : {}) };
}
