import { Client } from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * DB failover probe.
 *
 * Opens a brand-new connection to each target endpoint every `intervalMs` (no pooling, so
 * every probe pays the full DNS + TCP + TLS + auth path — exactly what an application
 * without a connection pool experiences) and runs `SELECT pg_is_in_recovery(), inet_server_addr()`.
 *
 *   - pg_is_in_recovery() = false  -> the endpoint is serving a writable primary
 *   - inet_server_addr() change    -> the endpoint now resolves to a different node (failover happened)
 *
 * Each probe emits a CloudWatch EMF metric (ProbeFailure 0/1 per target) that the FIS stop
 * condition alarms are built on. The handler returns a summary of every outage window.
 */

interface ProbeEvent {
    durationSeconds?: number;
    intervalMs?: number;
}

interface Outage {
    start: string;
    end: string | null;
    seconds: number | null;
    error: string;
}

interface TargetState {
    name: string;
    host: string;
    up: boolean | null;
    outageStartMs: number | null;
    lastIp: string | null;
    ips: string[];
    outages: Outage[];
    okCount: number;
    failCount: number;
    ipChanges: { at: string; from: string | null; to: string }[];
}

const secrets = new SecretsManagerClient({});

async function probeOnce(
    host: string,
    password: string,
    timeoutMs: number,
): Promise<{ ip: string; readOnly: boolean }> {
    const client = new Client({
        host,
        port: 5432,
        user: 'postgres',
        password,
        database: 'appdb',
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
        // RDS enforces TLS (rds.force_ssl). The probe only measures reachability, so the server
        // certificate is not verified — do not copy this into application code.
        ssl: { rejectUnauthorized: false },
    });
    // A dropped idle connection emits 'error' on the client; swallow it so it cannot crash the loop.
    client.on('error', () => undefined);
    try {
        await client.connect();
        const res = await client.query(
            'SELECT pg_is_in_recovery() AS ro, inet_server_addr()::text AS ip',
        );
        return { ip: res.rows[0].ip as string, readOnly: res.rows[0].ro as boolean };
    } finally {
        client.end().catch(() => undefined);
    }
}

function emitMetric(target: string, failure: 0 | 1): void {
    console.log(
        JSON.stringify({
            _aws: {
                Timestamp: Date.now(),
                CloudWatchMetrics: [
                    {
                        Namespace: 'FisRdsProbe',
                        Dimensions: [['Target']],
                        Metrics: [{ Name: 'ProbeFailure', Unit: 'Count' }],
                    },
                ],
            },
            Target: target,
            ProbeFailure: failure,
        }),
    );
}

async function runTarget(
    state: TargetState,
    password: string,
    deadlineMs: number,
    intervalMs: number,
): Promise<void> {
    while (Date.now() < deadlineMs) {
        const tickStart = Date.now();
        try {
            const { ip, readOnly } = await probeOnce(state.host, password, 1000);
            if (readOnly) {
                throw new Error('endpoint served a read-only node (pg_is_in_recovery=true)');
            }
            state.okCount++;
            emitMetric(state.name, 0);
            if (state.up === false && state.outageStartMs !== null) {
                const o = state.outages[state.outages.length - 1];
                o.end = new Date(tickStart).toISOString();
                o.seconds = Math.round((tickStart - state.outageStartMs) / 100) / 10;
                state.outageStartMs = null;
            }
            state.up = true;
            if (ip !== state.lastIp) {
                state.ipChanges.push({
                    at: new Date(tickStart).toISOString(),
                    from: state.lastIp,
                    to: ip,
                });
                state.lastIp = ip;
                if (!state.ips.includes(ip)) state.ips.push(ip);
            }
        } catch (e) {
            state.failCount++;
            emitMetric(state.name, 1);
            if (state.up !== false) {
                state.up = false;
                state.outageStartMs = tickStart;
                state.outages.push({
                    start: new Date(tickStart).toISOString(),
                    end: null,
                    seconds: null,
                    error: (e as Error).message,
                });
            }
        }
        const wait = tickStart + intervalMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
}

export const handler = async (event: ProbeEvent = {}) => {
    const durationSeconds = event.durationSeconds ?? 420;
    const intervalMs = event.intervalMs ?? 1000;

    const secret = await secrets.send(
        new GetSecretValueCommand({ SecretId: process.env.SECRET_ARN! }),
    );
    const password = (JSON.parse(secret.SecretString!) as { password: string }).password;

    const mk = (name: string, host: string): TargetState => ({
        name,
        host,
        up: null,
        outageStartMs: null,
        lastIp: null,
        ips: [],
        outages: [],
        okCount: 0,
        failCount: 0,
        ipChanges: [],
    });
    const states = [
        mk('instance', process.env.INSTANCE_ENDPOINT!),
        mk('cluster', process.env.CLUSTER_ENDPOINT!),
    ];

    const startedAt = new Date().toISOString();
    const deadline = Date.now() + durationSeconds * 1000;
    await Promise.all(states.map((s) => runTarget(s, password, deadline, intervalMs)));

    return {
        startedAt,
        endedAt: new Date().toISOString(),
        durationSeconds,
        targets: states.map((s) => ({
            target: s.name,
            host: s.host,
            ok: s.okCount,
            failed: s.failCount,
            ipsSeen: s.ips,
            ipChanges: s.ipChanges,
            outages: s.outages,
        })),
    };
};
