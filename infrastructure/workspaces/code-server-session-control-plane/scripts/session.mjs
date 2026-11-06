#!/usr/bin/env node
// Client for the code-server session control plane. It needs a Cognito user, not AWS credentials.
//
//   export CS_API_URL=<ApiUrl output> CS_CLIENT_ID=<UserPoolClientId output>
//   export CS_USERNAME=you@example.com CS_PASSWORD='...'
//   export CS_MFA_CODE=123456      # when MFA is required and no terminal can ask for it
//   node session.mjs start [--compute microvm|ec2]
//   node session.mjs connect [--port 8443]    # microvm: local relay; ec2: Session Manager port forward
//   node session.mjs status | list | suspend | resume | stop
//
// The latest session ID is kept in scripts/.session.json; --session overrides it.
import { spawn } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const STATE_FILE = fileURLToPath(new URL('.session.json', import.meta.url));
const AUTH_FILE = join(homedir(), '.code-server-sessions-auth.json');
const REFRESH_MARGIN_MINUTES = 5;

const command = process.argv[2];
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const apiUrl = () => requireEnv('CS_API_URL').replace(/\/$/, '');
const region = () => new URL(apiUrl()).hostname.split('.')[2];

async function cognito(target, body) {
  const res = await fetch(`https://cognito-idp.${region()}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sign-in failed: ${data.message ?? res.status}`);
  return data;
}

async function askMfaCode() {
  if (process.env.CS_MFA_CODE) return process.env.CS_MFA_CODE;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const code = await prompt.question('Authenticator code: ');
  prompt.close();
  return code.trim();
}

async function signInWithPassword() {
  const username = requireEnv('CS_USERNAME');
  const clientId = requireEnv('CS_CLIENT_ID');
  const first = await cognito('InitiateAuth', { AuthFlow: 'USER_PASSWORD_AUTH', ClientId: clientId, AuthParameters: { USERNAME: username, PASSWORD: requireEnv('CS_PASSWORD') } });
  if (first.AuthenticationResult) return first.AuthenticationResult;
  if (first.ChallengeName === 'MFA_SETUP') throw new Error('Enroll an authenticator app at the portal first');
  if (first.ChallengeName !== 'SOFTWARE_TOKEN_MFA') throw new Error(`Unsupported sign-in step: ${first.ChallengeName}`);
  const second = await cognito('RespondToAuthChallenge', {
    ChallengeName: 'SOFTWARE_TOKEN_MFA',
    ClientId: clientId,
    Session: first.Session,
    ChallengeResponses: { USERNAME: username, SOFTWARE_TOKEN_MFA_CODE: await askMfaCode() },
  });
  return second.AuthenticationResult;
}

// The refresh token is kept in the home directory, readable only by this user and outside the repository, so a working day needs one MFA code
// and a long-running relay can renew by itself. Renewal fails once the user is revoked.
let auth;
function loadAuth() {
  if (auth) return auth;
  try {
    const saved = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
    if (saved.username === process.env.CS_USERNAME) auth = saved;
  } catch { /* first use */ }
  return auth;
}
async function signIn() {
  const current = loadAuth();
  if (current?.idToken && current.expiresAt > Date.now() + 60_000) return current.idToken;
  let result;
  if (current?.refreshToken) {
    result = await cognito('InitiateAuth', { AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: requireEnv('CS_CLIENT_ID'), AuthParameters: { REFRESH_TOKEN: current.refreshToken } })
      .then((d) => d.AuthenticationResult)
      .catch(() => undefined);
  }
  result ??= await signInWithPassword();
  auth = {
    username: process.env.CS_USERNAME,
    idToken: result.IdToken,
    refreshToken: result.RefreshToken ?? current?.refreshToken,
    expiresAt: Date.now() + result.ExpiresIn * 1000,
  };
  writeFileSync(AUTH_FILE, JSON.stringify(auth), { mode: 0o600 });
  chmodSync(AUTH_FILE, 0o600);
  return auth.idToken;
}

