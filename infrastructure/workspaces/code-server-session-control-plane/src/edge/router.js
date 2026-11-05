'use strict';
// Lambda@Edge on the default behavior: lets a browser reach a token-authenticated MicroVM endpoint.
//
// The browser holds one HttpOnly cookie, issued by the control plane to the session owner only:
//   __Host-mvm=<endpoint host>~<JWE token>
// On origin-request this moves it to where the endpoint expects it (origin + X-aws-proxy-auth). The
// function keeps no state and no secret: a forged cookie only reaches MicroVM endpoints, with
// whatever token the caller already holds.

const COOKIE_NAME = '__Host-mvm';
const PORTAL_PATH = '/__cp/portal';
const ENDPOINT_PATTERN = /^[a-z0-9-]+\.lambda-microvm\.[a-z0-9-]+\.on\.aws$/;

function parseCookie(headers) {
  const kept = [];
  let value;
  for (const { value: line } of headers.cookie ?? []) {
    for (const part of line.split(';')) {
      const pair = part.trim();
      if (pair.startsWith(`${COOKIE_NAME}=`)) value = pair.slice(COOKIE_NAME.length + 1);
      else if (pair) kept.push(pair);
    }
  }
  return { value, kept };
}

function redirectToPortal() {
  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{ key: 'Location', value: PORTAL_PATH }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'set-cookie': [{ key: 'Set-Cookie', value: `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` }],
    },
  };
}

function onOriginRequest(request) {
  const { value, kept } = parseCookie(request.headers);
  const separator = value ? value.indexOf('~') : -1;
  const endpoint = separator > 0 ? value.slice(0, separator) : '';
  const token = separator > 0 ? value.slice(separator + 1) : '';
  if (!ENDPOINT_PATTERN.test(endpoint) || !token) return redirectToPortal();

  // code-server compares Origin with the forwarded host. Passing the viewer's host keeps that
  // check meaningful instead of rewriting Origin to match the endpoint.
  const viewerHost = request.headers.host?.[0]?.value;
  if (viewerHost) request.headers['x-forwarded-host'] = [{ key: 'X-Forwarded-Host', value: viewerHost }];

  request.origin.custom.domainName = endpoint;
  request.origin.custom.port = 443;
  request.origin.custom.protocol = 'https';
  // The placeholder origin carries the API stage as its path; a MicroVM would answer it with 404.
  request.origin.custom.path = '';
  request.headers.host = [{ key: 'Host', value: endpoint }];
  request.headers['x-aws-proxy-auth'] = [{ key: 'X-aws-proxy-auth', value: token }];
  if (kept.length > 0) request.headers.cookie = [{ key: 'Cookie', value: kept.join('; ') }];
  else delete request.headers.cookie;
  return request;
}

// An expired token or a gone MicroVM is answered by the MicroVM proxy, not by code-server. Send a
// page load back to the portal; leave background requests alone so VS Code shows its own reconnect UI.
function onOriginResponse(request, response) {
  const fromProxy = Boolean(response.headers['x-aws-proxy-error']) || response.status === '401' || response.status === '403';
  const navigation = request.headers['sec-fetch-mode']?.[0]?.value === 'navigate';
  return fromProxy && navigation ? redirectToPortal() : response;
}

exports.handler = async (event) => {
  const { config, request, response } = event.Records[0].cf;
  return config.eventType === 'origin-response' ? onOriginResponse(request, response) : onOriginRequest(request);
};
