import {
  CallbackTimeoutError,
  createRetryStrategy,
  type DurableContext,
} from '@aws/durable-execution-sdk-js';
import type { RequestsRepository } from '../shared/requests-repository';
import { parseDecision, type ApprovalRequestInput, type WorkflowResult } from '../shared/types';

/** Side effects the workflow needs. Injected so the orchestration can be tested locally. */
export interface WorkflowDeps {
  readonly repository: Pick<
    RequestsRepository,
    'createIfAbsent' | 'markWaitingApproval' | 'complete'
  >;
  /** Tell approvers a request is waiting. Runs inside the callback submitter. */
  readonly notifyApprovers: (input: ApprovalRequestInput) => Promise<void>;
  /** Business action after approval. Must be idempotent: the step runs at least once. */
  readonly fulfill: (input: ApprovalRequestInput) => Promise<string>;
  readonly approvalTimeoutHours: number;
}

const fulfillRetry = createRetryStrategy({
  maxAttempts: 3,
  initialDelay: { seconds: 5 },
  backoffRate: 2,
});

/**
 * Approval workflow as one durable execution.
 *
 *   register-request -> wait-for-approval (callback, no compute while waiting)
 *     -> approved:  fulfill-request -> mark-completed
 *     -> rejected:  mark-rejected
 *     -> timed out: mark-expired
 *
 * Replay rules followed here:
 * - Everything non-deterministic (clock, I/O) runs inside a step or the callback submitter.
 * - Step names are part of the checkpoint contract; renaming one breaks in-flight executions
 *   of that version, which is why the function is always invoked through a published version.
 */
export function createApprovalWorkflow(deps: WorkflowDeps) {
  return async (input: ApprovalRequestInput, context: DurableContext): Promise<WorkflowResult> => {
    const { requestId } = input;
    const now = (): string => new Date().toISOString();

    await context.step('register-request', async () => {
      await deps.repository.createIfAbsent(input, now());
    });

    let rawDecision: string;
    try {
      rawDecision = await context.waitForCallback<string>(
        'wait-for-approval',
        async (callbackId) => {
          // The submitter can run more than once, so the update is idempotent. A repeated SNS
          // publish means a duplicate e-mail, which is acceptable for a notification.
          await deps.repository.markWaitingApproval(requestId, callbackId, now());
          await deps.notifyApprovers(input);
        },
        { timeout: { hours: deps.approvalTimeoutHours } }
      );
    } catch (error) {
      if (!(error instanceof CallbackTimeoutError)) throw error;
      await context.step('mark-expired', async () => {
        await deps.repository.complete(requestId, 'EXPIRED', now());
      });
      return { requestId, status: 'EXPIRED' };
    }

    // Pure function of the checkpointed callback result, so it is safe outside a step.
    const decision = parseDecision(rawDecision);

    if (!decision.approved) {
      await context.step('mark-rejected', async () => {
        await deps.repository.complete(requestId, 'REJECTED', now());
      });
      return { requestId, status: 'REJECTED' };
    }

    // Default at-least-once semantics are fine because fulfill() is idempotent. A
    // non-idempotent call (charging a card, a one-shot API) would instead use
    // StepSemantics.AtMostOncePerRetry with no retries and an idempotency key created in its own step.
    const fulfillmentId = await context.step('fulfill-request', async () => deps.fulfill(input), {
      retryStrategy: fulfillRetry,
    });

    await context.step('mark-completed', async () => {
      await deps.repository.complete(requestId, 'COMPLETED', now());
    });

    return { requestId, status: 'COMPLETED', fulfillmentId };
  };
}
