import express from 'express';
import todosRouter from './routes/todos';

const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/todos', todosRouter);

export default app;
