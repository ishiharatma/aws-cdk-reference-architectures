// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../../src/edge/router.js');

const ENDPOINT = 'abc123.lambda-microvm.ap-northeast-1.on.aws';

function originRequest(cookie?: string, host = 'd111.cloudfront.net') {
  return {
    Records: [{
      cf: {
        config: { eventType: 'origin-request' },
        request: {
          headers: { host: [{ value: host }], ...(cookie ? { cookie: [{ key: 'Cookie', value: cookie }] } : {}) },
          origin: { custom: { domainName: 'api.example.com', path: '/dev', port: 443, protocol: 'https' } },
        },
      },
    }],
  };
}

describe('origin-request', () => {
  test('moves the cookie to the origin and header, and hides it from code-server', async () => {
    const result = await handler(originRequest(`vscode-tkn=keep; __Host-mvm=${ENDPOINT}~tok.en-_1`));
    expect(result.origin.custom.domainName).toBe(ENDPOINT);
    expect(result.origin.custom.path).toBe('');
    expect(result.headers.host[0].value).toBe(ENDPOINT);
    expect(result.headers['x-aws-proxy-auth'][0].value).toBe('tok.en-_1');
    expect(result.headers['x-forwarded-host'][0].value).toBe('d111.cloudfront.net');
    expect(result.headers.cookie[0].value).toBe('vscode-tkn=keep');
  });

  test('drops the cookie header when nothing else remains', async () => {
    const result = await handler(originRequest(`__Host-mvm=${ENDPOINT}~tok`));
    expect(result.headers.cookie).toBeUndefined();
  });

  test.each([
    ['no cookie', undefined],
    ['no token', `__Host-mvm=${ENDPOINT}~`],
    ['no separator', `__Host-mvm=${ENDPOINT}`],
    ['a host outside the MicroVM domain', '__Host-mvm=evil.example.com~tok'],
    ['a suffix trick', `__Host-mvm=${ENDPOINT}.evil.example.com~tok`],
    ['a metadata address', '__Host-mvm=169.254.169.254~tok'],
  ])('redirects to the portal with %s', async (_name, cookie) => {
    const result = await handler(originRequest(cookie));
    expect(result.status).toBe('302');
    expect(result.headers.location[0].value).toBe('/__cp/portal');
  });
});

describe('origin-response', () => {
  const event = (status: string, headers: object, mode: string) => ({
    Records: [{
      cf: {
        config: { eventType: 'origin-response' },
        request: { headers: { 'sec-fetch-mode': [{ value: mode }] } },
        response: { status, headers },
      },
    }],
  });

  test('sends a page load back to the portal when the MicroVM proxy rejects it', async () => {
    const result = await handler(event('502', { 'x-aws-proxy-error': [{ value: 'MICROVM_CONNECT_FAILED' }] }, 'navigate'));
    expect(result.status).toBe('302');
  });

  test('leaves background requests and code-server responses alone', async () => {
    expect((await handler(event('403', {}, 'cors'))).status).toBe('403');
    expect((await handler(event('200', {}, 'navigate'))).status).toBe('200');
  });
});
