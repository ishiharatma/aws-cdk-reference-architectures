import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getSession } from './lib/session-store';

const s3 = new S3Client({});
const BUCKET = process.env.WORKSPACE_BUCKET_NAME ?? '';
const URL_SECONDS = 900;

interface WorkspaceRequest {
  readonly sessionId?: string;
  readonly token?: string;
  readonly operation?: 'restore' | 'save';
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Invoked directly by the launcher inside a MicroVM, with the execution role. That role is shared by
 * all users and reachable from their terminals, so it holds no S3 access. Instead the per-session
 * token proves which session is asking, and the URL returned reaches only that session owner's object.
 * Direct invocation also works in a closed network, where the HTTP API cannot be reached.
 */
export async function handler(event: WorkspaceRequest): Promise<{ ok: boolean; url?: string | null; message?: string }> {
  const { sessionId, token, operation } = event;
  if (!sessionId || !token || (operation !== 'restore' && operation !== 'save')) {
    return { ok: false, message: 'sessionId, token and operation are required' };
  }

  const session = await getSession(sessionId);
  const expected = session?.workspaceTokenHash ? Buffer.from(session.workspaceTokenHash, 'hex') : undefined;
  if (!session || !expected || !timingSafeEqual(expected, sha256(token)) || session.state === 'TERMINATED') {
    return { ok: false, message: 'Session not found' };
  }

  const key = `workspaces/${session.ownerId}/workspace.tar.gz`;
  if (operation === 'save') {
    return { ok: true, url: await getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: URL_SECONDS }) };
  }

  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    if ((err as Error).name === 'NotFound') return { ok: true, url: null };
    throw err;
  }
  return { ok: true, url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: URL_SECONDS }) };
}
