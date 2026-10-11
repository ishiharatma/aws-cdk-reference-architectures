import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';

/**
 * Probe for the Multi-AZ versus read replica comparison. One function, several actions:
 *
 *   info     what each endpoint is: pg_is_in_recovery() (a replica is), the node address, the server version
 *   write    try to write to each endpoint: the primary accepts, the replica refuses (read-only transaction)
 *   lag      write markers on the primary and time how long each takes to become visible on the replica
 *   watch    open a new connection to each endpoint every interval for a while and report every outage window
 *   heartbeat  write one row to the primary (run every minute by a schedule; see the README for why)
 *   diverge  after a promotion: write a marker on the primary and check that the promoted instance does not get it
 */
export interface ProbeEvent {
  action?: 'info' | 'write' | 'lag' | 'watch' | 'diverge' | 'heartbeat';
  samples?: number;
  durationSeconds?: number;
  intervalMs?: number;
  /** Marker written by `lag`; lets a later call look for it on the replica. */
  markerPrefix?: string;
}

const secrets = new SecretsManagerClient({});

const connect = async (host: string, password: string, timeoutMs = 5000): Promise<Client> => {
  const client = new Client({
    host,
    port: 5432,
    user: 'postgres',
    password,
    database: 'appdb',
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    // RDS enforces TLS. The probe measures behaviour, so the server certificate is not verified:
    // do not copy this into application code.
    ssl: { rejectUnauthorized: false },
  });
  client.on('error', () => undefined);
  await client.connect();
  return client;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Describes one endpoint. */
const describeEndpoint = async (host: string, password: string) => {
  const client = await connect(host, password);
  try {
    const res = await client.query("SELECT pg_is_in_recovery() AS in_recovery, inet_server_addr()::text AS ip, current_setting('server_version') AS version");
    return { inRecovery: res.rows[0].in_recovery as boolean, ip: res.rows[0].ip as string, version: res.rows[0].version as string };
  } finally {
    client.end().catch(() => undefined);
  }
};

/** Tries a write and returns what the endpoint said. */
const tryWrite = async (host: string, password: string): Promise<{ accepted: boolean; message: string }> => {
  const client = await connect(host, password);
  try {
    await client.query('CREATE TABLE IF NOT EXISTS probe_writes (id bigserial PRIMARY KEY, at timestamptz DEFAULT now(), note text)');
    await client.query("INSERT INTO probe_writes (note) VALUES ('write test')");
    return { accepted: true, message: 'INSERT accepted' };
  } catch (e) {
    return { accepted: false, message: (e as Error).message };
  } finally {
    client.end().catch(() => undefined);
  }
};

/** Writes `samples` markers on the primary and times each one until it can be read on the replica. */
const measureLag = async (primary: string, replica: string, password: string, samples: number, prefix: string) => {
  const writer = await connect(primary, password);
  const reader = await connect(replica, password);
  try {
    await writer.query('CREATE TABLE IF NOT EXISTS lag_markers (id text PRIMARY KEY, written_at timestamptz DEFAULT now())');
    // The table must exist on the replica before markers can be looked up.
    for (let i = 0; i < 100; i++) {
      const t = await reader.query("SELECT to_regclass('lag_markers') AS t");
      if (t.rows[0].t) break;
      await sleep(200);
    }
    const lagsMs: number[] = [];
    const missing: string[] = [];
    for (let i = 0; i < samples; i++) {
      const id = `${prefix}-${i}`;
      const started = Date.now();
      await writer.query('INSERT INTO lag_markers (id) VALUES ($1)', [id]);
      let seen = false;
      while (Date.now() - started < 30000) {
        const res = await reader.query('SELECT 1 FROM lag_markers WHERE id = $1', [id]);
        if (res.rowCount) { seen = true; break; }
        await sleep(10);
      }
      if (seen) lagsMs.push(Date.now() - started); else missing.push(id);
      await sleep(100);
    }
    const sorted = [...lagsMs].sort((a, b) => a - b);
    const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return {
      samples,
      visible: lagsMs.length,
      missing,
      minMs: sorted[0],
      medianMs: pick(0.5),
      p95Ms: pick(0.95),
      maxMs: sorted[sorted.length - 1],
    };
  } finally {
    writer.end().catch(() => undefined);
    reader.end().catch(() => undefined);
  }
};

/** Writes a marker on the primary, waits, and reports whether the other endpoint has it (a replica would; a promoted instance does not). */
const checkDivergence = async (primary: string, other: string, password: string, waitSeconds: number) => {
  const writer = await connect(primary, password);
  const reader = await connect(other, password);
  try {
    const id = `after-promotion-${Date.now()}`;
    await writer.query('CREATE TABLE IF NOT EXISTS lag_markers (id text PRIMARY KEY, written_at timestamptz DEFAULT now())');
    await writer.query('INSERT INTO lag_markers (id) VALUES ($1)', [id]);
    await sleep(waitSeconds * 1000);
    const res = await reader.query('SELECT 1 FROM lag_markers WHERE id = $1', [id]);
    const recovery = await reader.query('SELECT pg_is_in_recovery() AS r');
    return { marker: id, waitedSeconds: waitSeconds, visibleOnOtherEndpoint: (res.rowCount ?? 0) > 0, otherEndpointInRecovery: recovery.rows[0].r as boolean };
  } finally {
    writer.end().catch(() => undefined);
    reader.end().catch(() => undefined);
  }
};

interface Outage { start: string; end: string | null; seconds: number | null; error: string }
interface TargetState { name: string; host: string; up: boolean | null; outageStartMs: number | null; ips: string[]; lastIp: string | null; outages: Outage[]; ok: number; failed: number }

const watchTarget = async (state: TargetState, password: string, deadline: number, intervalMs: number, requireWritable: boolean) => {
  while (Date.now() < deadline) {
    const tick = Date.now();
    try {
      const d = await (async () => {
        const client = await connect(state.host, password, 1000);
        try {
          const r = await client.query('SELECT pg_is_in_recovery() AS ro, inet_server_addr()::text AS ip');
          return { ro: r.rows[0].ro as boolean, ip: r.rows[0].ip as string };
        } finally {
          client.end().catch(() => undefined);
        }
      })();
      if (requireWritable && d.ro) throw new Error('endpoint served a read-only node');
      state.ok++;
      if (state.up === false && state.outageStartMs !== null) {
        const o = state.outages[state.outages.length - 1];
        o.end = new Date(tick).toISOString();
        o.seconds = Math.round((tick - state.outageStartMs) / 100) / 10;
        state.outageStartMs = null;
      }
      state.up = true;
      if (d.ip !== state.lastIp) { state.lastIp = d.ip; if (!state.ips.includes(d.ip)) state.ips.push(d.ip); }
    } catch (e) {
      state.failed++;
      if (state.up !== false) {
        state.up = false;
        state.outageStartMs = tick;
        state.outages.push({ start: new Date(tick).toISOString(), end: null, seconds: null, error: (e as Error).message });
      }
    }
    const wait = tick + intervalMs - Date.now();
    if (wait > 0) await sleep(wait);
  }
};

export const handler = async (event: ProbeEvent = {}) => {
  const primary = process.env.PRIMARY_ENDPOINT;
  const replica = process.env.REPLICA_ENDPOINT;
  if (!primary || !replica) throw new Error('PRIMARY_ENDPOINT and REPLICA_ENDPOINT must be set');
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ARN }));
  const password = (JSON.parse(secret.SecretString ?? '{}') as { password: string }).password;

  switch (event.action ?? 'info') {
    case 'info':
      return { primary: await describeEndpoint(primary, password), replica: await describeEndpoint(replica, password) };
    case 'write':
      return { primary: await tryWrite(primary, password), replica: await tryWrite(replica, password) };
    case 'lag':
      return measureLag(primary, replica, password, event.samples ?? 20, event.markerPrefix ?? `m${Date.now()}`);
    case 'heartbeat': {
      // PostgreSQL replays WAL only when there is some. On an idle primary the RDS ReplicaLag metric (time since the last
      // replayed transaction) therefore keeps growing and reads as lag that is not there. One tiny write a minute fixes that.
      const client = await connect(primary, password);
      try {
        await client.query('CREATE TABLE IF NOT EXISTS heartbeat (id int PRIMARY KEY, at timestamptz NOT NULL)');
        await client.query('INSERT INTO heartbeat (id, at) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET at = now()');
        return { heartbeat: 'written' };
      } finally {
        client.end().catch(() => undefined);
      }
    }
    case 'diverge':
      return checkDivergence(primary, replica, password, event.samples ?? 15);
    case 'watch': {
      const duration = event.durationSeconds ?? 300;
      const interval = event.intervalMs ?? 1000;
      const mk = (name: string, host: string): TargetState => ({ name, host, up: null, outageStartMs: null, ips: [], lastIp: null, outages: [], ok: 0, failed: 0 });
      const states = [mk('primary', primary), mk('replica', replica)];
      const startedAt = new Date().toISOString();
      const deadline = Date.now() + duration * 1000;
      // The primary must serve a writable node; the replica is expected to be read-only.
      await Promise.all([watchTarget(states[0], password, deadline, interval, true), watchTarget(states[1], password, deadline, interval, false)]);
      return { startedAt, endedAt: new Date().toISOString(), durationSeconds: duration, targets: states.map((s) => ({ target: s.name, ok: s.ok, failed: s.failed, ipsSeen: s.ips, outages: s.outages })) };
    }
    default:
      throw new Error(`unknown action ${String(event.action)}`);
  }
};
