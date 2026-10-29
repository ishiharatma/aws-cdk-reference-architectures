import request from 'supertest';

// The DynamoDB client is replaced so the Express app can be tested in-process.
const send = jest.fn();
jest.mock('src/utils/dynamodb', () => ({ docClient: { send }, TABLE_NAME: 'test-table' }));

process.env.ENABLE_DEBUG_ROUTES = 'true';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const app = require('src/app').default;

describe('Express app (runs unchanged on Web Functions)', () => {
  beforeEach(() => send.mockReset());

  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('helmet sets security headers (no AWS layer does it for a Web Function)', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('POST /todos creates an item', async () => {
    send.mockResolvedValueOnce({});
    const res = await request(app).post('/todos').send({ title: 'write tests' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: 'write tests', completed: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{}, 'title is required'],
    [{ title: '' }, 'title must be'],
    [{ title: 'x'.repeat(201) }, 'title must be'],
    [{ title: 'ok', completed: 'yes' }, 'completed must be a boolean'],
  ])('POST /todos rejects %j', async (body, message) => {
    const res = await request(app).post('/todos').send(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain(message);
    expect(send).not.toHaveBeenCalled();
  });

  test('malformed JSON returns 400, not 500', async () => {
    const res = await request(app).post('/todos').set('Content-Type', 'application/json').send('{"title":');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Malformed JSON body');
  });

  test('GET /todos/:id returns 404 when missing', async () => {
    send.mockResolvedValueOnce({});
    const res = await request(app).get('/todos/missing');
    expect(res.status).toBe(404);
  });

  test('PUT /todos/:id returns 404 when the item does not exist', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' }));
    const res = await request(app).put('/todos/missing').send({ title: 'x' });
    expect(res.status).toBe(404);
  });

  test('DynamoDB failures become a generic 500', async () => {
    send.mockRejectedValueOnce(new Error('boom'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(app).get('/todos');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'Internal server error' });
  });

  test('unknown routes return JSON 404', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });

  describe('debug routes', () => {
    test('one process serves concurrent requests: inFlight is shared', async () => {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => request(app).get('/debug/sleep').query({ ms: 100 })),
      );
      const ids = new Set(responses.map((r) => r.body.environmentId));
      expect(ids.size).toBe(1);
      expect(Math.max(...responses.map((r) => r.body.maxInFlight))).toBeGreaterThan(1);
    });

    test('sleep and cpu inputs are clamped', async () => {
      const res = await request(app).get('/debug/cpu').query({ ms: 'abc' });
      expect(res.body.burnedMs).toBe(200);
    });

    test('stream emits server-sent events', async () => {
      const res = await request(app).get('/debug/stream').query({ count: 3, intervalMs: 0 });
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.text.match(/^id: /gm)).toHaveLength(3);
    });

    test('stream ends with a terminal done event', async () => {
      const res = await request(app).get('/debug/stream').query({ count: 2, intervalMs: 0 });
      expect(res.text.trimEnd().endsWith('event: done\ndata: {"count":2}')).toBe(true);
    });

    test('background returns 202 before the work finishes', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const res = await request(app).post('/debug/background').query({ delayMs: 50 });
      expect(res.status).toBe(202);
      expect(log).not.toHaveBeenCalledWith('background job finished', expect.anything());
      await new Promise((r) => setTimeout(r, 100));
      expect(log).toHaveBeenCalledWith('background job finished', expect.objectContaining({ delayMs: 50 }));
    });
  });
});
