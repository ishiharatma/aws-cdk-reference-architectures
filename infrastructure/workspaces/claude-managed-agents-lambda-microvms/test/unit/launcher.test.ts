/* eslint-disable @typescript-eslint/no-explicit-any */
import { Webhook } from 'standardwebhooks';

const sendSsm = jest.fn();
const sendDdb = jest.fn();
const sendMicrovms = jest.fn();

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: sendSsm })),
  GetParameterCommand: jest.fn((input) => ({ kind: 'GetParameter', input })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: sendDdb })),
  PutItemCommand: jest.fn((input) => ({ kind: 'PutItem', input })),
  DeleteItemCommand: jest.fn((input) => ({ kind: 'DeleteItem', input })),
}));
jest.mock('@aws-sdk/client-lambda-microvms', () => ({
  LambdaMicrovmsClient: jest.fn(() => ({ send: sendMicrovms })),
  RunMicrovmCommand: jest.fn((input) => ({ kind: 'RunMicrovm', input })),
}));

import { handler } from '../../src/launcher';

const SECRET = `whsec_${Buffer.from('unit-test-signing-secret-0123456789').toString('base64')}`;

const event = (type: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'event', id: 'evt_1', created_at: '2026-01-01T00:00:00Z', data: { type, id: 'sesn_1' }, ...over });

/** Builds an API Gateway proxy event signed the way Anthropic signs its deliveries. */
const signed = (body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) => {
  const id = 'msg_1';
  const signature = new Webhook(secret).sign(id, new Date(timestamp * 1000), body);
  return {
    body,
    headers: { 'Webhook-Id': id, 'Webhook-Timestamp': String(timestamp), 'Webhook-Signature': signature },
  };
};

beforeAll(() => {
  Object.assign(process.env, {
    AWS_REGION: 'ap-northeast-1',
    ANTHROPIC_ENVIRONMENT_ID: 'env_test',
    MICROVM_IMAGE_ARN: 'arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:worker',
    MICROVM_EXECUTION_ROLE_ARN: 'arn:aws:iam::123456789012:role/exec',
    MICROVM_LOG_GROUP: '/aws/lambda-microvms/test',
    ENVIRONMENT_KEY_PARAM_NAME: '/p/anthropic/environment-key',
    SIGNING_PARAM_NAME: '/p/anthropic/signing',
    IDEMPOTENCY_TABLE: 'idem',
    IDEMPOTENCY_TTL_SECONDS: '14400',
    INGRESS_CONNECTOR_ARN: 'arn:aws:lambda:ap-northeast-1:aws:network-connector:aws-network-connector:ALL_INGRESS',
    EGRESS_CONNECTOR_ARN: 'arn:aws:lambda:ap-northeast-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS',
    IDLE_POLICY: JSON.stringify({ maxIdleDurationSeconds: 600, suspendedDurationSeconds: 0, autoResumeEnabled: false }),
    MAX_LIFETIME_SECONDS: '14400',
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  sendSsm.mockResolvedValue({ Parameter: { Value: SECRET } });
  sendDdb.mockResolvedValue({});
  sendMicrovms.mockResolvedValue({ microvmId: 'mvm-123', endpoint: 'https://example.invalid' });
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('launcher', () => {
  test('rejects an unsigned delivery with 401 and starts nothing', async () => {
    const result = await handler({ body: event('session.status_run_started'), headers: {} });
    expect(result.statusCode).toBe(401);
    expect(sendMicrovms).not.toHaveBeenCalled();
    expect(sendDdb).not.toHaveBeenCalled();
  });

  test('rejects a delivery signed with another secret', async () => {
    const other = `whsec_${Buffer.from('another-secret-0123456789-abcdefgh').toString('base64')}`;
    const result = await handler(signed(event('session.status_run_started'), other));
    expect(result.statusCode).toBe(401);
    expect(sendMicrovms).not.toHaveBeenCalled();
  });

  test('rejects a stale timestamp', async () => {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const result = await handler(signed(event('session.status_run_started'), SECRET, tenMinutesAgo));
    expect(result.statusCode).toBe(401);
  });

  test('ignores other event types with 200', async () => {
    const result = await handler(signed(event('session.status_idle')));
    expect(result).toEqual({ statusCode: 200, body: 'ignored' });
    expect(sendMicrovms).not.toHaveBeenCalled();
  });

  test('launches one MicroVM for a started session', async () => {
    const result = await handler(signed(event('session.status_run_started')));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ microvmId: 'mvm-123', sessionId: 'sesn_1' });

    const run = sendMicrovms.mock.calls[0][0].input;
    expect(run).toMatchObject({
      imageIdentifier: process.env.MICROVM_IMAGE_ARN,
      executionRoleArn: process.env.MICROVM_EXECUTION_ROLE_ARN,
      ingressNetworkConnectors: [process.env.INGRESS_CONNECTOR_ARN],
      egressNetworkConnectors: [process.env.EGRESS_CONNECTOR_ARN],
      maximumDurationInSeconds: 14400,
      clientToken: 'evt_1',
      logging: { cloudWatch: { logGroup: '/aws/lambda-microvms/test' } },
    });
  });

  test('the run hook payload carries the parameter name, never a secret value', async () => {
    await handler(signed(event('session.status_run_started')));
    const payload = JSON.parse(sendMicrovms.mock.calls[0][0].input.runHookPayload);
    expect(payload).toEqual({
      version: '1',
      session: {
        ANTHROPIC_SESSION_ID: 'sesn_1',
        ANTHROPIC_ENVIRONMENT_ID: 'env_test',
        ENVIRONMENT_KEY_PARAM_NAME: '/p/anthropic/environment-key',
        AWS_REGION: 'ap-northeast-1',
      },
    });
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  test('a duplicate delivery answers 200 without launching again', async () => {
    sendDdb.mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }));
    const result = await handler(signed(event('session.status_run_started')));
    expect(result).toEqual({ statusCode: 200, body: 'duplicate' });
    expect(sendMicrovms).not.toHaveBeenCalled();
  });

  test('records the event ID with a TTL and a condition', async () => {
    await handler(signed(event('session.status_run_started')));
    const put = sendDdb.mock.calls[0][0].input;
    expect(put.TableName).toBe('idem');
    expect(put.ConditionExpression).toBe('attribute_not_exists(id)');
    expect(put.Item.id).toEqual({ S: 'evt_1' });
    expect(Number(put.Item.expiration.N)).toBeGreaterThan(Date.now() / 1000);
  });

  test('a failed RunMicrovm releases the record and answers 502 so Anthropic retries', async () => {
    sendMicrovms.mockRejectedValueOnce(Object.assign(new Error('quota'), { name: 'ServiceQuotaExceededException' }));
    const result = await handler(signed(event('session.status_run_started')));
    expect(result.statusCode).toBe(502);
    const kinds = sendDdb.mock.calls.map((c) => c[0].kind);
    expect(kinds).toEqual(['PutItem', 'DeleteItem']);
    expect(sendDdb.mock.calls[1][0].input.Key).toEqual({ id: { S: 'evt_1' } });
  });

  test('an event without a session ID is ignored with 200', async () => {
    const body = JSON.stringify({ type: 'event', id: 'evt_2', created_at: 'x', data: { type: 'session.status_run_started' } });
    const result = await handler(signed(body));
    expect(result.statusCode).toBe(200);
    expect(sendMicrovms).not.toHaveBeenCalled();
  });
});
