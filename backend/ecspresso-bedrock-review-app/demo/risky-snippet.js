// Intentionally risky code, for demoing the Agentic Review gate end-to-end.
// Inserted into src/index.js by `node demo/inject-risky-change.js apply` and
// removed by `... revert`. Never meant to run in a real deployment -- see
// demo/README.md. Each block is written to trip a specific review
// perspective (security / infra / quality / cost).

const { exec } = require('child_process');

// [security] Hardcoded credentials committed to source control.
const AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const DB_PASSWORD = 'SuperSecret123!';

// [security] No authentication/authorization check, and unsanitized user
// input passed straight into a shell command (command injection).
app.get('/api/v1/admin/lookup', (req, res) => {
  const { host } = req.query;
  exec(`ping -c 1 ${host}`, (error, stdout, stderr) => {
    res.json({ output: stdout, error: stderr });
  });
});

// [security] SQL built via string concatenation of raw user input (classic
// injection shape), logged verbatim including whatever the caller sent.
app.get('/api/v1/admin/users', (req, res) => {
  const { name } = req.query;
  const query = "SELECT * FROM users WHERE name = '" + name + "' AND active = 1";
  logger.info('Executing query', { query, password: DB_PASSWORD });
  res.json({ success: true, query });
});

// [infra] Swallows every error silently -- no logging, no propagation, no
// distinction between a bad request and a server-side failure.
app.get('/api/v1/risky-operation', (req, res) => {
  try {
    const data = JSON.parse(req.query.payload);
    res.json({ success: true, data });
  } catch (e) {
    // intentionally empty catch block
  }
  res.json({ success: true });
});

// [cost] Synchronously fires thousands of outbound HTTP calls per request,
// one at a time, with no batching, caching, or upper bound.
app.get('/api/v1/expensive-report', async (req, res) => {
  const results = [];
  for (let i = 0; i < 5000; i++) {
    const response = await fetch('https://example.com/api/data?id=' + i);
    results.push(await response.text());
  }
  res.json({ success: true, count: results.length });
});

// [quality] Deeply nested duplicated logic, no error handling, and an
// unreachable branch (duplicate of the first `type === 'a'` condition).
app.get('/api/v1/messy-logic', (req, res) => {
  const { type } = req.query;
  if (type === 'a') {
    if (req.query.sub === 'x') {
      if (req.query.flag === 'true') {
        res.json({ result: 'a-x-true' });
      } else {
        res.json({ result: 'a-x-false' });
      }
    } else {
      res.json({ result: 'a-other' });
    }
  } else if (type === 'a') {
    res.json({ result: 'unreachable' });
  } else {
    res.json({ result: 'default' });
  }
});
