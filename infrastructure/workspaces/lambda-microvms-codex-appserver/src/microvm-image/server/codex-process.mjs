// Manages the `codex app-server` child process and its JSON-RPC traffic.
//
// ASSUMPTION (not independently verified against the Codex CLI source in
// this session): codex app-server's stdio transport frames JSON-RPC 2.0
// messages as newline-delimited JSON (one message per line), which is the
// common convention for simple CLI JSON-RPC tools. If the real
// implementation instead uses Content-Length-prefixed framing (LSP-style),
// `readline`-based parsing below will need to change accordingly.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class CodexProcess extends EventEmitter {
  #child;
  #pending = new Map();
  #nextId = 1;

  /** @param {Record<string,string>} env */
  start(env) {
    this.#child = spawn('npx', ['codex', 'app-server'], {
      cwd: '/opt/codex-app-server',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.#child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal });
    });

    this.#child.stderr.on('data', (chunk) => {
      this.emit('stderr', chunk.toString('utf8'));
    });

    const rl = createInterface({ input: this.#child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Not a JSON-RPC line (stray log output); surface it verbatim so
        // the event handler can still persist it for debugging.
        this.emit('line', { raw: line });
        return;
      }
      this.emit('line', message);
      if (message && typeof message.id !== 'undefined' && this.#pending.has(message.id)) {
        const { resolve } = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        resolve(message);
      }
    });
  }

  get isAlive() {
    return Boolean(this.#child) && this.#child.exitCode === null && this.#child.signalCode === null;
  }

  /**
   * Sends a JSON-RPC request/notification to codex app-server's stdin.
   * If `payload.method` is set and no `id` is given, one is generated and
   * the returned promise resolves with the matching response (or rejects
   * after `timeoutMs`). Pass an explicit `id: undefined` intent via a
   * notification-shaped payload (no `id` key at all is not distinguishable
   * here, so callers that want fire-and-forget should call `notify`
   * instead).
   */
  request(payload, timeoutMs = 30_000) {
    const id = payload.id ?? this.#nextId++;
    const message = { jsonrpc: '2.0', ...payload, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for codex app-server response to id=${id}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(payload) {
    const message = { jsonrpc: '2.0', ...payload };
    delete message.id;
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  terminate() {
    this.#child?.kill('SIGTERM');
  }
}
