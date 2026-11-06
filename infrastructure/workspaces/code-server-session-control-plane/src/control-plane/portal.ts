import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomBytes } from 'node:crypto';

const REGION = process.env.AWS_REGION ?? '';
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID ?? '';

/**
 * The browser UI of the control plane: sign in with Cognito, start or pick a MicroVM session, open it.
 * The ID token stays in a script variable and is gone on reload. API calls stay same-origin through
 * the distribution's /__cp behavior, so the browser needs no CORS configuration.
 */
const script = `
const cognito = 'https://cognito-idp.${REGION}.amazonaws.com/';
const clientId = '${CLIENT_ID}';
let idToken;
const $ = (id) => document.getElementById(id);
const show = (text) => { $('message').textContent = text; };

async function api(method, path, body) {
  const res = await fetch('/__cp' + path, {
    method,
    headers: { authorization: 'Bearer ' + idToken, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || res.status);
  return data;
}

async function refresh() {
  const { sessions } = await api('GET', '/sessions');
  const list = $('sessions');
  list.replaceChildren();
  for (const s of sessions.filter((x) => x.compute === 'microvm')) {
    const row = document.createElement('li');
    row.textContent = s.sessionId.slice(0, 8) + ' ' + s.state + ' ';
    const open = document.createElement('button');
    open.textContent = 'Open';
    open.onclick = () => openSession(s.sessionId).catch((e) => show(e.message));
    const end = document.createElement('button');
    end.textContent = 'End';
    end.onclick = () => api('DELETE', '/sessions/' + s.sessionId).then(refresh).catch((e) => show(e.message));
    row.append(open, ' ', end);
    list.append(row);
  }
}

async function openSession(id) {
  show('Waiting for the MicroVM...');
  for (let i = 0; i < 60; i++) {
    const { state } = await api('GET', '/sessions/' + id);
    if (state === 'RUNNING' || state === 'SUSPENDED') {
      const { url } = await api('POST', '/sessions/' + id + '/access', { type: 'browser' });
      location.assign(url);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('The MicroVM did not start in time');
}

async function cognitoCall(target, body) {
  const res = await fetch(cognito, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.' + target },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Sign-in failed');
  return data;
}

async function signedIn(result) {
  idToken = result.IdToken;
  $('password').value = '';
  $('code').value = '';
  $('login').hidden = true;
  $('mfa').hidden = true;
  $('app').hidden = false;
  show('');
  await refresh();
}

// What Cognito asks for next: enrolling an authenticator app, or a code from one already enrolled.
let challenge;
async function handleChallenge(data) {
  if (data.AuthenticationResult) return signedIn(data.AuthenticationResult);
  challenge = { name: data.ChallengeName, session: data.Session, username: $('username').value };
  if (data.ChallengeName === 'MFA_SETUP') {
    const { SecretCode, Session } = await cognitoCall('AssociateSoftwareToken', { Session: data.Session });
    challenge.session = Session;
    $('setup-secret').textContent = SecretCode;
    $('setup').hidden = false;
  } else if (data.ChallengeName === 'SOFTWARE_TOKEN_MFA') {
    $('setup').hidden = true;
  } else {
    throw new Error('Unsupported sign-in step: ' + data.ChallengeName);
  }
  $('login').hidden = true;
  $('mfa').hidden = false;
  show('');
}

$('login').onsubmit = async (event) => {
  event.preventDefault();
  try {
    await handleChallenge(await cognitoCall('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: { USERNAME: $('username').value, PASSWORD: $('password').value },
    }));
  } catch (e) { show(e.message); }
};

$('mfa').onsubmit = async (event) => {
  event.preventDefault();
  const code = $('code').value.trim();
  try {
    if (challenge.name === 'MFA_SETUP') {
      const verified = await cognitoCall('VerifySoftwareToken', { Session: challenge.session, UserCode: code, FriendlyDeviceName: 'authenticator' });
      if (verified.Status !== 'SUCCESS') throw new Error('The code was not accepted');
      await handleChallenge(await cognitoCall('RespondToAuthChallenge', {
        ChallengeName: 'MFA_SETUP', ClientId: clientId, Session: verified.Session, ChallengeResponses: { USERNAME: challenge.username },
      }));
    } else {
      await handleChallenge(await cognitoCall('RespondToAuthChallenge', {
        ChallengeName: 'SOFTWARE_TOKEN_MFA', ClientId: clientId, Session: challenge.session,
        ChallengeResponses: { USERNAME: challenge.username, SOFTWARE_TOKEN_MFA_CODE: code },
      }));
    }
  } catch (e) { show(e.message); }
};

$('start').onclick = async () => {
  try {
    const { sessionId } = await api('POST', '/sessions', { compute: 'microvm' });
    await refresh();
    await openSession(sessionId);
  } catch (e) { show(e.message); }
};
`;

const page = (nonce: string): string => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>code-server sessions</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}input,button{font:inherit;padding:.4rem .6rem}input{display:block;width:100%;box-sizing:border-box;margin:.25rem 0 .75rem}li{margin:.5rem 0}#message{color:#b00020;min-height:1.5rem}code{word-break:break-all;font-size:1rem}</style></head>
<body>
<h1>code-server sessions</h1>
<p id="message" role="status"></p>
<form id="login">
<label for="username">Email</label><input id="username" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required>
<button>Sign in</button>
</form>
<form id="mfa" hidden>
<div id="setup" hidden>
<p>Add this key to your authenticator app as a time-based account, then enter the code it shows.</p>
<p><code id="setup-secret"></code></p>
</div>
<label for="code">Authenticator code</label><input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required>
<button>Continue</button>
</form>
<div id="app" hidden>
<button id="start">Start a new session</button>
<ul id="sessions"></ul>
</div>
<script nonce="${nonce}">${script}</script>
</body></html>`;

/**
 * GET /portal (no authorizer: the page holds no data, every call it makes needs the ID token)
 */
export async function handler(): Promise<APIGatewayProxyResultV2> {
  const nonce = randomBytes(16).toString('base64');
  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self' https://cognito-idp.${REGION}.amazonaws.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'x-content-type-options': 'nosniff',
    },
    body: page(nonce),
  };
}
