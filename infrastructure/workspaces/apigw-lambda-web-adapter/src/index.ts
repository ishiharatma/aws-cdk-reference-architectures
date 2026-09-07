import app from './app';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
app.listen(PORT);

export const handler = async () => {};
