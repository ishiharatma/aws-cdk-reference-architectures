import {
  CallbackTimeoutError,
  withDurableExecution,
  type DurableContext,
} from '@aws/durable-execution-sdk-js';
import {
  LocalDurableTestRunner,
  WaitingOperationStatus,
} from '@aws/durable-execution-sdk-js-testing';
import type { ApprovalRequestInput } from 'src/shared/types';
import { createApprovalWorkflow, type WorkflowDeps } from 'src/workflow/approval-workflow';

const input: ApprovalRequestInput = {
  requestId: 'req-001',
  title: 'New laptop',
  amount: 1200,
  requester: 'arn:aws:iam::123456789012:user/alice',
};

const approve = JSON.stringify({ approved: true, approver: 'arn:aws:iam::123456789012:user/bob' });
const reject = JSON.stringify({
  approved: false,
  approver: 'arn:aws:iam::123456789012:user/bob',
  comment: 'Over budget',
});

/** Workflow dependencies backed by jest mocks. */
function makeDeps(overrides: Partial<WorkflowDeps> = {}) {
  const repository = {
    createIfAbsent: jest.fn().mockResolvedValue(true),
    markWaitingApproval: jest.fn().mockResolvedValue(undefined),
    complete: jest.fn().mockResolvedValue(undefined),
  };
  const deps = {
    repository,
    notifyApprovers: jest.fn().mockResolvedValue(undefined),
    fulfill: jest.fn().mockResolvedValue('ful-req-001'),
    approvalTimeoutHours: 48,
    ...overrides,
  };
  return { deps, repository };
}

/**
 * Runs the real orchestration code on the local durable backend. `skipTime` turns the
 * 48-hour callback timeout and retry back-offs into instant transitions.
 */
describe('approval workflow (LocalDurableTestRunner)', () => {
  beforeAll(() => LocalDurableTestRunner.setupTestEnvironment({ skipTime: true }));
  afterAll(() => LocalDurableTestRunner.teardownTestEnvironment());

  const runnerFor = (deps: WorkflowDeps) =>
    new LocalDurableTestRunner({
      handlerFunction: withDurableExecution(createApprovalWorkflow(deps)),
    });

  test('approved: fulfills and completes', async () => {
    const { deps, repository } = makeDeps();
    const runner = runnerFor(deps);

    const execution = runner.run({ payload: input });
    const approval = runner.getOperation('wait-for-approval');
    await approval.waitForData(WaitingOperationStatus.SUBMITTED);
    await approval.sendCallbackSuccess(approve);
    const result = await execution;

    expect(result.getStatus()).toBe('SUCCEEDED');
    expect(result.getResult()).toEqual({
      requestId: 'req-001',
      status: 'COMPLETED',
      fulfillmentId: 'ful-req-001',
    });
    // The submitter stored a callback ID before notifying approvers.
    expect(repository.markWaitingApproval).toHaveBeenCalledWith(
      'req-001',
      expect.any(String),
      expect.any(String)
    );
    expect(deps.notifyApprovers).toHaveBeenCalledWith(input);
    expect(deps.fulfill).toHaveBeenCalledTimes(1);
    expect(repository.complete).toHaveBeenCalledWith('req-001', 'COMPLETED', expect.any(String));
  });

  test('rejected: skips fulfillment', async () => {
    const { deps, repository } = makeDeps();
    const runner = runnerFor(deps);

    const execution = runner.run({ payload: input });
    const approval = runner.getOperation('wait-for-approval');
    await approval.waitForData(WaitingOperationStatus.SUBMITTED);
    await approval.sendCallbackSuccess(reject);
    const result = await execution;

    expect(result.getStatus()).toBe('SUCCEEDED');
    expect(result.getResult()).toEqual({ requestId: 'req-001', status: 'REJECTED' });
    expect(deps.fulfill).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenCalledWith('req-001', 'REJECTED', expect.any(String));
  });

  test('callback failure sent by an external system fails the execution (not EXPIRED)', async () => {
    const { deps, repository } = makeDeps();
    const runner = runnerFor(deps);

    const execution = runner.run({ payload: input });
    const approval = runner.getOperation('wait-for-approval');
    await approval.waitForData(WaitingOperationStatus.SUBMITTED);
    await approval.sendCallbackFailure({ ErrorMessage: 'approver system unavailable' });
    const result = await execution;

    expect(result.getStatus()).toBe('FAILED');
    expect(repository.complete).not.toHaveBeenCalled();
  });

  test('transient fulfillment failure: the step retries and the execution still completes', async () => {
    const fulfill = jest
      .fn()
      .mockRejectedValueOnce(new Error('downstream throttled'))
      .mockResolvedValue('ful-req-001');
    const { deps } = makeDeps({ fulfill });
    const runner = runnerFor(deps);

    const execution = runner.run({ payload: input });
    const approval = runner.getOperation('wait-for-approval');
    await approval.waitForData(WaitingOperationStatus.SUBMITTED);
    await approval.sendCallbackSuccess(approve);
    const result = await execution;

    expect(result.getStatus()).toBe('SUCCEEDED');
    expect(fulfill).toHaveBeenCalledTimes(2);
    expect(runner.getOperation('fulfill-request').getStepDetails()?.attempt).toBe(2);
  });

  test('replay does not repeat completed steps', async () => {
    const { deps, repository } = makeDeps();
    const runner = runnerFor(deps);

    const execution = runner.run({ payload: input });
    const approval = runner.getOperation('wait-for-approval');
    await approval.waitForData(WaitingOperationStatus.SUBMITTED);
    await approval.sendCallbackSuccess(approve);
    const result = await execution;

    // The handler ran again after the callback (replay), yet register-request ran once.
    expect(result.getInvocations().length).toBeGreaterThanOrEqual(2);
    expect(repository.createIfAbsent).toHaveBeenCalledTimes(1);
    expect(deps.notifyApprovers).toHaveBeenCalledTimes(1);
  });

  test('malformed decision fails the execution', async () => {
    const { deps } = makeDeps();
    const runner = runnerFor(deps);

    const execution = runner.run({ payload: input });
    const approval = runner.getOperation('wait-for-approval');
    await approval.waitForData(WaitingOperationStatus.SUBMITTED);
    await approval.sendCallbackSuccess(JSON.stringify({ approved: 'yes' }));
    const result = await execution;

    expect(result.getStatus()).toBe('FAILED');
    expect(deps.fulfill).not.toHaveBeenCalled();
  });
});

/**
 * The local runner (testing SDK 1.3.x) does not fire callback timeouts, so the EXPIRED
 * branch is exercised with a stub context. The SDK's waitForCallback passes
 * CallbackTimeoutError through unchanged, which is what the stub reproduces.
 */
describe('approval workflow timeout branch (stub context)', () => {
  test('no decision before the timeout: marks the request EXPIRED', async () => {
    const { deps, repository } = makeDeps();
    const context = {
      step: (_name: string, fn: () => Promise<unknown>) => fn(),
      waitForCallback: () => Promise.reject(new CallbackTimeoutError('Callback timed out')),
    } as unknown as DurableContext;

    const result = await createApprovalWorkflow(deps)(input, context);

    expect(result).toEqual({ requestId: 'req-001', status: 'EXPIRED' });
    expect(deps.fulfill).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenCalledWith('req-001', 'EXPIRED', expect.any(String));
  });
});
