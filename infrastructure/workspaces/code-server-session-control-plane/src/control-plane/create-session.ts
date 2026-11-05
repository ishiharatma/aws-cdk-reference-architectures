import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isEc2Enabled, readState, startCompute } from './lib/compute';
import { audit, getOwnerEmail, getOwnerId, jsonResponse, parseBody } from './lib/http';
import { listOwnedSessions, putSession, updateSessionState } from './lib/session-store';
import { isUserEnabled } from './lib/user-status';

const MAX_ACTIVE_SESSIONS = Number(process.env.MAX_ACTIVE_SESSIONS_PER_OWNER ?? '2');
const SESSION_RECORD_TTL_DAYS = Number(process.env.SESSION_RECORD_TTL_DAYS ?? '1');

/**
 * POST /sessions  body: { "compute": "microvm" | "ec2" }
 *
 * Starts one code-server for the caller. Any signed-in user can start compute that costs money, so
 * the per-user limit is checked against live state rather than possibly stale records.
 */
export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const ownerId = getOwnerId(event);
  const { compute = 'microvm' } = parseBody(event);
  if (compute !== 'microvm' && compute !== 'ec2') {
    return jsonResponse(400, { message: 'compute must be "microvm" or "ec2"' });
  }
  if (compute === 'ec2' && !isEc2Enabled()) {
    return jsonResponse(400, { message: 'EC2 compute is not deployed in this environment' });
  }

  if (!(await isUserEnabled(event))) return jsonResponse(403, { message: 'This user is disabled' });

  const existing = await listOwnedSessions(ownerId);
  const candidates = existing.filter((s) => s.state !== 'TERMINATED');
  const live = await Promise.all(candidates.map(async (s) => {
    const state = await readState(s);
    if (state !== s.state) await updateSessionState(s.sessionId, state);
    return state;
  }));
  if (live.filter((state) => state !== 'TERMINATED' && state !== 'TERMINATING').length >= MAX_ACTIVE_SESSIONS) {
    return jsonResponse(409, { message: `Limit of ${MAX_ACTIVE_SESSIONS} active sessions reached. End one first.` });
  }

  const sessionId = randomUUID();
  const now = new Date();
  const expiresAt = Math.floor(now.getTime() / 1000) + SESSION_RECORD_TTL_DAYS * 24 * 60 * 60;
  const workspaceToken = randomBytes(32).toString('hex');
  const started = await startCompute(compute, sessionId, ownerId, expiresAt, getOwnerEmail(event), workspaceToken);

  await putSession({
    sessionId,
    ownerId,
    compute,
    resourceId: started.resourceId,
    ...(started.endpoint ? { endpoint: started.endpoint } : {}),
    workspaceTokenHash: createHash('sha256').update(workspaceToken).digest('hex'),
    state: started.state,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt,
  });

  audit('session.create', event, { sessionId, compute, resourceId: started.resourceId });
  return jsonResponse(201, { sessionId, compute, state: started.state });
}
