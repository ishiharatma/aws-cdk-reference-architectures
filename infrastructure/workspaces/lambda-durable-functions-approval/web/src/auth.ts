import type { AppConfig } from './config';
import { lang } from './i18n';

/** Claims of the Cognito ID token the UI uses. */
export interface IdClaims {
  readonly sub: string;
  readonly email?: string;
  readonly exp: number;
  readonly 'cognito:groups'?: string[];
}

export interface Session {
  readonly idToken: string;
  readonly refreshToken?: string;
  readonly claims: IdClaims;
}

const SESSION_KEY = 'ldf-demo-session';
const PKCE_KEY = 'ldf-demo-pkce';

const redirectUri = (): string => `${window.location.origin}/`;

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function decodeClaims(idToken: string): IdClaims {
  const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const json = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
  return JSON.parse(json) as IdClaims;
}

/** Start the authorization code flow with PKCE on the Cognito managed login page. */
export async function signIn(config: AppConfig): Promise<void> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = base64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  );
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
  const url = new URL(`https://${config.cognitoDomain}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.userPoolClientId,
    redirect_uri: redirectUri(),
    scope: 'openid email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Managed login pages are localized by this parameter, not by the browser language.
    lang,
  }).toString();
  window.location.assign(url.toString());
}

export function signOut(config: AppConfig): void {
  sessionStorage.removeItem(SESSION_KEY);
  const url = new URL(`https://${config.cognitoDomain}/logout`);
  url.search = new URLSearchParams({
    client_id: config.userPoolClientId,
    logout_uri: redirectUri(),
  }).toString();
  window.location.assign(url.toString());
}

async function tokenRequest(
  config: AppConfig,
  params: Record<string, string>
): Promise<{ id_token: string; refresh_token?: string }> {
  const res = await fetch(`https://${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.userPoolClientId, ...params }),
  });
  if (!res.ok) throw new Error(`token endpoint: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as { id_token: string; refresh_token?: string };
}

function store(idToken: string, refreshToken?: string): Session {
  const session: Session = { idToken, refreshToken, claims: decodeClaims(idToken) };
  // sessionStorage: the tokens disappear with the tab and are not shared with other tabs.
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ idToken, refreshToken }));
  return session;
}

/**
 * Return the signed-in session: completes a redirect from the login page, reuses a stored
 * token, or refreshes an expired one. Returns undefined when the user must sign in.
 */
export async function currentSession(config: AppConfig): Promise<Session | undefined> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code) {
    const pkce = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? '{}') as {
      verifier?: string;
      state?: string;
    };
    sessionStorage.removeItem(PKCE_KEY);
    window.history.replaceState({}, '', redirectUri());
    if (!pkce.verifier || pkce.state !== params.get('state')) {
      throw new Error('Sign-in state mismatch. Please sign in again.');
    }
    const tokens = await tokenRequest(config, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: pkce.verifier,
    });
    return store(tokens.id_token, tokens.refresh_token);
  }

  const saved = sessionStorage.getItem(SESSION_KEY);
  if (!saved) return undefined;
  const { idToken, refreshToken } = JSON.parse(saved) as { idToken: string; refreshToken?: string };
  if (decodeClaims(idToken).exp * 1000 > Date.now() + 60_000) return store(idToken, refreshToken);
  if (!refreshToken) return undefined;
  try {
    const tokens = await tokenRequest(config, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    return store(tokens.id_token, refreshToken);
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return undefined;
  }
}