async function api(method, path, body) {
  const res = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: { authorization: `Bearer ${await signIn()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(`${res.status}: ${data.message ?? JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function sessionId() {
  const explicit = arg('session');
  if (explicit) return explicit;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')).sessionId;
  } catch {
    throw new Error('No session. Run start first, or pass --session');
  }
}

async function waitForRunning(id) {
  const started = Date.now();
  for (;;) {
    const session = await api('GET', `/sessions/${id}`);
    if (session.state === 'RUNNING' || session.state === 'SUSPENDED') return session;
    if (session.state.startsWith('TERMINAT')) throw new Error(`The session is ${session.state}`);
    if (Date.now() - started > 300_000) throw new Error('The session did not start in time');
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// Browsers cannot attach X-aws-proxy-auth, so this listens on loopback and adds it. X-Forwarded-Host
// lets code-server's Origin check compare against the address the browser actually uses.
async function relay(id, port) {
  let access = await api('POST', `/sessions/${id}/access`, { type: 'relay' });
  const refresh = async () => {
    try {
      access = await api('POST', `/sessions/${id}/access`, { type: 'relay' });
    } catch (err) {
      console.error(`Token refresh failed: ${err.message}`);
    }
  };
  setInterval(refresh, (access.expiresInMinutes - REFRESH_MARGIN_MINUTES) * 60_000).unref();

  const outgoing = (headers) => ({
    ...headers,
    host: access.endpoint,
    'x-forwarded-host': headers.host,
    'x-aws-proxy-auth': access.token,
  });

  const server = http.createServer((req, res) => {
    const upstream = https.request({ host: access.endpoint, method: req.method, path: req.url, headers: outgoing(req.headers) }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (err) => { res.writeHead(502); res.end(String(err)); });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    const upstream = tls.connect({ host: access.endpoint, port: 443, servername: access.endpoint, ALPNProtocols: ['http/1.1'] }, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(outgoing(req.headers)).map(([k, v]) => `${k}: ${v}`)];
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  server.listen(port, '127.0.0.1', () => console.log(`Open http://localhost:${port}  (Ctrl+C to stop the relay)`));
}

// The control plane opens the session; session-manager-plugin only needs its stream token.
async function tunnel(id, port) {
  const started = Date.now();
  let access;
  while (!access) {
    try {
      access = await api('POST', `/sessions/${id}/access`, { type: 'tunnel', localPort: port });
    } catch (err) {
      if (err.status !== 409 || Date.now() - started > 600_000) throw err;
      console.log('Waiting for the instance to connect to Session Manager...');
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  console.log(`Open http://localhost:${port} once the port is listening (first boot installs code-server)`);
  const child = spawn(
    'session-manager-plugin',
    [
      JSON.stringify(access.ssmSession),
      region(),
      'StartSession',
      '',
      JSON.stringify({ Target: access.target, DocumentName: access.documentName, Parameters: access.parameters }),
      `https://ssm.${region()}.amazonaws.com`,
    ],
    { stdio: 'inherit' },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
  // The plugin would otherwise outlive this process and keep the port open.
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}

const commands = {
  async start() {
    const compute = arg('compute', 'microvm');
    const session = await api('POST', '/sessions', { compute });
    writeFileSync(STATE_FILE, JSON.stringify({ sessionId: session.sessionId, compute }), { mode: 0o600 });
    console.log(JSON.stringify(session));
    const started = Date.now();
    await waitForRunning(session.sessionId);
    console.log(`RUNNING after ${Math.round((Date.now() - started) / 1000)} seconds. Run: node session.mjs connect`);
  },
  async connect() {
    const id = sessionId();
    const port = Number(arg('port', '8443'));
    const session = await waitForRunning(id);
    if (session.compute === 'ec2') await tunnel(id, port);
    else await relay(id, port);
  },
  async status() { console.log(JSON.stringify(await api('GET', `/sessions/${sessionId()}`))); },
  async list() { console.log(JSON.stringify(await api('GET', '/sessions'), null, 2)); },
  async suspend() { console.log(JSON.stringify(await api('POST', `/sessions/${sessionId()}/suspend`))); },
  async resume() { console.log(JSON.stringify(await api('POST', `/sessions/${sessionId()}/resume`))); },
  async stop() { console.log(JSON.stringify(await api('DELETE', `/sessions/${sessionId()}`))); },
};

if (!commands[command]) {
  console.error('Usage: session.mjs start|connect|status|list|suspend|resume|stop [--compute microvm|ec2] [--session id] [--port 8443]');
  process.exit(2);
}
commands[command]().catch((err) => { console.error(err.message); process.exit(1); });
