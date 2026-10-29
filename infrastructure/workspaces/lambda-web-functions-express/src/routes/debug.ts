import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Diagnostic routes used by `test-api.sh` to observe Web Functions behavior.
 * Mounted only when ENABLE_DEBUG_ROUTES=true (dev environment).
 *
 * The module-level values below are intentionally shared across concurrent
 * requests: they describe the *execution environment*, not a request. Never
 * keep per-request data at module level on Web Functions — one process serves
 * many requests at the same time.
 */
const environmentId = randomUUID();
const startedAt = new Date().toISOString();
let inFlight = 0;
let maxInFlight = 0;
let servedRequests = 0;

const MAX_SLEEP_MS = 10_000;
const MAX_CPU_MS = 2_000;

const clamp = (value: unknown, max: number, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
};

const snapshot = () => ({
  environmentId,
  startedAt,
  region: process.env.AWS_REGION,
  pid: process.pid,
  uptimeSeconds: Math.round(process.uptime()),
  inFlight,
  maxInFlight,
  servedRequests,
});

const router = Router();

// Track concurrency for every debug request.
router.use((_req: Request, res: Response, next) => {
  inFlight += 1;
  servedRequests += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  res.on('close', () => {
    inFlight -= 1;
  });
  next();
});

/** Execution environment identity and concurrency counters. */
router.get('/env', (_req: Request, res: Response) => {
  res.json(snapshot());
});

/** I/O-bound simulation: waits without using CPU (not billed as active CPU). */
router.get('/sleep', async (req: Request, res: Response) => {
  const ms = clamp(req.query.ms, MAX_SLEEP_MS, 1000);
  await new Promise((resolve) => setTimeout(resolve, ms));
  res.json({ sleptMs: ms, ...snapshot() });
});

/** CPU-bound simulation: busy loop that blocks the single Node.js event loop. */
router.get('/cpu', (req: Request, res: Response) => {
  const ms = clamp(req.query.ms, MAX_CPU_MS, 200);
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) {
    x += Math.sqrt(x + 1);
  }
  res.json({ burnedMs: ms, ...snapshot() });
});

/**
 * Server-Sent Events: chunks must reach the client incrementally.
 *
 * The stream ends with an explicit `event: done`. When the revision's timeoutSeconds
 * cuts a stream short, the client still sees HTTP 200 and a clean end of stream, so
 * the missing terminal event is the only way for it to tell truncation from completion.
 */
router.get('/stream', async (req: Request, res: Response) => {
  const count = clamp(req.query.count, 50, 10);
  const intervalMs = clamp(req.query.intervalMs, 2_000, 500);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  for (let i = 1; i <= count; i += 1) {
    if (res.writableEnded || res.destroyed) {
      return;
    }
    res.write(`id: ${i}\ndata: ${JSON.stringify({ seq: i, at: new Date().toISOString() })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  res.write(`event: done\ndata: ${JSON.stringify({ count })}\n\n`);
  res.end();
});

/**
 * Outbound internet check. With VPC egress (isolated subnets, no NAT) this must fail;
 * without it the revision has direct internet access.
 */
router.get('/egress', async (_req: Request, res: Response) => {
  const started = Date.now();
  try {
    const r = await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(3_000) });
    res.json({ internetReachable: true, status: r.status, ip: (await r.text()).trim(), ms: Date.now() - started });
  } catch (err) {
    res.json({ internetReachable: false, error: (err as Error).name, ms: Date.now() - started });
  }
});

/** Work that continues after the response has been sent. */
router.post('/background', (req: Request, res: Response) => {
  const delayMs = clamp(req.query.delayMs, MAX_SLEEP_MS, 3_000);
  const jobId = randomUUID();
  res.status(202).json({ jobId, delayMs, environmentId });
  setTimeout(() => {
    console.log('background job finished', { jobId, delayMs, environmentId });
  }, delayMs);
});

export default router;
