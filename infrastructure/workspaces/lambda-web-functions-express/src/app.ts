import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import todosRouter from './routes/todos';
import debugRouter from './routes/debug';

const app = express();

// No AWS layer sets security headers in front of a Web Function, so the app does.
app.use(helmet());
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/todos', todosRouter);
if (process.env.ENABLE_DEBUG_ROUTES === 'true') {
  app.use('/debug', debugRouter);
}

app.use((_req: Request, res: Response) => {
  res.status(404).json({ message: 'Not found' });
});

app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ message: 'Malformed JSON body' });
    return;
  }
  console.error('unhandled error', { name: err.name, message: err.message });
  res.status(err.status ?? 500).json({ message: 'Internal server error' });
});

export default app;
