import { DynamoDBClient, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { LambdaMicrovmsClient, RunMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';

const SESSION_RUN_STARTED = 'session.status_run_started';
const SECRET_CACHE_MS = 5 * 60 * 1000;

const ssm = new SSMClient({});
const ddb = new DynamoDBClient({});
const microvms = new LambdaMicrovmsClient({});

interface ProxyEvent {
  body: string | null;
  headers: Record<string, string> | null;
  isBase64Encoded?: boolean;
}

interface ProxyResult {
  statusCode: number;
  body: string;
}

let cachedSigningSecret: { value: string; expiresAt: number } | undefined;

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};

const getSigningSecret = async (): Promise<string> => {
  if (cachedSigningSecret && cachedSigningSecret.expiresAt > Date.now()) return cachedSigningSecret.value;
  const result = await ssm.send(new GetParameterCommand({ Name: env('SIGNING_PARAM_NAME'), WithDecryption: true }));
  const value = result.Parameter?.Value;
  if (!value) throw new Error('Webhook signing secret parameter has no value');
  cachedSigningSecret = { value, expiresAt: Date.now() + SECRET_CACHE_MS };
  return value;
};

const verifier = new Anthropic({ apiKey: 'unused-for-webhook-verification' });

/** Verify the Standard Webhooks signature against the raw body. Throws when invalid or stale. */
const unwrap = async (rawBody: string, headers: Record<string, string>) =>
  verifier.beta.webhooks.unwrap(rawBody, { headers, key: await getSigningSecret() });

const lowerCaseKeys = (headers: Record<string, string> | null): Record<string, string> =>
  Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

/**
 * Webhook handler: one MicroVM per `session.status_run_started`.
 *
 * Only a reference (the SSM parameter name) to the environment key goes into the MicroVM; the key is
 * read by the MicroVM's own execution role. A non-2xx response makes Anthropic retry the delivery.
 */
export const handler = async (event: ProxyEvent): Promise<ProxyResult> => {
  const rawBody = event.body
    ? event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body
    : '';

  let webhook: { id?: string; data?: { type?: string; id?: string } };
  try {
    webhook = (await unwrap(rawBody, lowerCaseKeys(event.headers))) as unknown as typeof webhook;
  } catch (err) {
    console.warn(JSON.stringify({ message: 'webhook signature verification failed', error: String(err) }));
    return { statusCode: 401, body: 'signature verification failed' };
  }

  const eventId = webhook.id;
  const type = webhook.data?.type;
  const sessionId = webhook.data?.id;
  if (type !== SESSION_RUN_STARTED) {
    console.info(JSON.stringify({ message: 'ignoring event', type }));
    return { statusCode: 200, body: 'ignored' };
  }
  // A malformed event never becomes valid, so answer 200 to stop the retries.
  if (!eventId || !sessionId) {
    console.warn(JSON.stringify({ message: 'ignoring event without id or session id', eventId, sessionId }));
    return { statusCode: 200, body: 'ignored' };
  }

  // Exactly one MicroVM per webhook event id, also across concurrent and retried deliveries.
  const ttlSeconds = Number(env('IDEMPOTENCY_TTL_SECONDS'));
  try {
    await ddb.send(new PutItemCommand({
      TableName: env('IDEMPOTENCY_TABLE'),
      Item: {
        id: { S: eventId },
        sessionId: { S: sessionId },
        expiration: { N: String(Math.floor(Date.now() / 1000) + ttlSeconds) },
      },
      ConditionExpression: 'attribute_not_exists(id)',
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.info(JSON.stringify({ message: 'duplicate delivery', eventId, sessionId }));
      return { statusCode: 200, body: 'duplicate' };
    }
    throw err;
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const runHookPayload = JSON.stringify({
    version: '1',
    session: {
      ANTHROPIC_SESSION_ID: sessionId,
      ANTHROPIC_ENVIRONMENT_ID: env('ANTHROPIC_ENVIRONMENT_ID'),
      ENVIRONMENT_KEY_PARAM_NAME: env('ENVIRONMENT_KEY_PARAM_NAME'),
      AWS_REGION: env('AWS_REGION'),
      ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
    },
  });

  try {
    const launched = await microvms.send(new RunMicrovmCommand({
      imageIdentifier: env('MICROVM_IMAGE_ARN'),
      executionRoleArn: env('MICROVM_EXECUTION_ROLE_ARN'),
      ingressNetworkConnectors: [env('INGRESS_CONNECTOR_ARN')],
      egressNetworkConnectors: [env('EGRESS_CONNECTOR_ARN')],
      idlePolicy: JSON.parse(env('IDLE_POLICY')),
      maximumDurationInSeconds: Number(env('MAX_LIFETIME_SECONDS')),
      logging: { cloudWatch: { logGroup: env('MICROVM_LOG_GROUP') } },
      clientToken: eventId.slice(0, 64),
      runHookPayload,
    }));
    console.info(JSON.stringify({ message: 'launched microvm', microvmId: launched.microvmId, sessionId }));
    return { statusCode: 200, body: JSON.stringify({ microvmId: launched.microvmId, sessionId }) };
  } catch (err) {
    // Release the dedupe record so Anthropic's retry can launch the MicroVM.
    await ddb.send(new DeleteItemCommand({ TableName: env('IDEMPOTENCY_TABLE'), Key: { id: { S: eventId } } }));
    console.error(JSON.stringify({ message: 'RunMicrovm failed', sessionId, error: String(err), name: (err as { name?: string }).name }));
    return { statusCode: 502, body: JSON.stringify({ error: 'run_microvm_failed', sessionId }) };
  }
};
