import { Hono } from 'hono';
import todosRouter from './routes/todos';

const app = new Hono();
app.route('/todos', todosRouter);

export default app;
