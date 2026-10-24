/**
 * Webhook destinations, stored as JSON in Secrets Manager.
 *
 * The Data stack creates the secret with DEFAULT_WEBHOOK_SECRET; operators
 * replace the URLs by hand afterwards. CloudFormation only rewrites the value
 * when this default changes in the template, so a hand-edited secret survives
 * normal redeploys.
 */
export type WebhookType = 'slack' | 'teams';

export interface WebhookTarget {
  readonly type: WebhookType;
  readonly url: string;
}

export interface WebhookConfig {
  readonly webhooks: WebhookTarget[];
}

export const WEBHOOK_URL_PLACEHOLDER = 'REPLACE_WITH_WEBHOOK_URL';

export const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = {
  webhooks: [
    { type: 'slack', url: WEBHOOK_URL_PLACEHOLDER },
    { type: 'teams', url: WEBHOOK_URL_PLACEHOLDER },
  ],
};

export const DEFAULT_WEBHOOK_SECRET = JSON.stringify(DEFAULT_WEBHOOK_CONFIG);

/** Returns the URL when it is a usable https URL, otherwise undefined. */
export function usableWebhookUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || url === WEBHOOK_URL_PLACEHOLDER) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname !== '' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Splits the secret into targets that will be sent and the reasons the rest
 * are skipped. An unparsable secret, or one still equal to the default, sends
 * nothing.
 */
export function resolveWebhookTargets(secretString: string | undefined): {
  targets: WebhookTarget[];
  skipped: string[];
} {
  if (!secretString || secretString.trim() === DEFAULT_WEBHOOK_SECRET) {
    return { targets: [], skipped: ['secret still has the default value'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    return { targets: [], skipped: ['secret is not valid JSON'] };
  }
  const list = (parsed as Partial<WebhookConfig>)?.webhooks;
  if (!Array.isArray(list)) {
    return { targets: [], skipped: ['secret has no "webhooks" array'] };
  }

  const targets: WebhookTarget[] = [];
  const skipped: string[] = [];
  list.forEach((entry, i) => {
    const type = (entry as Partial<WebhookTarget>)?.type;
    if (type !== 'slack' && type !== 'teams') {
      skipped.push(`webhooks[${i}]: unsupported type`);
      return;
    }
    const url = usableWebhookUrl((entry as Partial<WebhookTarget>).url);
    if (!url) {
      skipped.push(`webhooks[${i}] (${type}): not an https URL`);
      return;
    }
    targets.push({ type, url });
  });
  return { targets, skipped };
}
