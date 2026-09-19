// The single HTTP server running inside every codex app-server MicroVM.
//
// As of this reference's authoring, AWS Lambda MicroVMs has no built-in way
// to "log into" a running MicroVM, execute a command, and stream the
// response back to a caller. So this server plays that role itself: the
// platform calls its lifecycle hook endpoints (/ready, /run, /suspend,
// /resume, /terminate) over HTTP, and external clients (through the
// MicroVM's own dedicated HTTPS endpoint, authenticated with the
// short-lived X-aws-proxy-auth token from CreateMicrovmAuthToken) call
// /rpc to talk to the codex app-server child process this server manages.
//
// Every line codex app-server writes to stdout is captured by the
// EventHandler and persisted to DynamoDB, so Thread/Turn content survives
// the MicroVM being SUSPENDED or terminated -- the control plane's
// get-events Lambda polls that table independently of this server's or the
// MicroVM's own lifecycle.
import { createServer } from 'node:http';
import { CodexProcess } from './codex-process.mjs';
import { EventHandler } from './event-handler.mjs';
import { resolveOpenAiApiKey } from './secret.mjs';

const port = Number(process.env.CODEX_APP_SERVER_PORT ?? '8080');
const eventHandler = new EventHandler(process.env.EVENTS_TABLE_NAME ?? '');
const codex = new CodexProcess();

let ready = false;

codex.on('line', (message) => {
  void eventHandler.record(message);
});
codex.on('stderr', (text) => {
  console.error('[codex app-server]', text.trimEnd());
});
codex.on('exit', ({ code, signal }) => {
  ready = false;
  console.error(`[codex-process] exited (code=${code}, signal=${signal})`);
});

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');

    // --- Platform lifecycle hooks (see Hooks.microvmHooks / microvmImageHooks
    //     in lib/stacks/lambda-microvms-codex-appserver-stack.ts) ---
    if (pathname === '/ready' || pathname === '/validate') {
      return sendJson(res, ready && codex.isAlive ? 200 : 503, { ready: ready && codex.isAlive });
    }

    if (pathname === '/run' && req.method === 'POST') {
      const body = (await readJsonBody(req)) ?? {};
      if (body.sessionId) {
        eventHandler.setSessionId(body.sessionId);
      }
      return sendJson(res, 200, { started: true });
    }

    if (pathname === '/suspend' && req.method === 'POST') {
      console.log('[hooks] suspend');
      return sendJson(res, 200, {});
    }

    if (pathname === '/resume' && req.method === 'POST') {
      console.log('[hooks] resume');
      return sendJson(res, 200, {});
    }

    if (pathname === '/terminate' && req.method === 'POST') {
      console.log('[hooks] terminate');
      codex.terminate();
      return sendJson(res, 200, {});
    }

    // --- Application API: a thin, generic JSON-RPC relay to codex
    //     app-server. Deliberately generic (no hardcoded Thread/Turn/Item
    //     method or param names) rather than a typed /threads REST shape,
    //     since this reference could not independently verify codex
    //     app-server's exact method/param schema against the Codex CLI
    //     source in this session. The caller sends a raw JSON-RPC 2.0
    //     request body; see the OpenAI Codex CLI documentation
    //     (https://github.com/openai/codex) for the actual
    //     initialize/thread/turn/item method names to send. ---
    if (pathname === '/rpc' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body.method !== 'string') {
        return sendJson(res, 400, { error: 'Request body must be a JSON-RPC object with a "method"' });
      }
      if (typeof body.id === 'undefined') {
        codex.notify(body);
        return sendJson(res, 202, {});
      }
      const response = await codex.request(body);
      return sendJson(res, 200, response);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[server] request handling failed', err);
    return sendJson(res, 500, { error: 'Internal error' });
  }
});

async function main() {
  const apiKey = await resolveOpenAiApiKey();
  codex.start({
    ...process.env,
    ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
  });
  ready = true;

  server.listen(port, () => {
    console.log(`[server] listening on :${port}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal startup error', err);
  process.exit(1);
});
