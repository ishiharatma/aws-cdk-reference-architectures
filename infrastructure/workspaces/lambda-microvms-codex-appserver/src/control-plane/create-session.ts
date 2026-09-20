import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { CreateMicrovmAuthTokenCommand, LambdaMicrovmsClient, RunMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { jsonResponse, getOwnerId } from './lib/http';
import { putSession } from './lib/session-store';

const microvmClient = new LambdaMicrovmsClient({});

const IMAGE_ARN = process.env.MICROVM_IMAGE_ARN ?? '';
const EXECUTION_ROLE_ARN = process.env.MICROVM_EXECUTION_ROLE_ARN ?? '';
const EGRESS_NETWORK_CONNECTORS = (process.env.EGRESS_NETWORK_CONNECTORS ?? '').split(',').filter(Boolean);
const APP_SERVER_PORT = Number(process.env.CODEX_APP_SERVER_PORT ?? '8080');
const MAX_SESSION_DURATION_MINUTES = Number(process.env.MAX_SESSION_DURATION_MINUTES ?? '60');
const IDLE_TIMEOUT_MINUTES = Number(process.env.IDLE_TIMEOUT_MINUTES ?? '5');
const SUSPENDED_DURATION_MINUTES = Number(process.env.SUSPENDED_DURATION_MINUTES ?? '480');
const AUTO_RESUME_ENABLED = process.env.AUTO_RESUME_ENABLED === 'true';
const AUTH_TOKEN_EXPIRATION_MINUTES = Number(process.env.AUTH_TOKEN_EXPIRATION_MINUTES ?? '15');
const SESSION_RECORD_TTL_DAYS = Number(process.env.SESSION_RECORD_TTL_DAYS ?? '1');

/**
 * POST /sessions
 *
 * Starts a new Codex App Server session: launches a MicroVM from the
 * pre-baked codex app-server image (RunMicrovm), issues a short-lived
 * auth token scoped to the in-VM server's port (CreateMicrovmAuthToken),
 * and records the session in DynamoDB.
 *
 * `runHookPayload` carries the session id as the POST body the platform
 * delivers to the image's /run hook, so the in-VM Event Handler
 * (src/microvm-image/server/event-handler.mjs) knows which DynamoDB
 * partition to persist codex app-server's output under.
 *
 * The client then connects *directly* to the returned MicroVM endpoint
 * (with the X-aws-proxy-auth header) to POST /rpc against the in-VM
 * server's JSON-RPC relay, rather than proxying traffic through this
 * control plane. To read a Turn's output, poll GET
 * /sessions/{sessionId}/events instead of the MicroVM directly -- that
 * keeps working after the MicroVM is SUSPENDED or terminated.
 */
export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const ownerId = getOwnerId(event);
  const sessionId = randomUUID();

  const runResult = await microvmClient.send(
    new RunMicrovmCommand({
      imageIdentifier: IMAGE_ARN,
      executionRoleArn: EXECUTION_ROLE_ARN || undefined,
      egressNetworkConnectors: EGRESS_NETWORK_CONNECTORS.length > 0 ? EGRESS_NETWORK_CONNECTORS : undefined,
      idlePolicy: {
        maxIdleDurationSeconds: IDLE_TIMEOUT_MINUTES * 60,
        suspendedDurationSeconds: SUSPENDED_DURATION_MINUTES * 60,
        autoResumeEnabled: AUTO_RESUME_ENABLED,
      },
      maximumDurationInSeconds: MAX_SESSION_DURATION_MINUTES * 60,
      clientToken: sessionId,
      runHookPayload: JSON.stringify({ sessionId }),
    }),
  );

  if (!runResult.microvmId || !runResult.endpoint) {
    return jsonResponse(502, { message: 'RunMicrovm did not return a microvmId/endpoint' });
  }

  const authTokenResult = await microvmClient.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: runResult.microvmId,
      expirationInMinutes: AUTH_TOKEN_EXPIRATION_MINUTES,
      allowedPorts: [{ port: APP_SERVER_PORT }],
    }),
  );

  const now = new Date();
  await putSession({
    sessionId,
    ownerId,
    microvmId: runResult.microvmId,
    imageArn: runResult.imageArn ?? IMAGE_ARN,
    endpoint: runResult.endpoint,
    state: runResult.state ?? 'PENDING',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + SESSION_RECORD_TTL_DAYS * 24 * 60 * 60,
  });

  return jsonResponse(201, {
    sessionId,
    state: runResult.state,
    endpoint: runResult.endpoint,
    authToken: authTokenResult.authToken,
  });
}
