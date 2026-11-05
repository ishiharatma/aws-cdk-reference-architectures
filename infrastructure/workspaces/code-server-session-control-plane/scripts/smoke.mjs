#!/usr/bin/env node
// Operational check: `cdk deploy` cannot prove a browser reaches code-server, including the WebSocket
// that VS Code depends on. This starts a real session, exercises one access path and ends the session.
//
//   export CS_API_URL=... CS_CLIENT_ID=... CS_USERNAME=... CS_PASSWORD=...
//   node smoke.mjs relay                    # MicroVM through the local relay
//   CS_DOMAIN=<DistributionDomainName> node smoke.mjs browser   # MicroVM through CloudFront + Lambda@Edge
//   node smoke.mjs tunnel                   # EC2 through a Session Manager port forward (needs session-manager-plugin)
import { spawn } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
const LOCAL_PORT = Number(process.env.CS_LOCAL_PORT ?? '18443');
const SESSION_CLI = fileURLToPath(new URL('session.mjs', import.meta.url));
const apiUrl = (process.env.CS_API_URL ?? '').replace(/\/$/, '');
const region = new URL(apiUrl).hostname.split('.')[2];

let failed = 0;
const elapsed = (from) => `${((Date.now() - from) / 1000).toFixed(1)}s`;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed += 1;
}

async function signIn() {
  const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: process.env.CS_CLIENT_ID,
      AuthParameters: { USERNAME: process.env.CS_USERNAME, PASSWORD: process.env.CS_PASSWORD },
    }),
  });
  const data = await res.json();
  if (!data.AuthenticationResult) throw new Error(`Sign-in failed: ${data.message ?? data.ChallengeName}`);
  return data.AuthenticationResult.IdToken;
}

