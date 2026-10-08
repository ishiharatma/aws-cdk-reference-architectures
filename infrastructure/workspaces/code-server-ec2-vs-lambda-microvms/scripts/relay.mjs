#!/usr/bin/env node
// Local relay: browsers cannot attach the X-aws-proxy-auth header that every MicroVM endpoint
// requires, so this listens on localhost without auth and forwards HTTP and WebSocket traffic to
// the MicroVM endpoint with a fresh token injected. Host/Origin are rewritten to the endpoint so
// code-server's own origin check accepts the WebSocket handshake.
//
// Usage: node relay.mjs --microvm-id <id> --endpoint <host> [--port 8443] [--profile p] [--region r]
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const microvmId = arg('microvm-id');
const endpoint = (arg('endpoint') ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const listenPort = Number(arg('port', '8443'));
const profile = arg('profile');
const region = arg('region');
if (!microvmId || !endpoint) {
  console.error('--microvm-id and --endpoint are required');
  process.exit(2);
}

const TOKEN_MINUTES = 30;
let token = '';
function refreshToken() {
  const args = ['lambda-microvms', 'create-microvm-auth-token', '--microvm-identifier', microvmId,
    '--expiration-in-minutes', String(TOKEN_MINUTES), '--allowed-ports', '[{"allPorts":{}}]',
    '--query', 'authToken."X-aws-proxy-auth"', '--output', 'text'];
  if (profile) args.push('--profile', profile);
  if (region) args.push('--region', region);
  token = execFileSync('aws', args, { encoding: 'utf8' }).trim();
}
refreshToken();
setInterval(refreshToken, (TOKEN_MINUTES - 5) * 60 * 1000).unref();

const rewrite = (headers) => ({ ...headers, host: endpoint, 'x-aws-proxy-auth': token, ...(headers.origin ? { origin: `https://${endpoint}` } : {}) });

const server = http.createServer((req, res) => {
  const upstream = https.request({ host: endpoint, method: req.method, path: req.url, headers: rewrite(req.headers) }, (up) => {
    // code-server scopes its session cookie to the endpoint host; the browser sees localhost, so
    // drop the Domain attribute (and Secure, which would be refused over plain http).
    const headers = { ...up.headers };
    if (headers['set-cookie']) {
      headers['set-cookie'] = headers['set-cookie'].map((c) => c.replace(/;\s*Domain=[^;]*/i, '').replace(/;\s*Secure/i, ''));
    }
    res.writeHead(up.statusCode ?? 502, headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => { res.writeHead(502); res.end(String(err)); });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = tls.connect({ host: endpoint, port: 443, servername: endpoint, ALPNProtocols: ['http/1.1'] }, () => {
    const headers = rewrite(req.headers);
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(listenPort, '127.0.0.1', () => console.log(`relay: http://localhost:${listenPort}  ->  https://${endpoint}`));
