import { lookup } from 'node:dns/promises';

/** Request sent by test-gateway.sh: a gateway URL and optional extra headers. */
export interface ProbeEvent {
  url: string;
  headers?: Record<string, string>;
  count?: number;
}

/** One HTTP result as seen from inside the VPC. */
export interface ProbeResult {
  status: number;
  body: string;
}

/**
 * Calls a gateway hostname from inside the VPC.
 *
 * An internal gateway's `*.ecs.<region>.on.aws` hostname resolves to private IPs, so it can only be
 * verified from a network that reaches the internal ALB. Returns the resolved addresses and the responses.
 */
export const handler = async (event: ProbeEvent): Promise<{ addresses: string[]; results: ProbeResult[] }> => {
  const { hostname } = new URL(event.url);
  const addresses = (await lookup(hostname, { all: true })).map((a) => a.address);

  const results: ProbeResult[] = [];
  for (let i = 0; i < Math.min(event.count ?? 1, 50); i++) {
    try {
      const response = await fetch(event.url, { headers: event.headers, signal: AbortSignal.timeout(5000) });
      results.push({ status: response.status, body: (await response.text()).trim() });
    } catch (error) {
      results.push({ status: 0, body: String(error) });
    }
  }
  return { addresses, results };
};
