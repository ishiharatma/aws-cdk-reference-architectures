import app from './app';

// Start the HTTP server. On Lambda this is launched by `run.sh` (`exec node
// index.js`) via the Lambda Web Adapter layer's bootstrap; locally it is just
// `npm start`. There is no `handler(event)` export — the adapter proxies raw
// HTTP to this server, it never invokes a Node handler.
const PORT = parseInt(process.env.PORT ?? '8080', 10);
app.listen(PORT);
