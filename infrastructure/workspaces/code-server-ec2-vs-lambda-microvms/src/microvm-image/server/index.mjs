// Front server inside the MicroVM. It (a) answers the platform lifecycle hooks, (b) starts
// code-server from the /run hook, and (c) reverse-proxies everything else -- including the
// WebSocket upgrades VS Code needs -- to code-server on loopback.
import { execFile, spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const PORT = Number(process.env.LAUNCHER_PORT ?? '8080');
const CODE_SERVER_PORT = Number(process.env.CODE_SERVER_PORT ?? '8081');
const HOOK_PREFIX = '/aws/lambda-microvms/runtime/v1';

let codeServer;
let codeServerReady = false;

function sendJson(res, status, body = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function probeCodeServer() {
  return new Promise((resolve) => {
    const socket = net.connect(CODE_SERVER_PORT, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function startCodeServer() {
  if (codeServer) return;
  const secretArn = process.env.PASSWORD_SECRET_ARN;
  if (!secretArn) throw new Error('PASSWORD_SECRET_ARN is not set');
  const { SecretString } = await new SecretsManagerClient({ region: secretArn.split(':')[3] }).send(new GetSecretValueCommand({ SecretId: secretArn }));

  // Claude Code settings.json mirrors the Bedrock env vars so the CLI and the VS Code extension agree.
  if (process.env.CLAUDE_CODE_USE_BEDROCK) {
    // AWS_REGION is a reserved image env var name, so fall back to the Region in the secret ARN.
    process.env.AWS_REGION ??= secretArn.split(':')[3];
    const keys = ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'];
    const env = Object.fromEntries(keys.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
    mkdirSync('/home/node/.claude', { recursive: true });
    writeFileSync('/home/node/.claude/settings.json', JSON.stringify({ env }, null, 2));
  }

  codeServer = spawn(
    '/opt/code-server/bin/code-server',
    ['--bind-addr', `127.0.0.1:${CODE_SERVER_PORT}`, '--auth', 'password', '--disable-telemetry', '--disable-update-check', '/home/node/project'],
    { env: { ...process.env, PASSWORD: SecretString }, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  codeServer.on('exit', (code, signal) => {
    console.error(`[code-server] exited code=${code} signal=${signal}`);
    codeServer = undefined;
    codeServerReady = false;
  });

  for (let i = 0; i < 100; i++) {
    if (await probeCodeServer()) { codeServerReady = true; bedrockSmokeCheck(); return; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('code-server did not start listening in time');
}

// Non-blocking: logs whether Claude Code can reach Bedrock with this MicroVM's execution role.
function bedrockSmokeCheck() {
  if (!process.env.CLAUDE_CODE_USE_BEDROCK) return;
  execFile('claude', ['-p', 'Reply with exactly: BEDROCK_OK'], { cwd: '/home/node/project', timeout: 90_000 }, (err, stdout, stderr) => {
    console.log(`[bedrock-check] ${err ? `FAILED: ${String(stderr || err).slice(0, 300)}` : stdout.trim()}`);
  });
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname.startsWith(`${HOOK_PREFIX}/`)) {
    const hook = pathname.slice(HOOK_PREFIX.length + 1);
    try {
      if (hook === 'run') {
        await startCodeServer();
      } else if (hook === 'terminate') {
        codeServer?.kill('SIGTERM');
      }
      return sendJson(res, 200);
    } catch (err) {
      console.error(`[hook:${hook}] failed`, err);
      return sendJson(res, 500, { error: String(err) });
    }
  }

  if (!codeServerReady) return sendJson(res, 503, { error: 'code-server is not running' });
  const upstream = httpRequest(
    { host: '127.0.0.1', port: CODE_SERVER_PORT, method: req.method, path: req.url, headers: req.headers },
    (upRes) => { res.writeHead(upRes.statusCode ?? 502, upRes.headers); upRes.pipe(res); },
  );
  upstream.on('error', () => sendJson(res, 502, { error: 'bad gateway' }));
  req.pipe(upstream);
});

// WebSocket (and any other Upgrade) traffic: replay the handshake to code-server and pipe raw bytes.
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(CODE_SERVER_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, () => console.log(`[launcher] listening on :${PORT}`));
