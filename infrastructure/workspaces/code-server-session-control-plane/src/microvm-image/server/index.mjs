// Front server inside the MicroVM. It (a) answers the platform lifecycle hooks, (b) starts
// code-server from the /run hook, and (c) reverse-proxies everything else -- including the
// WebSocket upgrades VS Code needs -- to code-server on loopback.
//
// code-server runs with --auth none: the endpoint admits no request without a JWE token scoped to
// this MicroVM, and the control plane issues that token only to the session owner. There is no
// other path to this port, so a second, shared password would add no per-user control.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';

const PORT = Number(process.env.LAUNCHER_PORT ?? '8080');
const CODE_SERVER_PORT = Number(process.env.CODE_SERVER_PORT ?? '8081');
const HOOK_PREFIX = '/aws/lambda-microvms/runtime/v1';

const HOME = process.env.HOME ?? '/home/node';
const SAVE_INTERVAL_MS = 5 * 60 * 1000;
const WORKSPACE_ARCHIVE = '/tmp/workspace.tar.gz';
const SAVE_MARKER = `${HOME}/.workspace-saved`;
const SAVED_PATHS = ['project', '.local/share/code-server/User'];

let codeServer;
let codeServerReady = false;
let session;
let restored = false;
let saving = Promise.resolve();

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

async function readRunPayload(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')).runHookPayload);
  } catch (err) {
    console.error('[hook:run] no usable payload', err);
    return {};
  }
}

// Commit author: the owner's sign-in address, passed by the control plane per MicroVM.
function configureGitIdentity(gitEmail) {
  if (!gitEmail) return;
  execFileSync('git', ['config', '--global', 'user.email', gitEmail]);
  execFileSync('git', ['config', '--global', 'user.name', gitEmail.split('@')[0]]);
}

const run = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 45_000, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

