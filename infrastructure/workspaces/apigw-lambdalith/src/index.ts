import { serve } from '@hono/node-server';
import app from './app';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Listening on http://localhost:${info.port}`);
});
