#!/usr/bin/env node
/**
 * sse-check.mjs
 *
 * Reads GET /debug/stream and decides whether the stream completed or was cut short.
 * A stream truncated by the revision's timeoutSeconds still ends with HTTP 200 and a
 * clean end of body, so the client treats "no `event: done`" as truncation.
 *
 * Usage:
 *   node scripts/measure/sse-check.mjs <base-url> [count] [intervalMs]
 *   node scripts/measure/sse-check.mjs https://dxxxx.cloudfront.net 40 1000
 *
 * Exit code: 0 = completed, 2 = truncated, 1 = transport error.
 */
const [baseUrl, count = '10', intervalMs = '500'] = process.argv.slice(2);
if (!baseUrl) {
  console.error('usage: sse-check.mjs <base-url> [count] [intervalMs]');
  process.exit(1);
}

// Monotonic clock: the wall clock can jump (observed under WSL) and corrupt durations.
const started = performance.now();
const elapsed = () => ((performance.now() - started) / 1000).toFixed(2);

const res = await fetch(`${baseUrl}/debug/stream?count=${count}&intervalMs=${intervalMs}`, {
  headers: { accept: 'text/event-stream' },
});

let lastId = 0;
let done = false;
let buffer = '';
const decoder = new TextDecoder();

// Minimal SSE parser: events are separated by a blank line.
const handleEvent = (block) => {
  const fields = Object.fromEntries(
    block.split('\n').map((line) => {
      const i = line.indexOf(':');
      return [line.slice(0, i), line.slice(i + 1).trim()];
    }),
  );
  if (fields.event === 'done') {
    done = true;
  } else if (fields.id) {
    lastId = Number(fields.id);
  }
};

try {
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      handleEvent(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
    }
  }
} catch (err) {
  console.log(JSON.stringify({ status: res.status, result: 'error', error: err.message, lastId, seconds: elapsed() }));
  process.exit(1);
}

const result = done ? 'completed' : 'truncated';
console.log(
  JSON.stringify({ status: res.status, result, expected: Number(count), received: lastId, seconds: elapsed() }),
);
process.exit(done ? 0 : 2);
