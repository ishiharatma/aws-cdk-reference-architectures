import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { requireEnv } from '../common/env';
import { WebhookTarget, resolveWebhookTargets } from '../common/webhook-config';
import { ReportSummary, slackPayload, teamsPayload } from './payload';

const secrets = new SecretsManagerClient({});

export interface NotifyOutput {
  readonly sent: number;
  readonly failed: number;
  readonly skipped: string[];
}

async function post(target: WebhookTarget, summary: ReportSummary): Promise<void> {
  const body = target.type === 'slack' ? slackPayload(summary) : teamsPayload(summary);
  const res = await fetch(target.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
}

/**
 * Sends the report summary to every usable webhook in the secret. Nothing is
 * sent while the secret still holds the deploy-time default, and entries
 * whose url is not an https URL are skipped. URLs are never logged: the
 * webhook URL is the credential.
 */
export const handler = async (event: ReportSummary): Promise<NotifyOutput> => {
  const secret = await secrets.send(
    new GetSecretValueCommand({ SecretId: requireEnv('WEBHOOK_SECRET_ARN') })
  );
  const { targets, skipped } = resolveWebhookTargets(secret.SecretString);
  if (skipped.length > 0) {
    console.warn(JSON.stringify({ skipped }));
  }

  let sent = 0;
  let failed = 0;
  for (const [i, target] of targets.entries()) {
    try {
      await post(target, event);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(`webhook #${i} (${target.type}) failed: ${(error as Error).message}`);
    }
  }
  const output = { sent, failed, skipped };
  console.log(JSON.stringify(output));
  // A failed webhook fails the execution so it is visible; the report is
  // already in S3, so a re-run with force is not needed to recover it.
  if (failed > 0) {
    throw new Error(`${failed} webhook(s) failed`);
  }
  return output;
};
