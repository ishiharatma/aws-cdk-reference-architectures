import app from './app';

// The platform already emits every console.* line as structured JSON with
// timestamp/level/requestId, so log plain messages instead of JSON strings.
// Lambda Web Functions runtime contract: bind exactly the host:port advertised
// in AWS_LAMBDA_HTTP_ENDPOINT (the runtime probes it for readiness). There is
// no handler export and no adapter. Locally the fallback makes `npm start` work.
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? '0.0.0.0:8080').split(':');

const server = app.listen(Number(port), host, () => {
  console.log('listening', { host, port });
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server');
  server.close(() => process.exit(0));
});
