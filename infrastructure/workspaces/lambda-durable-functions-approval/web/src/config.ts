/** Runtime settings written to /config.json by the stack at deploy time. */
export interface AppConfig {
  readonly region: string;
  readonly apiUrl: string;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly identityPoolId: string;
  /** Cognito managed login domain, without scheme (xxx.auth.<region>.amazoncognito.com). */
  readonly cognitoDomain: string;
  readonly approvalTimeoutMinutes: number;
}

export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config.json: HTTP ${res.status}`);
  return (await res.json()) as AppConfig;
}
