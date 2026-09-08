import app from './app';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
app.listen(PORT);

/**
 * Placeholder handler.
 *
 * The Lambda Web Adapter layer starts the Express server above (module side
 * effect) and proxies every API Gateway request straight to it over HTTP, so
 * the runtime never actually calls this function. It exists only to satisfy the
 * configured `handler` name.
 */
export const handler = async (): Promise<never> => {
  throw new Error('unreachable: requests are served by the Express app via the Lambda Web Adapter');
};
