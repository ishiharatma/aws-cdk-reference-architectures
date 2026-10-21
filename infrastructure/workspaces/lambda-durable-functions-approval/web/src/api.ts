import { Sha256 } from '@aws-crypto/sha256-js';
import { CognitoIdentityClient } from '@aws-sdk/client-cognito-identity';
import {
  fromCognitoIdentityPool,
  type CognitoIdentityCredentials,
} from '@aws-sdk/credential-provider-cognito-identity';
import { SignatureV4 } from '@smithy/signature-v4';
import type { Session } from './auth';
import type { AppConfig } from './config';

/** Request as returned by the API (the callback ID is never included). */
export interface RequestView {
  readonly requestId: string;
  readonly title: string;
  readonly amount: number;
  readonly requester: string;
  readonly status:
    'SUBMITTED' | 'WAITING_APPROVAL' | 'DECISION_RECEIVED' | 'COMPLETED' | 'REJECTED' | 'EXPIRED';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decision?: { approved: boolean; approver: string; comment?: string };
  readonly fulfillmentId?: string;
}

export interface ApiResult<T = unknown> {
  readonly status: number;
  readonly body: T;
}

/**
 * Calls the IAM-authorized API with SigV4. The temporary credentials come from the Cognito
 * identity pool, which maps the user's group to the requester or approver IAM role.
 */
export class ApprovalApi {
  private readonly signer: SignatureV4;
  private readonly provider: ReturnType<typeof fromCognitoIdentityPool>;
  private cached?: CognitoIdentityCredentials;
  private readonly base: URL;

  constructor(config: AppConfig, session: Session) {
    this.base = new URL(config.apiUrl);
    this.provider = fromCognitoIdentityPool({
      client: new CognitoIdentityClient({ region: config.region }),
      identityPoolId: config.identityPoolId,
      logins: {
        [`cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`]: session.idToken,
      },
    });
    this.signer = new SignatureV4({
      service: 'execute-api',
      region: config.region,
      credentials: this.credentials,
      sha256: Sha256,
    });
  }

  /**
   * The provider calls GetId + GetCredentialsForIdentity on every invocation, and the signer
   * asks for credentials on every request, so reuse them until shortly before they expire.
   */
  private readonly credentials = async (): Promise<CognitoIdentityCredentials> => {
    const expiresAt = this.cached?.expiration?.getTime() ?? 0;
    if (!this.cached || expiresAt - Date.now() < 5 * 60_000) {
      this.cached = await this.provider();
    }
    return this.cached;
  };

  /** The Cognito identity ID; the API records it as requester / approver. */
  async identityId(): Promise<string> {
    return (await this.credentials()).identityId;
  }

  async send<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<ApiResult<T>> {
    const url = new URL(path.replace(/^\//, ''), this.base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const signed = await this.signer.sign({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: {
        host: url.hostname,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: payload,
    });
    // The browser sets Host itself and refuses a script-provided one.
    const { host: _host, ...signedHeaders } = signed.headers;
    const res = await fetch(url, { method, headers: signedHeaders, body: payload });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Keep the raw text (e.g. an HTML error page).
    }
    return { status: res.status, body: parsed as T };
  }
}