// The execution role holds no S3 access: a function checks this session's token and returns a URL
// that reaches only the owner's archive. See src/control-plane/workspace-url.ts.
async function workspaceUrl(operation) {
  const out = '/tmp/workspace-url.json';
  await run('aws', ['lambda', 'invoke', '--function-name', process.env.WORKSPACE_FUNCTION_NAME, '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify({ sessionId: session.sessionId, token: session.workspaceToken, operation }), out]);
  const result = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(out);
  if (!result.ok) throw new Error(result.message ?? 'workspace URL refused');
  return result.url;
}

// A failed restore must not lead to an empty workspace replacing the saved one, so saving stays off.
async function restoreWorkspace() {
  mkdirSync(`${HOME}/${SAVED_PATHS[1]}`, { recursive: true });
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      // The control plane records the session right after RunMicrovm returns, which can be after this.
      const url = await workspaceUrl('restore');
      if (url) {
        await run('curl', ['-fsS', '-o', WORKSPACE_ARCHIVE, url]);
        await run('tar', ['-xzf', WORKSPACE_ARCHIVE, '-C', HOME]);
        rmSync(WORKSPACE_ARCHIVE);
      }
      restored = true;
      writeFileSync(SAVE_MARKER, '');
      console.log(`[workspace] ${url ? 'restored' : 'nothing saved yet'}`);
      return;
    } catch (err) {
      console.error(`[workspace] restore attempt ${attempt} failed`, String(err).slice(0, 300));
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  writeFileSync(`${HOME}/project/WORKSPACE_NOT_RESTORED.txt`, 'The saved workspace could not be restored, and saving is off for this session. End it and start a new one.\n');
}

async function saveWorkspace() {
  if (!restored) return;
  const changed = await run('find', [...SAVED_PATHS.map((p) => `${HOME}/${p}`), '-newer', SAVE_MARKER, '-print', '-quit']);
  if (!changed.trim()) return;
  const started = new Date();
  await run('tar', ['-czf', WORKSPACE_ARCHIVE, '-C', HOME, '--exclude=node_modules', '--exclude=.venv', '--exclude=__pycache__', '--exclude=workspaceStorage', '--exclude=History', ...SAVED_PATHS]);
  await run('curl', ['-fsS', '-T', WORKSPACE_ARCHIVE, await workspaceUrl('save')]);
  rmSync(WORKSPACE_ARCHIVE);
  // Changes made while saving stay newer than the marker and go into the next save.
  utimesSync(SAVE_MARKER, started, started);
  console.log('[workspace] saved');
}

// One at a time; a failure is logged and the next attempt starts from the same marker.
function queueSave() {
  saving = saving.then(saveWorkspace).catch((err) => console.error('[workspace] save failed', String(err).slice(0, 300)));
  return saving;
}

// Points npm and pip at the read-only mirror. Off the request path because it takes a few seconds, and
// non-fatal because the editor is still useful without it.
function configurePackageMirror() {
  if (!process.env.PACKAGE_DOMAIN) return;
  for (const tool of ['npm', 'pip']) {
    run('aws', ['codeartifact', 'login', '--tool', tool, '--domain', process.env.PACKAGE_DOMAIN, '--repository', process.env.PACKAGE_REPOSITORY])
      .then(() => console.log(`[packages] ${tool} configured`))
      .catch((err) => console.error(`[packages] ${tool} not configured`, String(err).slice(0, 300)));
  }
}

async function startCodeServer() {
  if (codeServer) return;
  // AWS_REGION is a reserved image env var name, so the stack passes the Region under another name.
  process.env.AWS_REGION ??= process.env.SESSION_REGION;

  // Claude Code settings.json mirrors the Bedrock env vars so the CLI and the VS Code extension agree.
  if (process.env.CLAUDE_CODE_USE_BEDROCK) {
    const keys = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'AWS_REGION', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'];
    const env = Object.fromEntries(keys.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
    mkdirSync('/home/node/.claude', { recursive: true });
    writeFileSync('/home/node/.claude/settings.json', JSON.stringify({ env }, null, 2));
  }

  codeServer = spawn(
    '/opt/code-server/bin/code-server',
    [
      '--bind-addr', `127.0.0.1:${CODE_SERVER_PORT}`, '--auth', 'none', '--disable-telemetry', '--disable-update-check',
      ...(process.env.BLOCK_FILE_TRANSFER === '1' ? ['--disable-file-downloads', '--disable-file-uploads'] : []),
      '/home/node/project',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  codeServer.on('exit', (code, signal) => {
    console.error(`[code-server] exited code=${code} signal=${signal}`);
    codeServer = undefined;
    codeServerReady = false;
  });

  // A MicroVM pages the image in on first use, so a first start can take far longer than a warm one.
  // 45 seconds: restoring the workspace shares the /run hook's 60-second limit.
  for (let i = 0; i < 225; i++) {
    if (await probeCodeServer()) { codeServerReady = true; bedrockSmokeCheck(); return; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('code-server did not start listening in time');
}

// Off by default because it spends tokens at every start. Non-blocking: logs whether Claude Code
// can reach Bedrock with this MicroVM's execution role.
function bedrockSmokeCheck() {
  if (process.env.BEDROCK_SMOKE_CHECK !== '1') return;
  execFile('claude', ['-p', 'Reply with exactly: BEDROCK_OK'], { cwd: '/home/node/project', timeout: 90_000 }, (err, stdout, stderr) => {
    console.log(`[bedrock-check] ${err ? `FAILED: ${String(stderr || err).slice(0, 300)}` : stdout.trim()}`);
  });
}

// Lambda samples what this hook touches and prefetches it at run time. Running the programs a session
// starts with here means /run does not page them in over the network one by one.
async function warmUp() {
  await run('aws', ['--version']);
  const warm = spawn('/opt/code-server/bin/code-server', ['--bind-addr', `127.0.0.1:${CODE_SERVER_PORT}`, '--auth', 'none', '--disable-telemetry', '--disable-update-check'], { stdio: 'ignore' });
  for (let i = 0; i < 200 && !(await probeCodeServer()); i++) await new Promise((r) => setTimeout(r, 200));
  warm.kill('SIGTERM');
  await new Promise((r) => warm.once('exit', r));
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname.startsWith(`${HOOK_PREFIX}/`)) {
    const hook = pathname.slice(HOOK_PREFIX.length + 1);
    try {
      if (hook === 'run') {
        const { gitEmail, sessionId, workspaceToken } = await readRunPayload(req);
        configureGitIdentity(gitEmail);
        // Before code-server, so the editor opens the restored files and traffic waits for them.
        process.env.AWS_REGION ??= process.env.SESSION_REGION;
        if (sessionId && workspaceToken) {
          session = { sessionId, workspaceToken };
          await restoreWorkspace();
          setInterval(queueSave, SAVE_INTERVAL_MS);
        }
        await startCodeServer();
        // After code-server: on one vCPU, running these alongside its start made it miss the wait above.
        configurePackageMirror();
      } else if (hook === 'validate') {
        await warmUp();
      } else if (hook === 'suspend') {
        await queueSave();
      } else if (hook === 'terminate') {
        await queueSave();
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