// Sends one WebSocket handshake over a raw socket and returns the status code.
function handshake({ host, port, secure, origin, cookie }) {
  return new Promise((resolve) => {
    const connect = secure
      ? (cb) => tls.connect({ host, port, servername: host, ALPNProtocols: ['http/1.1'] }, cb)
      : (cb) => net.connect(port, host, cb);
    const socket = connect(() => {
      const lines = [
        'GET /?reconnectionToken=00000000-0000-4000-8000-000000000000&reconnection=false&skipWebSocketFrames=false HTTP/1.1',
        `Host: ${secure ? host : `localhost:${port}`}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        `Origin: ${origin}`,
        ...(cookie ? [`Cookie: ${cookie}`] : []),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    const finish = (code) => { socket.destroy(); resolve(code); };
    socket.once('data', (chunk) => finish(Number(/^HTTP\/1\.1 (\d+)/.exec(chunk.toString())?.[1] ?? 0)));
    socket.once('error', () => finish(0));
    socket.setTimeout(15_000, () => finish(0));
  });
}

async function waitForHealth(base, headers, timeoutMs) {
  const from = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`, { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      if (res.status === 200) return { ok: true, took: elapsed(from) };
    } catch { /* not listening yet */ }
    if (Date.now() - from > timeoutMs) return { ok: false, took: elapsed(from) };
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// code-server answers / with a redirect to /?folder=<workspace>; follow it by hand to keep the cookie.
async function fetchPage(url, headers) {
  const first = await fetch(url, { headers, redirect: 'manual' });
  if (first.status !== 302) return first;
  return fetch(new URL(first.headers.get('location'), url), { headers, redirect: 'manual' });
}

async function main() {
  if (!['relay', 'browser', 'tunnel'].includes(mode)) throw new Error('Usage: smoke.mjs relay|browser|tunnel');

  const domain = process.env.CS_DOMAIN;
  if (mode === 'browser' && !domain) throw new Error('CS_DOMAIN is required for browser mode');
  // browser mode drives the API through the distribution, as the portal does.
  const api = mode === 'browser' ? `https://${domain}/__cp` : apiUrl;
  const token = await signIn();
  const call = (method, path, body) => fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  const unauthorized = await fetch(`${api}/sessions`);
  check('the API rejects a call without a token', unauthorized.status === 401, `status ${unauthorized.status}`);

  const compute = mode === 'tunnel' ? 'ec2' : 'microvm';
  const from = Date.now();
  const created = await call('POST', '/sessions', { compute });
  const session = await created.json();
  check('POST /sessions', created.status === 201, `status ${created.status} ${session.message ?? ''}`);
  if (created.status !== 201) return;
  const { sessionId } = session;

  let relayProcess;
  try {
    for (;;) {
      const { state } = await (await call('GET', `/sessions/${sessionId}`)).json();
      if (state === 'RUNNING') break;
      if (Date.now() - from > 300_000) throw new Error(`Still ${state} after 5 minutes`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    check('the session reaches RUNNING', true, elapsed(from));

    if (mode === 'browser') {
      const before = await fetch(`https://${domain}/`, { redirect: 'manual' });
      check('without the cookie, / redirects to the portal', before.status === 302 && before.headers.get('location') === '/__cp/portal', `status ${before.status}`);
      const portal = await fetch(`https://${domain}/__cp/portal`);
      check('the portal page loads', portal.status === 200, `status ${portal.status}`);

      const access = await call('POST', `/sessions/${sessionId}/access`, { type: 'browser' });
      const setCookie = access.headers.get('set-cookie') ?? '';
      check('the access route sets an HttpOnly, Secure, SameSite=Strict cookie', /HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Strict/.test(setCookie), `${setCookie.split('=')[0]}, ${setCookie.length} bytes`);
      const cookie = setCookie.split(';')[0];
      const headers = { cookie };

      const health = await waitForHealth(`https://${domain}`, headers, 60_000);
      check('code-server answers through CloudFront', health.ok, health.took);
      const page = await fetchPage(`https://${domain}/`, headers);
      check('the workbench page loads', page.status === 200, `status ${page.status}`);
      const ws = await handshake({ host: domain, port: 443, secure: true, origin: `https://${domain}`, cookie });
      check('the WebSocket upgrades through Lambda@Edge', ws === 101, `status ${ws}`);
      const crossSite = await handshake({ host: domain, port: 443, secure: true, origin: 'https://evil.example.com', cookie });
      check('a WebSocket from another origin is refused', crossSite !== 101, `status ${crossSite}`);
      const anonymous = await handshake({ host: domain, port: 443, secure: true, origin: `https://${domain}` });
      check('a WebSocket without the cookie is refused', anonymous !== 101, `status ${anonymous}`);
    } else {
      relayProcess = spawn('node', [SESSION_CLI, 'connect', '--session', sessionId, '--port', String(LOCAL_PORT)], { stdio: 'inherit', env: process.env });
      const health = await waitForHealth(`http://127.0.0.1:${LOCAL_PORT}`, {}, mode === 'tunnel' ? 600_000 : 60_000);
      check(`code-server answers on localhost:${LOCAL_PORT}`, health.ok, health.took);
      const page = await fetchPage(`http://127.0.0.1:${LOCAL_PORT}/`, {});
      check('the workbench page loads', page.status === 200, `status ${page.status}`);
      const ws = await handshake({ host: '127.0.0.1', port: LOCAL_PORT, secure: false, origin: `http://localhost:${LOCAL_PORT}` });
      check('the WebSocket upgrades', ws === 101, `status ${ws}`);
      const crossSite = await handshake({ host: '127.0.0.1', port: LOCAL_PORT, secure: false, origin: 'https://evil.example.com' });
      check('a WebSocket from another origin is refused', crossSite !== 101, `status ${crossSite}`);
    }
  } finally {
    relayProcess?.kill('SIGTERM');
    const ended = await call('DELETE', `/sessions/${sessionId}`);
    check('DELETE /sessions/{id}', ended.status === 202, `status ${ended.status}`);
  }
}

main()
  .catch((err) => { console.error(err.message); failed += 1; })
  .finally(() => process.exit(failed ? 1 : 0));
